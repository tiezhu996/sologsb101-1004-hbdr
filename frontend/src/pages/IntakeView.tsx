/**
 * /intake 离线包接收区
 *
 * 巡检甲 / 乙班收工交回的离线包先进入接收区核准，再合并进正式台账：
 * - 每包可见待选冲突数、已应用数量、停下原因；
 * - 病害按道岔 / 日期 / 部件对回，等级 / 销号 / 编排冲突逐项核准（两份并存，不整条覆盖）；
 * - 病害归属与作业单引用双闸门同时成立才允许写入；
 * - 写入逐条检查点，失败从已完成记录之后继续，未确认内容留在接收区；
 * - 多标签同包只有一个完成；旧备份先核对迁移清单。
 */
import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import BlockIcon from '@mui/icons-material/Block';
import ScienceIcon from '@mui/icons-material/Science';
import { useAppSelector } from '../hooks/useAppStore';
import { useIdbList } from '../hooks/useIdbTable';
import { selectSwitchViews } from '../stores/yardStore';
import type { IntakeBatch } from '../types/intake';
import { INTAKE_BATCH_STATUS_LABEL } from '../types/intake';
import {
  applyIntakeBatch,
  armFailPoint,
  deleteIntakeBatch,
  finalizeMigrationPlan,
  listIntakeBatches,
  receiveIntakeFile,
  receivePack,
  rejectIntakeBatch,
  setAttributionOverride,
  setItemDecision,
  toggleMigrationCheck,
  type ApplyResult,
} from '../utils/intakeDb';
import { buildDemoPack } from '../utils/demoPack';
import IntakeItemTable from '../components/intake/IntakeItemTable';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';

const STATUS_CHIP_COLOR: Record<IntakeBatch['status'], 'default' | 'warning' | 'info' | 'success' | 'secondary' | 'error'> = {
  reviewing: 'warning',
  applying: 'info',
  paused: 'error',
  applied: 'success',
  migrate: 'secondary',
  rejected: 'default',
};

