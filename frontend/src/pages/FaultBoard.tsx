/**
 * /faults 病害评定与销号
 * 评定等级、批量调整、手工销号与撤销；消费 Fault、Switch 与 <SeverityTag>、<FilterBar>。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Checkbox,
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
  Tooltip,
  Typography,
} from '@mui/material';
import DoneAllIcon from '@mui/icons-material/DoneAll';
import UndoIcon from '@mui/icons-material/Undo';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import DownloadIcon from '@mui/icons-material/Download';
import { useAppDispatch, useAppSelector } from '../hooks/useAppStore';
import { useFaultFilter } from '../hooks/useFaultFilter';
import { bulkEscalate, bulkSetSeverity, createFault, deleteFault, setFaultState, updateFault } from '../stores/faultStore';
import { selectSwitchViews } from '../stores/yardStore';
import { selectInspectionViews } from '../stores/faultStore';
import {
  FAULT_PARTS,
  FAULT_PART_LABEL,
  FAULT_SEVERITIES,
  FAULT_SEVERITY_LABEL,
  FAULT_TYPES,
  FAULT_TYPE_LABEL,
  PART_CHECK_HINT,
  type FaultPart,
  type FaultSeverity,
  type FaultType,
} from '../types/fault';
import { ROUTES } from '../router/routes';
import { countBySeverity, formatSizeMm, sizeSeverityHint } from '../utils/severity';
import { downloadCsv, share } from '../utils/format';
import { nowDateTime } from '../utils/window';
import SeverityTag from '../components/common/SeverityTag';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar, { useFilterValues, useKeywordFilter } from '../components/common/FilterBar';

export default function FaultBoard() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const filter = useFaultFilter();
  const switches = useAppSelector(selectSwitchViews);
  const inspections = useAppSelector(selectInspectionViews);

  const keyword = useKeywordFilter();
  const urlFilters = useFilterValues(['yard', 'part', 'severity', 'state']);
  const [selected, setSelected] = useState<string[]>([]);
  const [toast, setToast] = useState('');
  const [bulkSeverity, setBulkSeverity] = useState<FaultSeverity>('medium');
  const [editDialog, setEditDialog] = useState<{
    open: boolean;
    editingId: string | null;
    inspectionId: string;
    part: FaultPart;
    type: FaultType;
    severity: FaultSeverity;
    sizeMm: string;
  }>({
    open: false,
    editingId: null,
    inspectionId: '',
    part: 'pointRail',
    type: 'wear',
    severity: 'light',
    sizeMm: '',
  });

  /** URL 条件与 Redux 条件叠加过滤 */
  const rows = useMemo(() => {
    const lower = keyword.trim().toLowerCase();
    const yardFilter = urlFilters.yard ?? [];
    const partFilter = (urlFilters.part ?? []) as FaultPart[];
    const severityFilter = (urlFilters.severity ?? []) as FaultSeverity[];
    const stateFilter = (urlFilters.state ?? []) as Array<'pending' | 'solved'>;
    return filter.faults.filter((row) => {
      if (yardFilter.length > 0 && !yardFilter.includes(row.yardId)) return false;
      if (partFilter.length > 0 && !partFilter.includes(row.part)) return false;
      if (severityFilter.length > 0 && !severityFilter.includes(row.severity)) return false;
      if (stateFilter.length > 0 && !stateFilter.includes(row.state)) return false;
      if (lower && !`${row.switchCode} ${row.yardName} ${FAULT_TYPE_LABEL[row.type]}`.toLowerCase().includes(lower)) {
        return false;
      }
      return true;
    });
  }, [filter.faults, keyword, urlFilters]);

  const severityCounts = useMemo(() => countBySeverity(rows), [rows]);

  const openCreate = (): void => {
    setEditDialog({
      open: true,
      editingId: null,
      inspectionId: inspections[0]?.id ?? '',
      part: 'pointRail',
      type: 'wear',
      severity: 'light',
      sizeMm: '',
    });
  };

  const submitFault = async (): Promise<void> => {
    if (!editDialog.inspectionId) {
      setToast('请选择巡检批次');
      return;
    }
    const payload = {
      inspectionId: editDialog.inspectionId,
      part: editDialog.part,
      type: editDialog.type,
      severity: editDialog.severity,
      sizeMm: editDialog.sizeMm.trim() === '' ? null : Number(editDialog.sizeMm),
    };
    if (editDialog.editingId) {
      await dispatch(updateFault({ id: editDialog.editingId, draft: payload }));
      setToast('病害已更新');
    } else {
      await dispatch(createFault(payload));
      setToast('病害已新增');
    }
    setEditDialog((prev) => ({ ...prev, open: false, editingId: null }));
  };

  const toggleAll = (): void => {
    setSelected(selected.length === rows.length ? [] : rows.map((row) => row.id));
  };

  const exportCsv = (): void => {
    const header = ['站场', '道岔', '巡检日期', '部件', '类型', '等级', '尺寸(mm)', '状态', '销号时间', '作业单'];
    const body = rows.map((row) => [
      row.yardName,
      row.switchCode,
      row.inspectionDate,
      FAULT_PART_LABEL[row.part],
      FAULT_TYPE_LABEL[row.type],
      FAULT_SEVERITY_LABEL[row.severity],
      row.sizeMm ?? '',
      row.state === 'solved' ? '已销号' : '待修',
      row.solvedAt ?? '',
      row.workOrderCodes.join(' '),
    ]);
    downloadCsv(`gbrailswitch-faults-${nowDateTime().slice(0, 10)}.csv`, [header, ...body]);
    setToast('病害清单已导出 CSV');
  };

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap mb={1.5}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            病害评定与销号
          </Typography>
          <Typography variant="body2" color="text.secondary">
            评定等级、批量调整、手工销号与撤销；已编排天窗的病害会标注作业单号。
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" startIcon={<DownloadIcon />} onClick={exportCsv}>
            导出 CSV
          </Button>
          <Button variant="outlined" onClick={() => navigate(ROUTES.workorders)}>
            去天窗编排
          </Button>
          <Button variant="contained" onClick={openCreate}>
            新增病害
          </Button>
        </Stack>
      </Stack>

      <Grid container spacing={1.5} mb={1.75}>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge title="命中病害" value={rows.length} suffix="处" color="#1565c0" />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="待修"
            value={filter.counts.pending}
            suffix="处"
            percent={share(filter.counts.pending, filter.counts.total)}
            color="#d32f2f"
            hint="进度条为待修占比"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="销号率"
            value={filter.counts.total === 0 ? 0 : Number(((filter.counts.solved / filter.counts.total) * 100).toFixed(1))}
            suffix="%"
            color="#2e7d32"
            hint={`已销号 ${filter.counts.solved} 处`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="重 / 中 / 轻"
            value={`${severityCounts.heavy} / ${severityCounts.medium} / ${severityCounts.light}`}
            color="#ed6c02"
            hint="重级病害建议优先纳入天窗修"
          />
        </Grid>
      </Grid>

      <FilterBar
        keywordPlaceholder="按道岔 / 站场 / 类型搜索"
        selects={[
          {
            key: 'yard',
            label: '站场',
            options: [...new Set(rows.map((row) => row.yardId))].map((yardId) => ({
              label: rows.find((row) => row.yardId === yardId)?.yardName ?? yardId,
              value: yardId,
            })),
            width: 180,
          },
          {
            key: 'part',
            label: '部件',
            options: FAULT_PARTS.map((item) => ({ label: FAULT_PART_LABEL[item], value: item })),
            width: 160,
          },
          {
            key: 'severity',
            label: '等级',
            options: FAULT_SEVERITIES.map((item) => ({ label: FAULT_SEVERITY_LABEL[item], value: item })),
            width: 150,
          },
          {
            key: 'state',
            label: '状态',
            options: [
              { label: '待修', value: 'pending' },
              { label: '已销号', value: 'solved' },
            ],
            width: 160,
          },
        ]}
        resultCount={rows.length}
        countUnit="处病害"
      />

      <Paper variant="outlined" sx={{ borderRadius: 2, p: 1.5, mt: 1.75 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap mb={1.5}>
          <Chip label={`已选 ${selected.length} 处`} color={selected.length > 0 ? 'primary' : 'default'} />
          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel>批量等级</InputLabel>
            <Select
              label="批量等级"
              value={bulkSeverity}
              onChange={(event) => setBulkSeverity(event.target.value as FaultSeverity)}
            >
              {FAULT_SEVERITIES.map((item) => (
                <MenuItem key={item} value={item}>
                  {FAULT_SEVERITY_LABEL[item]}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button
            size="small"
            variant="contained"
            disabled={selected.length === 0}
            onClick={async () => {
              const result = await dispatch(bulkSetSeverity({ faultIds: selected, severity: bulkSeverity }));
              setToast(`已批量设置 ${result.payload ?? 0} 处病害等级为${FAULT_SEVERITY_LABEL[bulkSeverity]}`);
            }}
          >
            批量设置等级
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={<TrendingUpIcon />}
            disabled={selected.length === 0}
            onClick={async () => {
              const result = await dispatch(bulkEscalate(selected));
              setToast(`已升级 ${result.payload ?? 0} 处病害等级`);
            }}
          >
            批量升级一级
          </Button>
          <Button
            size="small"
            variant="outlined"
            color="success"
            startIcon={<DoneAllIcon />}
            disabled={selected.length === 0}
            onClick={async () => {
              for (const faultId of selected) {
                await dispatch(setFaultState({ faultId, state: 'solved' }));
              }
              setToast(`已手工销号 ${selected.length} 处病害`);
              setSelected([]);
            }}
          >
            批量销号
          </Button>
          <Button
            size="small"
            variant="outlined"
            color="warning"
            startIcon={<UndoIcon />}
            disabled={selected.length === 0}
            onClick={async () => {
              for (const faultId of selected) {
                await dispatch(setFaultState({ faultId, state: 'pending' }));
              }
              setToast(`已撤销销号 ${selected.length} 处病害`);
              setSelected([]);
            }}
          >
            撤销销号
          </Button>
          <Button size="small" disabled={selected.length === 0} onClick={() => setSelected([])}>
            清空选择
          </Button>
        </Stack>

        {rows.length === 0 ? (
          <EmptyPanel
            title="没有匹配的病害"
            description="可调整筛选条件，或先到巡检页录入病害。"
            createLabel="新增病害"
            onCreate={openCreate}
            resetLabel="重置筛选"
            onReset={() => {
              filter.resetFilters();
              setSelected([]);
            }}
          />
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Checkbox
                      indeterminate={selected.length > 0 && selected.length < rows.length}
                      checked={rows.length > 0 && selected.length === rows.length}
                      onChange={toggleAll}
                    />
                  </TableCell>
                  <TableCell>站场 / 道岔</TableCell>
                  <TableCell>巡检日期</TableCell>
                  <TableCell>部件</TableCell>
                  <TableCell>类型</TableCell>
                  <TableCell>等级</TableCell>
                  <TableCell>尺寸</TableCell>
                  <TableCell>状态</TableCell>
                  <TableCell>作业单</TableCell>
                  <TableCell align="right">操作</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} hover selected={selected.includes(row.id)}>
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={selected.includes(row.id)}
                        onChange={() =>
                          setSelected((prev) =>
                            prev.includes(row.id) ? prev.filter((item) => item !== row.id) : [...prev, row.id],
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>
                      {row.yardName} · {row.switchCode}
                    </TableCell>
                    <TableCell>{row.inspectionDate}</TableCell>
                    <TableCell>
                      <Tooltip title={PART_CHECK_HINT[row.part]}>
                        <span>{FAULT_PART_LABEL[row.part]}</span>
                      </Tooltip>
                    </TableCell>
                    <TableCell>{FAULT_TYPE_LABEL[row.type]}</TableCell>
                    <TableCell>
                      <SeverityTag severity={row.severity} sizeMm={row.sizeMm} />
                    </TableCell>
                    <TableCell>
                      <Tooltip title={sizeSeverityHint(row.sizeMm)}>
                        <span>{formatSizeMm(row.sizeMm)}</span>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={row.state === 'solved' ? 'success' : 'warning'}
                        label={row.state === 'solved' ? '已销号' : '待修'}
                      />
                      {row.solvedAt ? (
                        <Typography variant="caption" display="block" color="text.secondary">
                          {row.solvedAt}
                        </Typography>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {row.planned ? (
                        <Tooltip title={row.workOrderCodes.join('、')}>
                          <Chip size="small" color="info" label={`${row.workOrderCodes.length} 张`} />
                        </Tooltip>
                      ) : (
                        <Typography variant="caption" color="text.secondary">
                          未编排
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        onClick={() =>
                          setEditDialog({
                            open: true,
                            editingId: row.id,
                            inspectionId: row.inspectionId,
                            part: row.part,
                            type: row.type,
                            severity: row.severity,
                            sizeMm: row.sizeMm === null ? '' : String(row.sizeMm),
                          })
                        }
                      >
                        评定
                      </Button>
                      <Button
                        size="small"
                        color={row.state === 'solved' ? 'warning' : 'success'}
                        onClick={async () => {
                          await dispatch(
                            setFaultState({ faultId: row.id, state: row.state === 'solved' ? 'pending' : 'solved' }),
                          );
                          setToast(row.state === 'solved' ? '已撤销销号' : '已手工销号');
                        }}
                      >
                        {row.state === 'solved' ? '撤销' : '销号'}
                      </Button>
                      <Button
                        size="small"
                        color="error"
                        onClick={async () => {
                          await dispatch(deleteFault(row.id));
                          setToast('病害已删除');
                        }}
                      >
                        删除
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      <Dialog open={editDialog.open} onClose={() => setEditDialog((prev) => ({ ...prev, open: false }))} fullWidth maxWidth="sm">
        <DialogTitle>{editDialog.editingId ? '病害评定' : '新增病害'}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <FormControl fullWidth size="small">
              <InputLabel>巡检批次</InputLabel>
              <Select
                label="巡检批次"
                value={editDialog.inspectionId}
                onChange={(event) => setEditDialog((prev) => ({ ...prev, inspectionId: event.target.value }))}
              >
                {inspections.map((item) => (
                  <MenuItem key={item.id} value={item.id}>
                    {item.date} · {item.yardName} · {item.switchCode}（{item.inspector}）
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Grid container spacing={2}>
              <Grid item xs={6}>
                <FormControl fullWidth size="small">
                  <InputLabel>部件</InputLabel>
                  <Select
                    label="部件"
                    value={editDialog.part}
                    onChange={(event) => setEditDialog((prev) => ({ ...prev, part: event.target.value as FaultPart }))}
                  >
                    {FAULT_PARTS.map((item) => (
                      <MenuItem key={item} value={item}>
                        {FAULT_PART_LABEL[item]}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Grid>
              <Grid item xs={6}>
                <FormControl fullWidth size="small">
                  <InputLabel>类型</InputLabel>
                  <Select
                    label="类型"
                    value={editDialog.type}
                    onChange={(event) => setEditDialog((prev) => ({ ...prev, type: event.target.value as FaultType }))}
                  >
                    {FAULT_TYPES.map((item) => (
                      <MenuItem key={item} value={item}>
                        {FAULT_TYPE_LABEL[item]}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Grid>
              <Grid item xs={6}>
                <FormControl fullWidth size="small">
                  <InputLabel>等级</InputLabel>
                  <Select
                    label="等级"
                    value={editDialog.severity}
                    onChange={(event) =>
                      setEditDialog((prev) => ({ ...prev, severity: event.target.value as FaultSeverity }))
                    }
                  >
                    {FAULT_SEVERITIES.map((item) => (
                      <MenuItem key={item} value={item}>
                        {FAULT_SEVERITY_LABEL[item]}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Grid>
              <Grid item xs={6}>
                <TextField
                  fullWidth
                  size="small"
                  label="尺寸（mm）"
                  value={editDialog.sizeMm}
                  onChange={(event) => setEditDialog((prev) => ({ ...prev, sizeMm: event.target.value }))}
                />
              </Grid>
            </Grid>
            <Typography variant="caption" color="text.secondary">
              {sizeSeverityHint(editDialog.sizeMm.trim() === '' ? null : Number(editDialog.sizeMm))} ·
              {switches.length} 组道岔在册
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditDialog((prev) => ({ ...prev, open: false }))}>取消</Button>
          <Button variant="contained" onClick={() => void submitFault()}>
            保存
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={2600}
        onClose={() => setToast('')}
        message={toast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}
