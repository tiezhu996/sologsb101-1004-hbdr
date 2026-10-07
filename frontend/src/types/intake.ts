/**
 * 离线包接收区（intake）类型定义
 *
 * 业务背景：巡检甲 / 乙班无网作业，各班各带一份本地数据（离线包），收工后把
 * 病害评定与天窗单交回调度台。离线包先进入「接收区」逐项核准，核准通过后才允许
 * 合并进正式台账。
 *
 * 核心约束（与调度规程一一对应）：
 * - 按「道岔 + 日期 + 部件」对回病害；等级 / 销号 / 作业编排冲突时两份都保留、逐项核准，
 *   禁止用后导入的整条记录覆盖台账记录；
 * - 确认一份包时，病害归属与作业单引用两道闸门同时成立才写入正式台账；
 * - 写入按条目逐项落库并做检查点，失败后从已完成记录之后继续，未确认内容留在接收区；
 * - 多标签同时接收同一包（packageId / 内容哈希相同）只能有一个完成；
 * - 旧备份（无包标识）先出迁移清单核对，再按同一套合并流程应用。
 */
import type { Revisioned } from './persistence';
import type { Yard } from './yard';
import type { Switch } from './switch';
import type { Inspection } from './inspection';
import type { Fault } from './fault';
import type { WorkOrder } from './workOrder';

/** 离线包文件标识（kind 字段），带该标识的才是可直接进入接收区的离线包 */
export const INTAKE_PACKAGE_KIND = 'gbrailswitch-offline-pack';

/** 离线包格式版本 */
export const INTAKE_PACKAGE_VERSION = 1;

/** 条目种类：站场 / 道岔 / 巡检 / 病害 / 天窗作业单 */
export type IntakeItemKind = 'yard' | 'switch' | 'inspection' | 'fault' | 'workOrder';

/**
 * 条目状态：
 * - ready    无冲突、闸门成立，等待整包核准写入
 * - conflict 存在待调度员逐项选择的冲突（等级 / 销号 / 重号 / 编排）
 * - blocked  闸门不成立（病害归属不到道岔，或作业单引用不到病害）
 * - applied  已写入正式台账
 * - skipped  已存在复用 / 调度员核准剔除（不落库）
 * - error    写入失败（恢复时回到 ready 重新尝试）
 */
export type IntakeItemStatus = 'ready' | 'conflict' | 'blocked' | 'applied' | 'skipped' | 'error';

/** 调度员对条目的核准选择 */
export type IntakeDecision = 'undecided' | 'accept' | 'keepBoth' | 'discard';

/** 冲突类型：等级 / 销号状态 / 作业编排（时间窗+人员+机具）/ 作业单重号 / 归属缺失 / 引用断裂 */
export type IntakeConflictType =
  | 'severity'
  | 'solvedState'
  | 'schedule'
  | 'codeDup'
  | 'attrMissing'
  | 'refBroken';

/** 接收区批次状态 */
export type IntakeBatchStatus = 'reviewing' | 'applying' | 'paused' | 'applied' | 'migrate' | 'rejected';

/** 闸门：attribution=病害归属，reference=作业单引用 */
export type IntakeGateKey = 'attribution' | 'reference';

/** 离线包内可携带的任意行 */
export type IntakePayload = Yard | Switch | Inspection | Fault | WorkOrder;

/** 冲突描述（台账一份、离线一份，同时展示供逐项核准） */
export interface IntakeConflict {
  type: IntakeConflictType;
  /** 台账侧摘要 */
  ledgerSummary: string;
  /** 离线侧摘要 */
  incomingSummary: string;
  /** 冲突说明 */
  message: string;
}

/** 闸门校验结果 */
export interface IntakeGate {
  key: IntakeGateKey;
  ok: boolean;
  message: string;
}

/**
 * 接收区条目。一个条目对应离线包里的一条记录；冲突时该条目即「待选冲突」，
 * 台账侧内容放在 conflicts[].ledgerSummary 并排展示，绝不整条覆盖。
 */
export interface IntakeItem {
  /** 接收区内条目 id：`${batchId}:${kind}:${localId}` */
  id: string;
  kind: IntakeItemKind;
  /** 包内原始 id（病害 / 作业单之间的引用在包内用它关联） */
  localId: string;
  /** 顺序号：站场 → 道岔 → 巡检 → 病害 → 作业单，断点续传按此继续 */
  seq: number;
  status: IntakeItemStatus;
  decision: IntakeDecision;
  /** 「台账已存在、内容一致」自动复用的条目锁定为跳过，不允许改判 */
  locked?: boolean;
  conflicts: IntakeConflict[];
  gates: IntakeGate[];
  /** 待写入台账的行（引用 id 在写入时按 idMap 重写） */
  payload: IntakePayload;
  /** 对到的台账行 id（已存在时） */
  ledgerId?: string;
  /** 新行 / 保留两份时预先分配的台账 id（确定性生成，重算计划保持稳定） */
  assignedId?: string;
  /** 作业单保留两份时的改挂编号（如 TW-...-01-甲） */
  assignedCode?: string;
  appliedAt?: string;
  errorMessage?: string;
}

