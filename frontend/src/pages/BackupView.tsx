/**
 * /backup 封锁条件与版本
 * 登记慢行 / 封锁条件，查看结构版本并导出 / 导入 JSON；消费全部模型与 <EmptyPanel>。
 */
import { useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { useAppSelector } from '../hooks/useAppStore';
import { useIdbTable } from '../hooks/useIdbTable';
import { selectSwitchViews, selectYardViews } from '../stores/yardStore';
import { selectFaultCounts } from '../stores/faultStore';
import { selectWindowStats } from '../stores/workOrderStore';
import {
  DB_NAME,
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  countAll,
  exportSnapshot,
  importSnapshot,
  listRestrictions,
  putRestriction,
  removeRestriction,
  resetDatabase,
  schemaInfo,
  type DatabaseSnapshot,
  type SpeedRestrictionRow,
} from '../utils/db';
import { backupFilename, downloadJson, readJsonFile } from '../utils/format';
import { exportOfflinePack } from '../utils/export';
import { nowDateTime, shiftDate, todayDate } from '../utils/window';
import { share } from '../utils/format';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';

interface RestrictionForm {
  yardId: string;
  switchCode: string;
  limitKmh: number;
  periodStart: string;
  periodEnd: string;
  reason: string;
}

function defaultRestriction(yardId: string): RestrictionForm {
  return {
    yardId,
    switchCode: '',
    limitKmh: 25,
    periodStart: todayDate(),
    periodEnd: shiftDate(5),
    reason: '',
  };
}

export default function BackupView() {
  const yards = useAppSelector(selectYardViews);
  const switches = useAppSelector(selectSwitchViews);
  const faultCounts = useAppSelector(selectFaultCounts);
  const windowStats = useAppSelector(selectWindowStats);

  const { data: restrictions, reload: reloadRestrictions } = useIdbTable<SpeedRestrictionRow[]>(listRestrictions, []);
  const { data: counts, reload: reloadCounts } = useIdbTable(countAll, []);

  const [toast, setToast] = useState('');
  const [restrictionDialog, setRestrictionDialog] = useState<{ open: boolean; form: RestrictionForm }>({
    open: false,
    form: defaultRestriction(''),
  });

  const info = schemaInfo();
  const rows = restrictions ?? [];

  const overview = useMemo(
    () => ({
      yards: yards.length,
      switches: switches.length,
      restrictions: rows.length,
      tables: counts ?? {},
    }),
    [yards.length, switches.length, rows.length, counts],
  );

  const submitRestriction = async (): Promise<void> => {
    if (!restrictionDialog.form.yardId) {
      setToast('请选择站场');
      return;
    }
    if (!restrictionDialog.form.reason.trim()) {
      setToast('请填写登记原因');
      return;
    }
    await putRestriction({
      id: `restrict-${Date.now().toString(36)}`,
      yardId: restrictionDialog.form.yardId,
      switchCode: restrictionDialog.form.switchCode.trim(),
      limitKmh: restrictionDialog.form.limitKmh,
      period: `${restrictionDialog.form.periodStart} ~ ${restrictionDialog.form.periodEnd}`,
      reason: restrictionDialog.form.reason.trim(),
      createdAt: nowDateTime(),
      revision: ROW_REVISION,
    });
    await reloadRestrictions();
    await reloadCounts();
    setToast('封锁 / 慢行条件已登记');
    setRestrictionDialog({ open: false, form: defaultRestriction('') });
  };

  const handleExport = async (): Promise<void> => {
    const snapshot = await exportSnapshot();
    downloadJson(backupFilename(`gbrailswitch-backup-v${DB_SCHEMA_VERSION}`), snapshot);
    setToast(`已导出 ${snapshot.yards.length} 个站场、${snapshot.faults.length} 处病害的 JSON 备份`);
  };

  /** 巡检班无网收工：导出本班离线包（交回调度台先进接收区核准，不会整库覆盖） */
  const handleExportPack = async (shift: '甲班' | '乙班'): Promise<void> => {
    const pack = await exportOfflinePack({
      shift,
      note: `${shift}无网巡检交回：病害评定与天窗单`,
    });
    downloadJson(backupFilename(`gbrailswitch-offline-${shift === '乙班' ? 'yi' : 'jia'}`), pack);
    setToast(`已导出${shift}离线包（包号 ${pack.packageId}）：${pack.faults.length} 处病害、${pack.workOrders.length} 张天窗单，请在「离线包接收区」交回`);
  };

  const handleImport = async (file: File): Promise<void> => {
    try {
      const snapshot = await readJsonFile<DatabaseSnapshot>(file);
      if (!snapshot || !Array.isArray(snapshot.yards)) {
        setToast('文件格式不正确：缺少 yards 数组');
        return;
      }
      await importSnapshot(snapshot);
      await Promise.all([reloadRestrictions(), reloadCounts()]);
      setToast(`导入完成：${snapshot.yards.length} 个站场、${snapshot.faults?.length ?? 0} 处病害`);
    } catch (error) {
      setToast(`导入失败：${error instanceof Error ? error.message : '文件解析异常'}`);
    }
  };

  const handleReset = async (): Promise<void> => {
    await resetDatabase();
    await Promise.all([reloadRestrictions(), reloadCounts()]);
    setToast('已清空并重新播种演示数据');
  };

  const switchOptions = switches.filter((item) => item.yardId === restrictionDialog.form.yardId);

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap mb={1.5}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            封锁条件与版本
          </Typography>
          <Typography variant="body2" color="text.secondary">
            登记慢行 / 封锁条件，查看 IndexedDB 结构版本，并做整库 JSON 导出 / 导入。
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={() => setRestrictionDialog({ open: true, form: defaultRestriction(yards[0]?.id ?? '') })}
          >
            登记封锁条件
          </Button>
          <Button variant="outlined" startIcon={<CloudDownloadIcon />} onClick={() => void handleExport()}>
            导出 JSON
          </Button>
          <Button variant="outlined" color="secondary" onClick={() => void handleExportPack('甲班')}>
            导出甲班离线包
          </Button>
          <Button variant="outlined" color="secondary" onClick={() => void handleExportPack('乙班')}>
            导出乙班离线包
          </Button>
          <Button variant="outlined" component="label" startIcon={<CloudUploadIcon />}>
            导入 JSON
            <input
              hidden
              type="file"
              accept="application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleImport(file);
                event.target.value = '';
              }}
            />
          </Button>
          <Button variant="outlined" color="error" startIcon={<RestartAltIcon />} onClick={() => void handleReset()}>
            重置演示数据
          </Button>
        </Stack>
      </Stack>

      <Grid container spacing={1.5} mb={1.75}>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge title="站场 / 道岔" value={`${overview.yards} / ${overview.switches}`} color="#1565c0" />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="病害销号率"
            value={faultCounts.total === 0 ? 0 : Number(((faultCounts.solved / faultCounts.total) * 100).toFixed(1))}
            suffix="%"
            percent={faultCounts.total === 0 ? 0 : Number(((faultCounts.solved / faultCounts.total) * 100).toFixed(1))}
            color="#2e7d32"
            hint={`共 ${faultCounts.total} 处病害，待修 ${faultCounts.pending} 处`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="天窗占用率"
            value={windowStats.occupationRate}
            suffix="%"
            percent={windowStats.occupationRate}
            color="#00897b"
            hint={`${windowStats.total} 张作业单累计 ${windowStats.minutes} 分钟`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="封锁 / 慢行条件"
            value={overview.restrictions}
            suffix="条"
            color="#ed6c02"
            hint={`待修病害占比 ${share(faultCounts.pending, faultCounts.total)}%`}
          />
        </Grid>
      </Grid>

      <Grid container spacing={1.75}>
        <Grid item xs={12} lg={7}>
          <Paper variant="outlined" sx={{ borderRadius: 2, p: 1.5 }}>
            <Typography variant="subtitle1" fontWeight={600} mb={1}>
              封锁 / 慢行条件登记
            </Typography>
            {rows.length === 0 ? (
              <EmptyPanel
                title="暂无封锁条件"
                description="登记慢行 / 封锁条件后，可在编排天窗时参考限速要求。"
                createLabel="登记封锁条件"
                onCreate={() => setRestrictionDialog({ open: true, form: defaultRestriction(yards[0]?.id ?? '') })}
              />
            ) : (
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>站场</TableCell>
                      <TableCell>道岔</TableCell>
                      <TableCell>限速</TableCell>
                      <TableCell>起止</TableCell>
                      <TableCell>原因</TableCell>
                      <TableCell align="right">操作</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rows.map((row) => {
                      const yard = yards.find((item) => item.id === row.yardId);
                      return (
                        <TableRow key={row.id} hover>
                          <TableCell>{yard?.name ?? '未知站场'}</TableCell>
                          <TableCell>{row.switchCode || '站场级'}</TableCell>
                          <TableCell>
                            <Chip size="small" color={row.limitKmh <= 25 ? 'error' : 'warning'} label={`${row.limitKmh} km/h`} />
                          </TableCell>
                          <TableCell>{row.period}</TableCell>
                          <TableCell>{row.reason}</TableCell>
                          <TableCell align="right">
                            <Button
                              size="small"
                              color="error"
                              startIcon={<DeleteIcon />}
                              onClick={async () => {
                                await removeRestriction(row.id);
                                await reloadRestrictions();
                                await reloadCounts();
                                setToast('封锁条件已删除');
                              }}
                            >
                              删除
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>
        </Grid>

        <Grid item xs={12} lg={5}>
          <Paper variant="outlined" sx={{ borderRadius: 2, p: 1.5 }}>
            <Typography variant="subtitle1" fontWeight={600} mb={1}>
              结构版本与存储
            </Typography>
            <Stack spacing={0.75}>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">
                  IndexedDB 库名
                </Typography>
                <Chip size="small" color="primary" label={DB_NAME} />
              </Stack>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">
                  数据结构版本
                </Typography>
                <Typography variant="body2">v{DB_SCHEMA_VERSION}</Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">
                  数据行修订号
                </Typography>
                <Typography variant="body2">{ROW_REVISION}</Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">
                  基准日期
                </Typography>
                <Typography variant="body2">{info.today}</Typography>
              </Stack>
            </Stack>

            <Typography variant="subtitle2" sx={{ mt: 2, mb: 0.5 }}>
              各表记录数
            </Typography>
            <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
              {Object.entries(overview.tables).map(([table, count]) => (
                <Chip key={table} size="small" variant="outlined" label={`${table} ${count}`} />
              ))}
            </Stack>

            <Typography variant="caption" color="text.secondary" display="block" mt={2} lineHeight={1.7}>
              说明：所有数据仅保存在当前浏览器 IndexedDB，不落服务端。数据结构升级登记在 utils/db.ts 的 Dexie
              version 与 upgrade 中；导出 JSON 可用于换机迁移与评审留档。
            </Typography>
          </Paper>
        </Grid>
      </Grid>

      <Dialog
        open={restrictionDialog.open}
        onClose={() => setRestrictionDialog({ open: false, form: defaultRestriction('') })}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>登记封锁 / 慢行条件</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <FormControl fullWidth size="small">
              <InputLabel>站场</InputLabel>
              <Select
                label="站场"
                value={restrictionDialog.form.yardId}
                onChange={(event) =>
                  setRestrictionDialog((prev) => ({
                    ...prev,
                    form: { ...prev.form, yardId: event.target.value, switchCode: '' },
                  }))
                }
              >
                {yards.map((item) => (
                  <MenuItem key={item.id} value={item.id}>
                    {item.name}（{item.region}）
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth size="small">
              <InputLabel>关联道岔</InputLabel>
              <Select
                label="关联道岔"
                value={restrictionDialog.form.switchCode}
                onChange={(event) =>
                  setRestrictionDialog((prev) => ({ ...prev, form: { ...prev.form, switchCode: event.target.value } }))
                }
              >
                <MenuItem value="">站场级（不指定道岔）</MenuItem>
                {switchOptions.map((item) => (
                  <MenuItem key={item.id} value={item.code}>
                    {item.code}（{item.frogNumber} 号 / {item.railType}）
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              fullWidth
              size="small"
              type="number"
              label="限速值（km/h）"
              value={restrictionDialog.form.limitKmh}
              onChange={(event) =>
                setRestrictionDialog((prev) => ({ ...prev, form: { ...prev.form, limitKmh: Number(event.target.value) } }))
              }
            />
            <Stack direction="row" spacing={2}>
              <TextField
                fullWidth
                size="small"
                type="date"
                label="起始日期"
                InputLabelProps={{ shrink: true }}
                value={restrictionDialog.form.periodStart}
                onChange={(event) =>
                  setRestrictionDialog((prev) => ({ ...prev, form: { ...prev.form, periodStart: event.target.value } }))
                }
              />
              <TextField
                fullWidth
                size="small"
                type="date"
                label="结束日期"
                InputLabelProps={{ shrink: true }}
                value={restrictionDialog.form.periodEnd}
                onChange={(event) =>
                  setRestrictionDialog((prev) => ({ ...prev, form: { ...prev.form, periodEnd: event.target.value } }))
                }
              />
            </Stack>
            <TextField
              fullWidth
              size="small"
              multiline
              minRows={2}
              label="登记原因"
              value={restrictionDialog.form.reason}
              onChange={(event) => setRestrictionDialog((prev) => ({ ...prev, form: { ...prev.form, reason: event.target.value } }))}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRestrictionDialog({ open: false, form: defaultRestriction('') })}>取消</Button>
          <Button variant="contained" onClick={() => void submitRestriction()}>
            保存
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={2800}
        onClose={() => setToast('')}
        message={toast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}
