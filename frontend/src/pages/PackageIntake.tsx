/**
 * /sync 离线包接收与合并
 * 甲乙班离线包交回后先落接收区：核准（病害归属 + 作业单引用同时成立）→ 逐条合并
 * （断点可恢复）→ 等级 / 销号 / 作业编排冲突逐项核准。
 * 每包可见：待选冲突、已应用数量、停下原因。
 */
import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
  Paper,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import UndoIcon from '@mui/icons-material/Undo';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useAppDispatch, useAppSelector } from '../hooks/useAppStore';
import {
  confirmPackage,
  exportCrewPackage,
  pendingConflictCount,
  receiveIncoming,
  rejectPackage,
  removePackage,
  resolveConflictItem,
  selectPackageRows,
  selectPackageStats,
  stageLegacyPackage,
} from '../stores/packageStore';
import {
  CONFLICT_CHOICE_LABEL,
  CONFLICT_KIND_LABEL,
  MIGRATION_KIND_LABEL,
  PACKAGE_STATUS_LABEL,
  type ConflictChoice,
  type MigrationManifest,
  type OfflinePackagePayload,
  type PackageStatus,
  type SyncPackageRow,
} from '../types/syncPackage';
import { TAB_ID, isLeaseLive } from '../utils/packageLock';
import { backupFilename, downloadJson } from '../utils/format';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';

const STATUS_COLOR: Record<PackageStatus, 'default' | 'info' | 'warning' | 'error' | 'success'> = {
  received: 'info',
  applying: 'warning',
  blocked: 'error',
  conflicted: 'warning',
  merged: 'success',
  rejected: 'default',
};

/** 已应用数量（游标 / 总数） */
function AppliedCell({ row }: { row: SyncPackageRow }) {
  return (
    <Box sx={{ whiteSpace: 'nowrap' }}>
      <Typography variant="body2">
        病害 {row.appliedFaultIds.length}/{row.payload.faults.length}
      </Typography>
      <Typography variant="body2">
        作业单 {row.appliedOrderIds.length}/{row.payload.workOrders.length}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        巡检 {row.appliedInspectionIds.length}/{row.payload.inspections.length}
      </Typography>
    </Box>
  );
}

