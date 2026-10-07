/**
 * 接收区条目表：逐条展示台账一份 / 离线一份的对比，以及调度员的逐项核准按钮。
 * 等级 / 销号 / 编排冲突时三份操作都可见：采用交回 / 两份并存 / 剔除；
 * 已自动复用的条目锁定不可改，杜绝「后导入整条记录盖掉台账」。
 */
import {
  Box,
  Button,
  Chip,
  MenuItem,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import type { IntakeBatch, IntakeItem } from '../../types/intake';
import {
  INTAKE_CONFLICT_TYPE_LABEL,
  INTAKE_ITEM_KIND_LABEL,
  INTAKE_ITEM_STATUS_LABEL,
} from '../../types/intake';
import type { Switch } from '../../types/switch';

const STATUS_COLOR: Record<IntakeItem['status'], 'default' | 'warning' | 'error' | 'success' | 'info' | 'secondary'> = {
  ready: 'info',
  conflict: 'warning',
  blocked: 'error',
  applied: 'success',
  skipped: 'default',
  error: 'error',
};

interface Props {
  batch: IntakeBatch;
  switches: Switch[];
  busy: boolean;
  onDecide: (itemId: string, decision: IntakeItem['decision']) => void;
  onOverride: (packSwitchLocalId: string, ledgerSwitchId: string) => void;
}

function itemTitle(item: IntakeItem): string {
  const payload = item.payload as unknown as Record<string, unknown>;
  const code = typeof payload.code === 'string' ? payload.code : undefined;
  const date = typeof payload.date === 'string' ? payload.date : undefined;
  const windowStart = typeof payload.windowStart === 'string' ? payload.windowStart : undefined;
  if (code) return code;
  if (date) return date;
  if (windowStart) return windowStart;
  return item.localId;
}

export default function IntakeItemTable({ batch, switches, busy, onDecide, onOverride }: Props) {
  const blockedSwitchFaults = batch.items.filter(
    (item) => item.kind === 'fault' && item.gates.some((gate) => gate.key === 'attribution' && !gate.ok),
  );

  return (
    <Box>
      {blockedSwitchFaults.length > 0 && (
        <Box sx={{ mb: 1.5, p: 1.25, borderRadius: 1.5, bgcolor: 'rgba(211,47,47,0.06)', border: '1px solid rgba(211,47,47,0.25)' }}>
          <Typography variant="subtitle2" color="error" sx={{ mb: 0.5 }}>
            病害归属闸门：以下包内道岔在台账找不到同名道岔，请人工改指（改指后闸门重新核算）
          </Typography>
          <Stack spacing={1}>
            {uniqPackSwitchIds(batch).map((localId) => {
              const sw = (batch.items.find((item) => item.kind === 'switch' && item.localId === localId)?.payload ??
                null) as Switch | null;
              const current = batch.attributionOverrides[localId] ?? '';
              return (
                <Stack key={localId} direction="row" spacing={1.5} alignItems="center">
                  <Chip size="small" label={`包内道岔 ${sw?.code ?? `${localId}（包内缺失）`}`} variant="outlined" />
                  <Select
                    size="small"
                    sx={{ minWidth: 260 }}
                    displayEmpty
                    value={current}
                    disabled={busy}
                    onChange={(event) => onOverride(localId, event.target.value)}
                  >
                    <MenuItem value="">按「站场名 + 道岔号」自动对回</MenuItem>
                    {switches.map((item) => (
                      <MenuItem key={item.id} value={item.id}>
                        {item.code}（{item.frogNumber} 号 / {item.railType}）
                      </MenuItem>
                    ))}
                  </Select>
                </Stack>
              );
            })}
          </Stack>
        </Box>
      )}

      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: 86 }}>类别</TableCell>
            <TableCell sx={{ width: 150 }}>标识</TableCell>
            <TableCell>台账一份（现状）</TableCell>
            <TableCell>离线一份（交回）</TableCell>
            <TableCell sx={{ width: 130 }}>闸门 / 状态</TableCell>
            <TableCell sx={{ width: 210 }}>逐项核准</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {batch.items.map((item) => (
            <TableRow key={item.id} hover selected={item.status === 'conflict' || item.status === 'error'}>
              <TableCell>{INTAKE_ITEM_KIND_LABEL[item.kind]}</TableCell>
              <TableCell>
                <Typography variant="body2" noWrap>
                  {itemTitle(item)}
                </Typography>
                {item.locked && (
                  <Tooltip title="与台账完全一致，自动复用，不允许改动">
                    <LockIcon fontSize="inherit" color="disabled" sx={{ verticalAlign: 'middle' }} />
                  </Tooltip>
                )}
              </TableCell>
              <TableCell>
                {item.conflicts.length > 0 ? (
                  <Stack spacing={0.5}>
                    {item.conflicts.map((conflict, index) => (
                      <Box key={index}>
                        <Chip
                          size="small"
                          color="warning"
                          variant="outlined"
                          label={INTAKE_CONFLICT_TYPE_LABEL[conflict.type]}
                          sx={{ mb: 0.25 }}
                        />
                        <Typography variant="caption" display="block" color="text.secondary">
                          {conflict.ledgerSummary}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                ) : item.ledgerId ? (
                  <Typography variant="caption" color="text.secondary">
                    对回台账记录（字段一致，复用）
                  </Typography>
                ) : (
                  <Typography variant="caption" color="text.secondary">
                    台账无此项
                  </Typography>
                )}
              </TableCell>
              <TableCell>
                {item.conflicts.length > 0 ? (
                  <Stack spacing={0.5}>
                    {item.conflicts.map((conflict, index) => (
                      <Box key={index}>
                        <Typography variant="caption" display="block">
                          {conflict.incomingSummary}
                        </Typography>
                        <Typography variant="caption" display="block" color="warning.main">
                          {conflict.message}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                ) : (
                  <Typography variant="caption">{plainSummary(item)}</Typography>
                )}
                {item.kind === 'workOrder' && item.assignedCode && item.decision === 'keepBoth' && (
                  <Chip size="small" color="secondary" sx={{ mt: 0.5 }} label={`并存改挂 ${item.assignedCode}`} />
                )}
                {item.errorMessage && (
                  <Typography variant="caption" display="block" color="error">
                    {item.errorMessage}
                  </Typography>
                )}
              </TableCell>
              <TableCell>
                <Stack spacing={0.5}>
                  <Chip size="small" color={STATUS_COLOR[item.status]} label={INTAKE_ITEM_STATUS_LABEL[item.status]} />
                  {item.gates
                    .filter((gate) => !gate.ok)
                    .map((gate) => (
                      <Tooltip key={gate.key} title={gate.message}>
                        <Chip size="small" color="error" variant="outlined" label={gate.key === 'attribution' ? '归属不成立' : '引用不成立'} />
                      </Tooltip>
                    ))}
                </Stack>
              </TableCell>
              <TableCell>
                {item.locked ? (
                  <Chip size="small" variant="outlined" disabled label="自动复用" />
                ) : item.status === 'applied' ? (
                  <Chip size="small" color="success" label="已写入" />
                ) : (
                  <DecisionButtons item={item} busy={busy} onDecide={onDecide} />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

function DecisionButtons({
  item,
  busy,
  onDecide,
}: {
  item: IntakeItem;
  busy: boolean;
  onDecide: (itemId: string, decision: IntakeItem['decision']) => void;
}) {
  const canKeepBoth = item.conflicts.some((conflict) =>
    ['severity', 'solvedState', 'schedule', 'codeDup'].includes(conflict.type),
  );
  if (item.status === 'skipped' && item.decision === 'discard') {
    return (
      <Button size="small" disabled={busy} onClick={() => onDecide(item.id, 'undecided')}>
        撤销剔除
      </Button>
    );
  }
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
      <Button
        size="small"
        variant={item.decision === 'accept' ? 'contained' : 'outlined'}
        disabled={busy}
        onClick={() => onDecide(item.id, 'accept')}
      >
        采用交回
      </Button>
      {canKeepBoth && (
        <Button
          size="small"
          color="secondary"
          variant={item.decision === 'keepBoth' ? 'contained' : 'outlined'}
          disabled={busy}
          onClick={() => onDecide(item.id, 'keepBoth')}
        >
          两份并存
        </Button>
      )}
      <Button
        size="small"
        color="error"
        variant={item.decision === 'discard' ? 'contained' : 'outlined'}
        disabled={busy}
        onClick={() => onDecide(item.id, 'discard')}
      >
        剔除
      </Button>
    </Stack>
  );
}

function uniqPackSwitchIds(batch: IntakeBatch): string[] {
  const ids = new Set<string>();
  for (const item of batch.items) {
    if (item.kind !== 'fault') continue;
    if (!item.gates.some((gate) => gate.key === 'attribution' && !gate.ok)) continue;
    const inspection = batch.items.find(
      (row) => row.kind === 'inspection' && row.localId === (item.payload as { inspectionId?: string }).inspectionId,
    );
    const switchLocalId = (inspection?.payload as { switchId?: string } | undefined)?.switchId;
    if (switchLocalId) ids.add(switchLocalId);
  }
  return [...ids];
}

function plainSummary(item: IntakeItem): string {
  const payload = item.payload as unknown as Record<string, unknown>;
  if (item.kind === 'fault') {
    return `${String(payload.type)} ${String(payload.part)} · 等级 ${String(payload.severity)} · ${String(payload.state)}`;
  }
  if (item.kind === 'workOrder') {
    return `${String(payload.windowStart)} ~ ${String(payload.windowEnd)} · ${String(payload.leader)}`;
  }
  return JSON.stringify(payload).slice(0, 80);
}