/** 旧备份迁移核对清单项 */
export interface MigrationCheckItem {
  key: string;
  label: string;
  detail: string;
  level: 'ok' | 'warn' | 'danger';
  checked: boolean;
}

/**
 * 接收区批次：一个离线包（或一份待迁移的旧备份）对应一条。
 * 未核准前数据只存在这里，正式台账表不动。
 */
export interface IntakeBatch extends Revisioned {
  id: string;
  /** 离线包标识；多标签接收同一包据此去重 */
  packageId: string;
  /** 包内容哈希：packageId 缺失 / 旧备份时据此识别重复提交 */
  contentHash: string;
  status: IntakeBatchStatus;
  /** pack=带标识离线包；legacy=无包标识旧整库备份 */
  kind: 'pack' | 'legacy';
  /** 班次（甲班 / 乙班）与作业人员 */
  shift: string;
  crew: string;
  source: string;
  note: string;
  exportedAt: string;
  receivedAt: string;
  finishedAt: string | null;
  /** 已写入台账的条目数 */
  appliedCount: number;
  /** 最近一次停下原因（核准拦截 / 写入失败 / 他页占用），页面直接展示 */
  stopReason: string | null;
  items: IntakeItem[];
  /** 病害归属人工改判：包内道岔 localId → 台账道岔 id */
  attributionOverrides: Record<string, string>;
  /** 旧备份迁移核对清单（仅 kind=legacy） */
  migrationChecks: MigrationCheckItem[];
  /** 旧备份原始内容（核对完成、生成计划后清空） */
  rawSnapshot?: unknown;
}

/** 离线包文件结构 */
export interface OfflinePack {
  kind: typeof INTAKE_PACKAGE_KIND;
  packageVersion: number;
  packageId: string;
  /** 导出时的数据结构版本，供接收区核对 */
  schemaVersion: number;
  exportedAt: string;
  shift: string;
  crew: string;
  note: string;
  yards: Yard[];
  switches: Switch[];
  inspections: Inspection[];
  faults: Fault[];
  workOrders: WorkOrder[];
}

/** 合并计划读取的台账快照 */
export interface LedgerSnapshot {
  yards: Yard[];
  switches: Switch[];
  inspections: Inspection[];
  faults: Fault[];
  workOrders: WorkOrder[];
}

/** 接收区条目中文标签 / 状态标签 */
export const INTAKE_ITEM_KIND_LABEL: Record<IntakeItemKind, string> = {
  yard: '站场',
  switch: '道岔',
  inspection: '巡检',
  fault: '病害',
  workOrder: '天窗作业单',
};

export const INTAKE_ITEM_STATUS_LABEL: Record<IntakeItemStatus, string> = {
  ready: '待核准写入',
  conflict: '待选冲突',
  blocked: '闸门不成立',
  applied: '已写入',
  skipped: '已复用 / 已剔除',
  error: '写入失败',
};

export const INTAKE_BATCH_STATUS_LABEL: Record<IntakeBatchStatus, string> = {
  reviewing: '接收区待核准',
  applying: '合并写入中',
  paused: '已中断·可继续',
  applied: '已全部并入',
  migrate: '旧备份待核对',
  rejected: '重复接收已驳回',
};

export const INTAKE_CONFLICT_TYPE_LABEL: Record<IntakeConflictType, string> = {
  severity: '病害等级不一致',
  solvedState: '销号状态不一致',
  schedule: '作业编排冲突（时间窗 / 人员 / 机具）',
  codeDup: '天窗作业单编号重复',
  attrMissing: '病害归属不到道岔',
  refBroken: '作业单引用病害不存在',
};

/** 应用 / 接收过程使用的跨页互斥锁名 */
export const INTAKE_APPLY_LOCK = 'gbrailswitch-intake-apply';
export const INTAKE_RECEIVE_LOCK = 'gbrailswitch-intake-receive';

/** 断点演练用 settings 键：写入第 N 条时中断一次（随即清除） */
export const INTAKE_FAIL_SEQ_SETTING = 'intakeFailSeq';