export default function IntakeView() {
  const batches = useIdbList(listIntakeBatches);
  const switches = useAppSelector(selectSwitchViews);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [failDialog, setFailDialog] = useState<{ open: boolean; batchId: string }>({ open: false, batchId: '' });
  const [failOrdinal, setFailOrdinal] = useState(2);

  const selected = batches.find((item) => item.id === selectedId) ?? batches[0] ?? null;

  const stats = summarize(batches);

  const notify = (message: string): void => setToast(message);

  const handleFile = async (file: File): Promise<void> => {
    const result = await receiveIntakeFile(file);
    notify(result.message);
    if (result.batchId && result.outcome === 'received') setSelectedId(result.batchId);
  };

  const handleDemo = async (shift: '甲班' | '乙班'): Promise<void> => {
    setBusy(true);
    try {
      const pack = await buildDemoPack({ shift });
      const result = await receivePack(pack);
      notify(result.message);
      if (result.batchId) setSelectedId(result.batchId);
    } catch (error) {
      notify(error instanceof Error ? error.message : '演示包生成失败');
    } finally {
      setBusy(false);
    }
  };

  const handleDecide = async (itemId: string, decision: IntakeBatch['items'][number]['decision']): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    try {
      await setItemDecision(selected.id, itemId, decision);
    } finally {
      setBusy(false);
    }
  };

  const handleOverride = async (localId: string, ledgerSwitchId: string): Promise<void> => {
    if (!selected) return;
    await setAttributionOverride(selected.id, localId, ledgerSwitchId);
  };

  const handleApply = async (batchId: string): Promise<void> => {
    setBusy(true);
    try {
      const result: ApplyResult = await applyIntakeBatch(batchId);
      notify(result.message);
    } finally {
      setBusy(false);
    }
  };

  const handleMigrationCheck = async (key: string): Promise<void> => {
    if (!selected) return;
    await toggleMigrationCheck(selected.id, key);
  };

  const handleFinalizeMigration = async (): Promise<void> => {
    if (!selected) return;
    const result = await finalizeMigrationPlan(selected.id);
    notify(result.message);
  };

  const handleReject = async (batchId: string): Promise<void> => {
    await rejectIntakeBatch(batchId);
    notify('整包已驳回，未写入正式台账');
  };

  const handleDelete = async (batchId: string): Promise<void> => {
    await deleteIntakeBatch(batchId);
    if (selectedId === batchId) setSelectedId(null);
    notify('接收区记录已删除');
  };

  const handleArmFail = async (): Promise<void> => {
    await armFailPoint(failOrdinal);
    setFailDialog({ open: false, batchId: '' });
    notify(`已设置断点：下一次写入到第 ${failOrdinal} 条时停下（用于验证从断点继续）`);
  };

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap mb={1.5}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            离线包接收区
          </Typography>
          <Typography variant="body2" color="text.secondary">
            甲乙班无网作业各带一份本地数据，收工交回病害评定与天窗单；先进接收区逐项核准，双闸门成立后才并入正式台账。
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button variant="contained" component="label" startIcon={<CloudUploadIcon />}>
            接收离线包 / 旧备份
            <input
              hidden
              type="file"
              accept="application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
                event.target.value = '';
              }}
            />
          </Button>
          <Button variant="outlined" disabled={busy} onClick={() => void handleDemo('甲班')}>
            模拟甲班交回
          </Button>
          <Button variant="outlined" disabled={busy} onClick={() => void handleDemo('乙班')}>
            模拟乙班交回
          </Button>
        </Stack>
      </Stack>

      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap mb={1.75}>
        <Box sx={{ width: 200 }}>
          <StatBadge title="接收区在办批次" value={stats.openBatches} suffix="份" color="#1565c0" />
        </Box>
        <Box sx={{ width: 200 }}>
          <StatBadge title="待选冲突（全部包）" value={stats.pendingConflicts} suffix="条" color="#ed6c02" />
        </Box>
        <Box sx={{ width: 200 }}>
          <StatBadge title="闸门拦截" value={stats.blocked} suffix="条" color="#d32f2f" />
        </Box>
        <Box sx={{ width: 200 }}>
          <StatBadge title="已并入台账" value={stats.appliedItems} suffix="条" color="#2e7d32" />
        </Box>
      </Stack>

      {batches.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <EmptyPanel
            title="接收区暂无离线包"
            description="点击右上角「模拟甲班 / 乙班交回」可生成含等级、销号与编排冲突的演示包；也可接收现场导出的离线包 JSON，或缺少包标识的旧整库备份（先走迁移清单）。"
            createLabel="模拟甲班交回"
            onCreate={() => void handleDemo('甲班')}
          />
        </Paper>
      ) : (
        <Paper variant="outlined" sx={{ borderRadius: 2 }}>
          <List disablePadding>
            {batches.map((batch) => {
              const open = selected?.id === batch.id;
              const conflictCount = batch.items.filter((item) => item.status === 'conflict').length;
              const blockedCount = batch.items.filter((item) => item.status === 'blocked').length;
              const reusedCount = batch.items.filter((item) => item.locked).length;
              const writeTotal = batch.items.filter((item) => !item.locked).length;
              const expandedChecks = expanded[batch.id] ?? batch.status === 'migrate';
              return (
                <Box key={batch.id} sx={{ borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
                  <ListItemButton onClick={() => setSelectedId(open ? null : batch.id)} sx={{ py: 1.25 }}>
                    <ListItemText
                      primary={
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                          <Chip size="small" color={STATUS_CHIP_COLOR[batch.status]} label={INTAKE_BATCH_STATUS_LABEL[batch.status]} />
                          <Typography variant="subtitle2">{batch.shift}</Typography>
                          <Chip size="small" variant="outlined" label={`包号 ${batch.packageId}`} />
                          {batch.kind === 'legacy' && <Chip size="small" color="secondary" label="旧备份·无包标识" />}
                        </Stack>
                      }
                      secondary={
                        <Stack direction="row" spacing={1} mt={0.25} flexWrap="wrap" useFlexGap>
                          <Chip size="small" label={`待选冲突 ${conflictCount}`} color={conflictCount ? 'warning' : 'default'} />
                          <Chip size="small" label={`闸门拦截 ${blockedCount}`} color={blockedCount ? 'error' : 'default'} />
                          <Chip size="small" label={`已应用 ${batch.appliedCount}/${writeTotal}`} color="success" variant="outlined" />
                          {reusedCount > 0 && <Chip size="small" variant="outlined" label={`自动复用 ${reusedCount}`} />}
                          {batch.stopReason && <Chip size="small" color="info" variant="outlined" label={`停下原因：${batch.stopReason}`} />}
                        </Stack>
                      }
                    />
                    {open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                  </ListItemButton>

                  <Collapse in={open} unmountOnExit>
                    <Box sx={{ px: 2, pb: 2 }}>
                      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap mb={1.25}>
                        <Typography variant="caption" color="text.secondary">
                          来源 {batch.source} · 作业人员 {batch.crew || '—'} · 接收于 {batch.receivedAt.slice(0, 16).replace('T', ' ')}
                          {batch.note ? ` · ${batch.note}` : ''}
                        </Typography>
                      </Stack>

                      {batch.stopReason && (
                        <Alert
                          severity={batch.status === 'paused' ? 'error' : batch.status === 'applied' ? 'success' : 'info'}
                          sx={{ mb: 1.25 }}
                        >
                          {batch.status === 'applied' ? '该包已全部并入正式台账' : batch.stopReason}
                        </Alert>
                      )}

                      {batch.status === 'migrate' ? (
                        <MigrationChecklist
                          batch={batch}
                          busy={busy}
                          expanded={expandedChecks}
                          onToggleExpand={() => setExpanded((prev) => ({ ...prev, [batch.id]: !expandedChecks }))}
                          onCheck={(key) => void handleMigrationCheck(key)}
                          onFinalize={() => void handleFinalizeMigration()}
                        />
                      ) : (
                        batch.items.length > 0 && (
                          <IntakeItemTable
                            batch={batch}
                            switches={switches}
                            busy={busy || batch.status === 'applying'}
                            onDecide={(itemId, decision) => void handleDecide(itemId, decision)}
                            onOverride={(localId, ledgerId) => void handleOverride(localId, ledgerId)}
                          />
                        )
                      )}

                      <Stack direction="row" spacing={1} mt={1.5} flexWrap="wrap" useFlexGap>
                        {(batch.status === 'reviewing' || batch.status === 'paused') && (
                          <Button
                            variant="contained"
                            color="success"
                            startIcon={<PlayArrowIcon />}
                            disabled={busy}
                            onClick={() => void handleApply(batch.id)}
                          >
                            {batch.status === 'paused' ? '从断点继续写入' : '双闸门核准并写入台账'}
                          </Button>
                        )}
                        {batch.status === 'reviewing' && (
                          <Button
                            variant="outlined"
                            startIcon={<ScienceIcon />}
                            onClick={() => setFailDialog({ open: true, batchId: batch.id })}
                          >
                            演练写入中断
                          </Button>
                        )}
                        {(batch.status === 'reviewing' || batch.status === 'paused' || batch.status === 'migrate') && (
                          <Button
                            variant="outlined"
                            color="warning"
                            startIcon={<BlockIcon />}
                            disabled={busy}
                            onClick={() => void handleReject(batch.id)}
                          >
                            驳回整包
                          </Button>
                        )}
                        <Button
                          variant="text"
                          color="error"
                          startIcon={<DeleteSweepIcon />}
                          disabled={busy || batch.status === 'applying'}
                          onClick={() => void handleDelete(batch.id)}
                        >
                          移除记录
                        </Button>
                      </Stack>
                    </Box>
                  </Collapse>
                </Box>
              );
            })}
          </List>
        </Paper>
      )}

      <Dialog open={failDialog.open} onClose={() => setFailDialog({ open: false, batchId: '' })} maxWidth="xs" fullWidth>
        <DialogTitle>演练：写入中断后从断点继续</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            下一次确认写入时，在第 N 条待写记录处制造一次失败。已写入记录保留检查点，未确认内容留在接收区，再次点击「从断点继续写入」即可验证恢复。
          </Typography>
          <TextField
            fullWidth
            type="number"
            size="small"
            label="第几条待写记录失败"
            value={failOrdinal}
            inputProps={{ min: 1, max: 99 }}
            onChange={(event) => setFailOrdinal(Math.max(1, Number(event.target.value) || 1))}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setFailDialog({ open: false, batchId: '' })}>取消</Button>
          <Button variant="contained" onClick={() => void handleArmFail()}>
            设置并开始
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={3600}
        onClose={() => setToast('')}
        message={toast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}

function MigrationChecklist({
  batch,
  busy,
  expanded,
  onToggleExpand,
  onCheck,
  onFinalize,
}: {
  batch: IntakeBatch;
  busy: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onCheck: (key: string) => void;
  onFinalize: () => void;
}) {
  const allChecked = batch.migrationChecks.every((item) => item.checked);
  return (
    <Box>
      <Alert severity="warning" sx={{ mb: 1 }}
        action={
          <IconButton size="small" onClick={onToggleExpand}>
            {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        }
      >
        旧备份缺少包标识：请先逐项核对迁移清单，核对完成后才生成合并计划（不会整库覆盖）。
      </Alert>
      <Collapse in={expanded}>
        <Stack spacing={1} mb={1.5}>
          {batch.migrationChecks.map((check) => (
            <Paper
              key={check.key}
              variant="outlined"
              sx={{
                p: 1.25,
                display: 'flex',
                gap: 1.5,
                alignItems: 'flex-start',
                bgcolor: check.checked ? 'rgba(46,125,50,0.05)' : undefined,
              }}
            >
              <input
                type="checkbox"
                checked={check.checked}
                disabled={busy}
                onChange={() => onCheck(check.key)}
                style={{ marginTop: 4 }}
                aria-label={check.label}
              />
              <Box>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip size="small" color={check.level === 'danger' ? 'error' : check.level === 'warn' ? 'warning' : 'success'} label={check.level === 'danger' ? '风险' : check.level === 'warn' ? '需转换' : '正常'} />
                  <Typography variant="body2" fontWeight={600}>
                    {check.label}
                  </Typography>
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  {check.detail}
                </Typography>
              </Box>
            </Paper>
          ))}
        </Stack>
        <Button variant="contained" disabled={busy || !allChecked} onClick={onFinalize}>
          {allChecked ? '清单核对完成，生成合并计划' : `还有 ${batch.migrationChecks.filter((i) => !i.checked).length} 项未核对`}
        </Button>
      </Collapse>
    </Box>
  );
}

function summarize(batches: IntakeBatch[]): {
  openBatches: number;
  pendingConflicts: number;
  blocked: number;
  appliedItems: number;
} {
  const active = batches.filter((batch) => batch.status !== 'applied' && batch.status !== 'rejected');
  return {
    openBatches: active.length,
    pendingConflicts: active.reduce((sum, batch) => sum + batch.items.filter((item) => item.status === 'conflict').length, 0),
    blocked: active.reduce((sum, batch) => sum + batch.items.filter((item) => item.status === 'blocked').length, 0),
    appliedItems: batches.reduce((sum, batch) => sum + batch.appliedCount, 0),
  };
}
