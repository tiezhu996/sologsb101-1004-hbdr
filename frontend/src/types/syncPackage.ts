/**
 * 离线包与接收区类型。
 * 巡检甲乙班无网时各带一份本地数据，收工后把病害评定与天窗单交回调度台：
 * 包先落接收区（SyncPackageRow），核准通过才逐条合并进正式台账；
 * 等级 / 销号 / 作业编排冲突保留两份逐项核准，不允许后导入的整条记录直接盖掉台账。
 */
import type { Revisioned } from './persistence';
import type { Inspection } from './inspection';
import type { Fault } from './fault';
import type { WorkOrder } from './workOrder';

/** 离线包文件格式标识 */
export const PACKAGE_FORMAT = 'gbrailswitch-offline-package';

/** 包内道岔目录项：跨设备交回时按 站场+编号 兜底核对病害归属 */
export interface PackageSwitchRef {
  id: string;
  code: string;
  yardId: string;
  yardName: string;
}

/** 离线包载荷：班组离线期间产生的巡检、病害评定与天窗单 */
export interface OfflinePackagePayload {
  inspections: Inspection[];
  faults: Fault[];
  workOrders: WorkOrder[];
  switches: PackageSwitchRef[];
}

/** 离线包文件（导出 / 接收的 JSON） */
export interface OfflinePackageFile extends OfflinePackagePayload {
  format: typeof PACKAGE_FORMAT;
  /** 包标识：接收区去重与断点恢复的主键 */
  packageId: string;
  /** 班组（甲班 / 乙班） */
  crew: string;
  exportedAt: string;
}

/** 接收区包状态机 */
export type PackageStatus =
  | 'received' // 已入接收区，待核准
  | 'applying' // 核准通过，正在合并（中断后保留断点）
  | 'blocked' // 校验不通过或写入失败，停在接收区
  | 'conflicted' // 无冲突记录已应用，待逐项核准冲突
  | 'merged' // 已全部并入正式台账
  | 'rejected'; // 已退回班组，不并入

export const PACKAGE_STATUS_LABEL: Record<PackageStatus, string> = {
  received: '待核准',
  applying: '合并中',
  blocked: '已停下',
  conflicted: '待逐项核准',
  merged: '已合并',
  rejected: '已退回',
};

/** 冲突类别：等级 / 销号 / 作业编排 */
export type ConflictKind = 'severity' | 'solved' | 'schedule';

export const CONFLICT_KIND_LABEL: Record<ConflictKind, string> = {
  severity: '等级',
  solved: '销号',
  schedule: '作业编排',
};

/** 逐项核准选择：保留台账 / 采用包内 */
export type ConflictChoice = 'ledger' | 'package';

export const CONFLICT_CHOICE_LABEL: Record<ConflictChoice, string> = {
  ledger: '保留台账',
  package: '采用包内',
};

/** 待核准冲突项（保留两份：台账现值与包内值，逐项选择后才落库） */
export interface ConflictItem {
  /** 稳定 id（sev:病害id / sol:病害id / ord:作业单id），断点重计划时按 id 去重 */
  id: string;
  kind: ConflictKind;
  /** 台账目标记录 id（病害或作业单） */
  targetId: string;
  /** 包内记录 id */
  packageRecordId: string;
  /** 展示标签（道岔 · 日期 · 部件 / 作业单号） */
  label: string;
  /** 台账现值描述 */
  ledgerValue: string;
  /** 包内值描述 */
  packageValue: string;
  /** 核准结果：pending 待选 */
  resolution: 'pending' | ConflictChoice;
  /** 作业编排冲突专用：采用包内时是更新对回命中的台账单，还是另插新单 */
  scheduleAction?: 'update' | 'insert';
  /** 作业编排冲突专用：包内作业单 faultIds 经对回重映射后的结果，核准采用包内时直接落库 */
  remappedFaultIds?: string[];
}

/** 接收区包行（合并完成前 payload 一直留在接收区） */
export interface SyncPackageRow extends Revisioned {
  /** 包标识 */
  id: string;
  /** 班组（甲班 / 乙班 / 旧备份迁移） */
  crew: string;
  /** 来源：班组交回 / 旧备份迁移 */
  source: 'crew' | 'legacy';
  status: PackageStatus;
  payload: OfflinePackagePayload;
  exportedAt: string;
  receivedAt: string;
  /** 接收该包的标签页 id */
  receivedByTab: string;
  /** 已应用游标：写入失败恢复时从已完成记录之后继续 */
  appliedInspectionIds: string[];
  appliedFaultIds: string[];
  appliedOrderIds: string[];
  /** 逐项核准冲突清单 */
  conflicts: ConflictItem[];
  /** 停下原因（校验不通过 / 写入失败 / 待核准冲突） */
  stopReason: string;
  /** 跨标签合并互斥：持有租约的标签页 id 与到期时间戳 */
  applyOwner: string | null;
  applyLeaseUntil: number;
  createdAt: string;
  updatedAt: string;
}

/** 旧备份迁移清单项 */
export interface MigrationItem {
  kind: 'inspection' | 'fault' | 'workOrder';
  id: string;
  label: string;
  /** 归属 / 引用问题（null 表示可正常对回） */
  issue: string | null;
}

/** 旧备份迁移清单：缺少包标识的备份先列清单核对再应用 */
export interface MigrationManifest {
  /** 为旧备份生成的包标识 */
  packageId: string;
  exportedAt: string;
  inspections: number;
  faults: number;
  workOrders: number;
  issueCount: number;
  items: MigrationItem[];
}

export const MIGRATION_KIND_LABEL: Record<MigrationItem['kind'], string> = {
  inspection: '巡检',
  fault: '病害',
  workOrder: '作业单',
};