export default function PackageIntake() {
  const dispatch = useAppDispatch();
  const packages = useAppSelector(selectPackageRows);
  const stats = useAppSelector(selectPackageStats);
  const busyPackageId = useAppSelector((state) => state.syncPackage.busyPackageId);

  const [toast, setToast] = useState('');
  const [conflictPackageId, setConflictPackageId] = useState<string | null>(null);
  const [legacyDraft, setLegacyDraft] = useState<{ manifest: MigrationManifest; payload: OfflinePackagePayload } | null>(
    null,
  );

  const conflictPackage = packages.find((item) => item.id === conflictPackageId) ?? null;
  const errorText = (error: unknown): string => (typeof error === 'string' ? error : '操作失败，请查看控制台');

  const handleExport = async (crew: string): Promise<void> => {
    try {
      const file = await dispatch(exportCrewPackage(crew)).unwrap();
      downloadJson(backupFilename(`gbrailswitch-offline-${crew}`), file);
      setToast(`已导出${crew}离线包 ${file.packageId}（病害 ${file.faults.length} · 作业单 ${file.workOrders.length}）`);
    } catch (error) {
      setToast(`导出失败：${errorText(error)}`);
    }
  };

  const handleReceive = async (file: File): Promise<void> => {
    try {
      const result = await dispatch(receiveIncoming(await file.text())).unwrap();
      if (result.kind === 'legacy' && result.manifest && result.payload) {
        setLegacyDraft({ manifest: result.manifest, payload: result.payload });
        setToast(result.message);
      } else {
        setToast(result.message);
      }
    } catch (error) {
      setToast(`接收失败：${errorText(error)}`);
    }
  };

  const handleConfirm = async (packageId: string): Promise<void> => {
    try {
      setToast(await dispatch(confirmPackage(packageId)).unwrap());
    } catch (error) {
      setToast(errorText(error));
    }
  };

  const handleResolve = async (conflictId: string, choice: ConflictChoice): Promise<void> => {
    if (!conflictPackage) return;
    try {
      setToast(
        await dispatch(resolveConflictItem({ packageId: conflictPackage.id, conflictId, choice })).unwrap(),
      );
    } catch (error) {
      setToast(errorText(error));
    }
  };

  const handleReject = async (packageId: string): Promise<void> => {
    try {
      setToast(await dispatch(rejectPackage(packageId)).unwrap());
    } catch (error) {
      setToast(errorText(error));
    }
  };

  const handleRemove = async (packageId: string): Promise<void> => {
    try {
      setToast(await dispatch(removePackage(packageId)).unwrap());
      if (conflictPackageId === packageId) setConflictPackageId(null);
    } catch (error) {
      setToast(errorText(error));
    }
  };

  const handleStageLegacy = async (): Promise<void> => {
    if (!legacyDraft) return;
    try {
      setToast(await dispatch(stageLegacyPackage(legacyDraft)).unwrap());
      setLegacyDraft(null);
    } catch (error) {
      setToast(errorText(error));
    }
  };

  /** 每包主操作：按状态给 核准合并 / 继续合并 / 逐项核准 */
  const renderPrimaryAction = (row: SyncPackageRow) => {
    const busy = busyPackageId === row.id;
    if (row.status === 'received' || row.status === 'blocked') {
      return (
        <Button
          size="small"
          variant="contained"
          disabled={busy}
          startIcon={<PlayArrowIcon />}
          onClick={() => void handleConfirm(row.id)}
        >
          {row.status === 'blocked' ? '继续合并' : '核准合并'}
        </Button>
      );
    }
    if (row.status === 'applying') {
      if (isLeaseLive(row) && row.applyOwner !== TAB_ID) {
        return (
          <Typography variant="caption" color="text.secondary">
            另一标签页合并中…
          </Typography>
        );
      }
      return (
        <Button
          size="small"
          variant="contained"
          disabled={busy}
          startIcon={<PlayArrowIcon />}
          onClick={() => void handleConfirm(row.id)}
        >
          继续合并
        </Button>
      );
    }
    if (row.status === 'conflicted') {
      return (
        <Button
          size="small"
          variant="contained"
          color="warning"
          startIcon={<FactCheckIcon />}
          onClick={() => setConflictPackageId(row.id)}
        >
          逐项核准
        </Button>
      );
    }
    return null;
  };

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap mb={1.5}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            离线包接收与合并
          </Typography>
          <Typography variant="body2" color="text.secondary">
            甲乙班离线包先落接收区，核准（病害归属 + 作业单引用同时成立）后逐条合并；等级 / 销号 / 作业编排冲突保留两份逐项核准，中断后从断点继续。
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button variant="outlined" startIcon={<CloudDownloadIcon />} onClick={() => void handleExport('甲班')}>
            导出甲班离线包
          </Button>
          <Button variant="outlined" startIcon={<CloudDownloadIcon />} onClick={() => void handleExport('乙班')}>
            导出乙班离线包
          </Button>
          <Button variant="contained" component="label" startIcon={<CloudUploadIcon />}>
            接收离线包 / 旧备份
            <input
              hidden
              type="file"
              accept="application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleReceive(file);
                event.target.value = '';
              }}
            />
          </Button>
        </Stack>
      </Stack>

      <Grid container spacing={1.5} mb={1.75}>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge title="接收区包数" value={stats.total} suffix="个" color="#1565c0" hint={`待核准 ${stats.received} · 已退回/移除前均留痕`} />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="待选冲突"
            value={stats.pendingConflicts}
            suffix="项"
            color="#ed6c02"
            hint={`待逐项核准的包 ${stats.conflicted} 个`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge title="已停下" value={stats.blocked} suffix="个" color="#d32f2f" hint="归属/引用不成立或写入失败，停在接收区" />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge title="已合并" value={stats.merged} suffix="个" color="#2e7d32" hint="全部记录与冲突处理完成" />
        </Grid>
      </Grid>

      <Paper variant="outlined" sx={{ borderRadius: 2, p: 1.5 }}>
        <Typography variant="subtitle1" fontWeight={600} mb={1}>
          接收区（{packages.length}）
        </Typography>
        {packages.length === 0 ? (
          <EmptyPanel
            title="接收区暂无离线包"
            description="甲乙班收工后交回的离线包会先落在这里，核准通过才合并进正式台账；旧备份会先生成迁移清单。"
          />
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>包标识</TableCell>
                  <TableCell>班组 / 来源</TableCell>
                  <TableCell>状态</TableCell>
                  <TableCell>内容</TableCell>
                  <TableCell>已应用</TableCell>
                  <TableCell>待选冲突</TableCell>
                  <TableCell sx={{ minWidth: 180 }}>停下原因</TableCell>
                  <TableCell align="right">操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {packages.map((row) => {
                  const pending = pendingConflictCount(row);
                  return (
                    <TableRow key={row.id} hover>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                          {row.id}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          接收 {row.receivedAt.slice(0, 16).replace('T', ' ')}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
                          <Chip size="small" variant="outlined" label={row.crew} />
                          {row.source === 'legacy' ? <Chip size="small" color="secondary" variant="outlined" label="旧备份" /> : null}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Chip size="small" color={STATUS_COLOR[row.status]} label={PACKAGE_STATUS_LABEL[row.status]} />
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" sx={{ whiteSpace: 'nowrap' }}>
                          病害 {row.payload.faults.length} · 作业单 {row.payload.workOrders.length}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          巡检 {row.payload.inspections.length}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <AppliedCell row={row} />
                      </TableCell>
                      <TableCell>
                        {row.conflicts.length === 0 ? (
                          <Typography variant="body2" color="text.secondary">
                            —
                          </Typography>
                        ) : pending > 0 ? (
                          <Chip
                            size="small"
                            color="warning"
                            label={`待选 ${pending} / ${row.conflicts.length}`}
                            onClick={() => setConflictPackageId(row.id)}
                          />
                        ) : (
                          <Chip
                            size="small"
                            color="success"
                            variant="outlined"
                            label={`已核准 ${row.conflicts.length}`}
                            onClick={() => setConflictPackageId(row.id)}
                          />
                        )}
                      </TableCell>
                      <TableCell>
                        {row.stopReason ? (
                          <Typography variant="caption" color={row.status === 'blocked' ? 'error' : 'text.secondary'} sx={{ lineHeight: 1.5 }}>
                            {row.stopReason}
                          </Typography>
                        ) : (
                          <Typography variant="body2" color="text.secondary">
                            —
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={0.5} justifyContent="flex-end" flexWrap="wrap" useFlexGap>
                          {renderPrimaryAction(row)}
                          {row.status === 'received' || row.status === 'blocked' ? (
                            <Button size="small" color="warning" startIcon={<UndoIcon />} onClick={() => void handleReject(row.id)}>
                              退回
                            </Button>
                          ) : null}
                          {row.status === 'merged' || row.status === 'rejected' ? (
                            <Button size="small" color="error" startIcon={<DeleteOutlineIcon />} onClick={() => void handleRemove(row.id)}>
                              移除
                            </Button>
                          ) : null}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      {/* 逐项核准冲突对话框 */}
      <Dialog open={Boolean(conflictPackage)} onClose={() => setConflictPackageId(null)} fullWidth maxWidth="md">
        <DialogTitle sx={{ fontFamily: 'monospace', fontSize: 16 }}>逐项核准冲突 · {conflictPackage?.id}</DialogTitle>
        <DialogContent dividers>
          <Alert severity="info" sx={{ mb: 1.5 }}>
            等级、销号与作业编排冲突保留两份，逐项选择「保留台账」或「采用包内」；不会用包内整条记录直接盖掉台账。
          </Alert>
          <Stack spacing={1.25}>
            {conflictPackage?.conflicts.map((item) => (
              <Paper key={item.id} variant="outlined" sx={{ p: 1.25 }}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Chip size="small" color="primary" variant="outlined" label={CONFLICT_KIND_LABEL[item.kind]} />
                  <Typography variant="subtitle2">{item.label}</Typography>
                  <Box sx={{ flexGrow: 1 }} />
                  {item.resolution === 'pending' ? (
                    <>
                      <Button size="small" variant="outlined" onClick={() => void handleResolve(item.id, 'ledger')}>
                        保留台账
                      </Button>
                      <Button size="small" variant="contained" onClick={() => void handleResolve(item.id, 'package')}>
                        采用包内
                      </Button>
                    </>
                  ) : (
                    <Chip size="small" color="success" label={`已核准：${CONFLICT_CHOICE_LABEL[item.resolution]}`} />
                  )}
                </Stack>
                <Grid container spacing={1} mt={0.5}>
                  <Grid item xs={12} sm={6}>
                    <Paper variant="outlined" sx={{ p: 1, backgroundColor: '#f5f6f8' }}>
                      <Typography variant="caption" color="text.secondary">
                        台账现值
                      </Typography>
                      <Typography variant="body2">{item.ledgerValue}</Typography>
                    </Paper>
                  </Grid>
                  <Grid item xs={12} sm={6}>
                    <Paper variant="outlined" sx={{ p: 1, backgroundColor: '#fff4e5' }}>
                      <Typography variant="caption" color="text.secondary">
                        包内值
                      </Typography>
                      <Typography variant="body2">{item.packageValue}</Typography>
                    </Paper>
                  </Grid>
                </Grid>
              </Paper>
            ))}
            {conflictPackage && conflictPackage.conflicts.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                该包没有冲突项。
              </Typography>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConflictPackageId(null)}>关闭</Button>
        </DialogActions>
      </Dialog>

      {/* 旧备份迁移清单对话框 */}
      <Dialog open={Boolean(legacyDraft)} onClose={() => setLegacyDraft(null)} fullWidth maxWidth="md">
        <DialogTitle>旧备份迁移清单（缺少包标识）</DialogTitle>
        <DialogContent dividers>
          {legacyDraft ? (
            <>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap mb={1.5}>
                <Chip size="small" color="primary" variant="outlined" label={`生成包标识 ${legacyDraft.manifest.packageId}`} />
                <Chip size="small" label={`巡检 ${legacyDraft.manifest.inspections}`} />
                <Chip size="small" label={`病害 ${legacyDraft.manifest.faults}`} />
                <Chip size="small" label={`作业单 ${legacyDraft.manifest.workOrders}`} />
                <Chip
                  size="small"
                  color={legacyDraft.manifest.issueCount > 0 ? 'error' : 'success'}
                  label={`问题 ${legacyDraft.manifest.issueCount}`}
                />
              </Stack>
              {legacyDraft.manifest.issueCount > 0 ? (
                <Alert severity="warning" sx={{ mb: 1.5 }}>
                  存在归属 / 引用问题的记录迁入接收区后无法核准合并，需先在台账补齐归属道岔或退回班组。
                </Alert>
              ) : null}
              <TableContainer component={Paper} variant="outlined">
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>类型</TableCell>
                      <TableCell>记录标识</TableCell>
                      <TableCell>摘要</TableCell>
                      <TableCell>问题</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {legacyDraft.manifest.items.map((item) => (
                      <TableRow key={`${item.kind}-${item.id}`} hover>
                        <TableCell>{MIGRATION_KIND_LABEL[item.kind]}</TableCell>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{item.id}</TableCell>
                        <TableCell>{item.label}</TableCell>
                        <TableCell>
                          {item.issue ? (
                            <Chip size="small" color="error" label={item.issue} />
                          ) : (
                            <Chip size="small" color="success" variant="outlined" label="可对回" />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLegacyDraft(null)}>取消</Button>
          <Button variant="contained" onClick={() => void handleStageLegacy()}>
            核对无误，迁入接收区
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={3200}
        onClose={() => setToast('')}
        message={toast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}
