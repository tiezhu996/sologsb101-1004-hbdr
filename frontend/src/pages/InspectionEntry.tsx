/**
 * /inspections 巡检与病害录入
 * 按巡检批次录入病害并定位到部件；消费 Inspection、Fault、Switch 与 <FilterBar>、<SeverityTag>。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  Grid,
  IconButton,
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
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { useAppDispatch, useAppSelector } from '../hooks/useAppStore';
import {
  createFault,
  createInspection,
  deleteFault,
  deleteInspection,
  selectFaultViews,
  selectInspectionViews,
  updateFault,
  updateInspection,
} from '../stores/faultStore';
import { selectSwitchViews, selectYardViews } from '../stores/yardStore';
import {
  FAULT_PARTS,
  FAULT_PART_LABEL,
  FAULT_SEVERITIES,
  FAULT_SEVERITY_LABEL,
  FAULT_TYPES,
  FAULT_TYPE_LABEL,
  type FaultPart,
  type FaultSeverity,
  type FaultType,
} from '../types/fault';
import {
  METHOD_LABEL,
  WEATHER_LABEL,
  methodHint,
  weatherHint,
  type InspectMethod,
  type InspectionDraft,
  type Weather,
} from '../types/inspection';
import { nowDateTime, shiftDate, todayDate } from '../utils/window';
import { share } from '../utils/format';
import { formatSizeMm } from '../utils/severity';
import SeverityTag from '../components/common/SeverityTag';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar, { useFilterValues, useKeywordFilter } from '../components/common/FilterBar';

interface FaultDraftRow {
  key: string;
  part: FaultPart;
  type: FaultType;
  severity: FaultSeverity;
  sizeMm: string;
}

function newFaultRow(): FaultDraftRow {
  return {
    key: `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    part: 'pointRail',
    type: 'wear',
    severity: 'light',
    sizeMm: '',
  };
}

const EMPTY_INSPECTION: InspectionDraft = {
  switchId: '',
  date: todayDate(),
  inspector: '',
  weather: 'sunny',
  method: 'manual',
};

export default function InspectionEntry() {
  const dispatch = useAppDispatch();
  const inspections = useAppSelector(selectInspectionViews);
  const faults = useAppSelector(selectFaultViews);
  const switches = useAppSelector(selectSwitchViews);
  const yards = useAppSelector(selectYardViews);

  const keyword = useKeywordFilter();
  const filters = useFilterValues(['yard', 'switch', 'severity']);
  const [toast, setToast] = useState('');
  const [expandedId, setExpandedId] = useState<string>('');
  const [dialog, setDialog] = useState<{
    open: boolean;
    editingId: string | null;
    draft: InspectionDraft;
    rows: FaultDraftRow[];
  }>({ open: false, editingId: null, draft: EMPTY_INSPECTION, rows: [newFaultRow()] });
  const [faultDialog, setFaultDialog] = useState<{
    open: boolean;
    editingId: string | null;
    inspectionId: string;
    row: FaultDraftRow;
  }>({ open: false, editingId: null, inspectionId: '', row: newFaultRow() });

  const filtered = useMemo(() => {
    const lower = keyword.trim().toLowerCase();
    const yardFilter = filters.yard ?? [];
    const switchFilter = filters.switch ?? [];
    const severityFilter = (filters.severity ?? []) as FaultSeverity[];
    return inspections
      .filter((item) => {
        if (yardFilter.length > 0 && !yardFilter.includes(item.yardId)) return false;
        if (switchFilter.length > 0 && !switchFilter.includes(item.switchId)) return false;
        if (severityFilter.length > 0) {
          const owned = faults.filter((fault) => fault.inspectionId === item.id);
          if (!owned.some((fault) => severityFilter.includes(fault.severity))) return false;
        }
        if (lower && !`${item.switchCode} ${item.yardName} ${item.inspector}`.toLowerCase().includes(lower)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [inspections, faults, keyword, filters]);

  const totals = useMemo(() => {
    const totalFaults = faults.length;
    const severe = faults.filter((item) => item.severity === 'heavy').length;
    const todayCount = inspections.filter((item) => item.date === todayDate()).length;
    const week = inspections.filter((item) => item.date >= shiftDate(-7)).length;
    return { total: inspections.length, totalFaults, severe, todayCount, week };
  }, [inspections, faults]);

  const openCreate = (): void => {
    setDialog({
      open: true,
      editingId: null,
      draft: { ...EMPTY_INSPECTION, switchId: switches[0]?.id ?? '', inspector: '赵铁军' },
      rows: [newFaultRow()],
    });
  };

  const openEdit = (inspectionId: string): void => {
    const target = inspections.find((item) => item.id === inspectionId);
    if (!target) return;
    setDialog({
      open: true,
      editingId: inspectionId,
      draft: {
        switchId: target.switchId,
        date: target.date,
        inspector: target.inspector,
        weather: target.weather,
        method: target.method,
      },
      rows: faults
        .filter((item) => item.inspectionId === inspectionId)
        .map((item) => ({
          key: item.id,
          part: item.part,
          type: item.type,
          severity: item.severity,
          sizeMm: item.sizeMm === null ? '' : String(item.sizeMm),
        })),
    });
  };

  const submitInspection = async (): Promise<void> => {
    if (!dialog.draft.switchId) {
      setToast('请选择道岔');
      return;
    }
    if (!dialog.draft.inspector.trim()) {
      setToast('请填写巡检人');
      return;
    }
    const validRows = dialog.rows.filter((row) => row.part && row.type);
    const mapped = validRows.map((row) => ({
      inspectionId: dialog.editingId ?? '',
      part: row.part,
      type: row.type,
      severity: row.severity,
      sizeMm: row.sizeMm.trim() === '' ? null : Number(row.sizeMm),
    }));

    if (dialog.editingId) {
      await dispatch(updateInspection({ id: dialog.editingId, draft: dialog.draft }));
      // 已存在的病害按 id 更新，新增的行走 createFault
      const existingIds = faults
        .filter((item) => item.inspectionId === dialog.editingId)
        .map((item) => item.id);
      const keepKeys = dialog.rows.map((row) => row.key);
      for (const faultId of existingIds) {
        if (!keepKeys.includes(faultId)) await dispatch(deleteFault(faultId));
      }
      for (const row of validRows) {
        const isExisting = existingIds.includes(row.key);
        const payload = {
          inspectionId: dialog.editingId,
          part: row.part,
          type: row.type,
          severity: row.severity,
          sizeMm: row.sizeMm.trim() === '' ? null : Number(row.sizeMm),
        };
        if (isExisting) await dispatch(updateFault({ id: row.key, draft: payload }));
        else await dispatch(createFault(payload));
      }
      setToast('巡检批次与病害已更新');
    } else {
      await dispatch(createInspection({ ...dialog.draft, faults: mapped }));
      setToast(`巡检已登记，同步录入 ${mapped.length} 条病害`);
    }
    setDialog({ open: false, editingId: null, draft: EMPTY_INSPECTION, rows: [newFaultRow()] });
  };

  const submitFault = async (): Promise<void> => {
    const payload = {
      inspectionId: faultDialog.inspectionId,
      part: faultDialog.row.part,
      type: faultDialog.row.type,
      severity: faultDialog.row.severity,
      sizeMm: faultDialog.row.sizeMm.trim() === '' ? null : Number(faultDialog.row.sizeMm),
    };
    if (faultDialog.editingId) {
      await dispatch(updateFault({ id: faultDialog.editingId, draft: payload }));
      setToast('病害已更新');
    } else {
      await dispatch(createFault(payload));
      setToast('病害已新增到该巡检批次');
    }
    setFaultDialog({ open: false, editingId: null, inspectionId: '', row: newFaultRow() });
  };

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap mb={1.5}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            巡检与病害录入
          </Typography>
          <Typography variant="body2" color="text.secondary">
            按巡检批次录入病害并定位到部件（尖轨 / 基本轨 / 辙叉 / 转辙机）。
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" href="#/faults" onClick={() => undefined}>
            去病害评定
          </Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
            登记巡检批次
          </Button>
        </Stack>
      </Stack>

      <Grid container spacing={1.5} mb={1.75}>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge title="巡检批次" value={totals.total} suffix="批" color="#1565c0" />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge title="累计病害" value={totals.totalFaults} suffix="处" color="#00897b" />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="重级病害"
            value={totals.severe}
            suffix="处"
            percent={share(totals.severe, totals.totalFaults)}
            color="#d32f2f"
            hint="进度条为重级占比，建议优先编排天窗修"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge title="近 7 日巡检" value={totals.week} suffix="批" color="#ed6c02" hint={`今日 ${totals.todayCount} 批`} />
        </Grid>
      </Grid>

      <FilterBar
        keywordPlaceholder="按道岔 / 站场 / 巡检人搜索"
        selects={[
          { key: 'yard', label: '站场', options: yards.map((item) => ({ label: item.name, value: item.id })), width: 180 },
          {
            key: 'switch',
            label: '道岔',
            options: switches.map((item) => ({ label: `${item.yardName} ${item.code}`, value: item.id })),
            width: 200,
          },
          {
            key: 'severity',
            label: '病害等级',
            options: FAULT_SEVERITIES.map((item) => ({ label: FAULT_SEVERITY_LABEL[item], value: item })),
            width: 170,
          },
        ]}
        resultCount={filtered.length}
        countUnit="批巡检"
      />

      <Box mt={1.75}>
        {filtered.length === 0 ? (
          <EmptyPanel
            title="暂无巡检记录"
            description="登记一次巡检批次，并在同一批次内录入多条病害。"
            createLabel="登记巡检批次"
            onCreate={openCreate}
          />
        ) : (
          <Stack spacing={1.5}>
            {filtered.map((inspection) => {
              const owned = faults
                .filter((item) => item.inspectionId === inspection.id)
                .sort((a, b) => (a.severity < b.severity ? 1 : -1));
              const expanded = expandedId === inspection.id;
              return (
                <Paper key={inspection.id} variant="outlined" sx={{ borderRadius: 2 }}>
                  <Stack
                    direction="row"
                    alignItems="center"
                    justifyContent="space-between"
                    flexWrap="wrap"
                    useFlexGap
                    sx={{ p: 1.5, cursor: 'pointer' }}
                    onClick={() => setExpandedId(expanded ? '' : inspection.id)}
                  >
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                      <IconButton size="small">{expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}</IconButton>
                      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                        {inspection.yardName} · {inspection.switchCode}
                      </Typography>
                      <Chip size="small" label={`${inspection.date}`} />
                      <Chip size="small" variant="outlined" label={WEATHER_LABEL[inspection.weather]} />
                      <Chip size="small" variant="outlined" label={METHOD_LABEL[inspection.method]} />
                      <Chip size="small" label={`巡检人 ${inspection.inspector}`} />
                      <Chip
                        size="small"
                        color={inspection.severeCount > 0 ? 'error' : inspection.pendingCount > 0 ? 'warning' : 'success'}
                        label={`病害 ${inspection.faultCount} 处 / 待修 ${inspection.pendingCount}`}
                      />
                    </Stack>
                    <Stack direction="row" spacing={0.5}>
                      <Button
                        size="small"
                        onClick={(event) => {
                          event.stopPropagation();
                          setFaultDialog({
                            open: true,
                            editingId: null,
                            inspectionId: inspection.id,
                            row: newFaultRow(),
                          });
                        }}
                      >
                        追加病害
                      </Button>
                      <IconButton
                        size="small"
                        onClick={(event) => {
                          event.stopPropagation();
                          openEdit(inspection.id);
                        }}
                      >
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton
                        size="small"
                        color="error"
                        onClick={async (event) => {
                          event.stopPropagation();
                          await dispatch(deleteInspection(inspection.id));
                          setToast('巡检及其病害已删除');
                        }}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Stack>
                  </Stack>

                  {expanded ? (
                    <Box sx={{ px: 1.5, pb: 1.5 }}>
                      <Alert severity={inspection.severeCount > 0 ? 'error' : 'info'} sx={{ mb: 1 }}>
                        {weatherHint(inspection.weather)}；{methodHint(inspection.method)}
                      </Alert>
                      {owned.length === 0 ? (
                        <EmptyPanel
                          title="该批次未录入病害"
                          description="可追加病害，记录部件、类型、等级与尺寸。"
                          createLabel="追加病害"
                          onCreate={() =>
                            setFaultDialog({ open: true, editingId: null, inspectionId: inspection.id, row: newFaultRow() })
                          }
                        />
                      ) : (
                        <TableContainer component={Paper} variant="outlined">
                          <Table size="small">
                            <TableHead>
                              <TableRow>
                                <TableCell>部件</TableCell>
                                <TableCell>类型</TableCell>
                                <TableCell>等级</TableCell>
                                <TableCell>尺寸</TableCell>
                                <TableCell>状态</TableCell>
                                <TableCell align="right">操作</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {owned.map((fault) => (
                                <TableRow key={fault.id} hover>
                                  <TableCell>{FAULT_PART_LABEL[fault.part]}</TableCell>
                                  <TableCell>{FAULT_TYPE_LABEL[fault.type]}</TableCell>
                                  <TableCell>
                                    <SeverityTag severity={fault.severity} sizeMm={fault.sizeMm} />
                                  </TableCell>
                                  <TableCell>{formatSizeMm(fault.sizeMm)}</TableCell>
                                  <TableCell>
                                    <Chip
                                      size="small"
                                      variant="outlined"
                                      color={fault.state === 'solved' ? 'success' : 'warning'}
                                      label={fault.state === 'solved' ? '已销号' : '待修'}
                                    />
                                    {fault.planned ? (
                                      <Tooltip title={`已编排：${fault.workOrderCodes.join('、')}`}>
                                        <Chip size="small" sx={{ ml: 0.5 }} color="info" label="已编排" />
                                      </Tooltip>
                                    ) : null}
                                  </TableCell>
                                  <TableCell align="right">
                                    <IconButton
                                      size="small"
                                      onClick={() =>
                                        setFaultDialog({
                                          open: true,
                                          editingId: fault.id,
                                          inspectionId: inspection.id,
                                          row: {
                                            key: fault.id,
                                            part: fault.part,
                                            type: fault.type,
                                            severity: fault.severity,
                                            sizeMm: fault.sizeMm === null ? '' : String(fault.sizeMm),
                                          },
                                        })
                                      }
                                    >
                                      <EditIcon fontSize="small" />
                                    </IconButton>
                                    <IconButton
                                      size="small"
                                      color="error"
                                      onClick={async () => {
                                        await dispatch(deleteFault(fault.id));
                                        setToast('病害已删除');
                                      }}
                                    >
                                      <DeleteIcon fontSize="small" />
                                    </IconButton>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </TableContainer>
                      )}
                    </Box>
                  ) : null}
                </Paper>
              );
            })}
          </Stack>
        )}
      </Box>

      {/* 巡检批次表单 */}
      <Dialog
        open={dialog.open}
        onClose={() => setDialog({ open: false, editingId: null, draft: EMPTY_INSPECTION, rows: [newFaultRow()] })}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>{dialog.editingId ? '编辑巡检批次' : '登记巡检批次'}</DialogTitle>
        <DialogContent dividers>
          <Grid container spacing={2} mt={0.5}>
            <Grid item xs={12} md={6}>
              <FormControl fullWidth size="small">
                <InputLabel>道岔</InputLabel>
                <Select
                  label="道岔"
                  value={dialog.draft.switchId}
                  onChange={(event) => setDialog((prev) => ({ ...prev, draft: { ...prev.draft, switchId: event.target.value } }))}
                >
                  {switches.map((item) => (
                    <MenuItem key={item.id} value={item.id}>
                      {item.yardName} · {item.code}（{item.frogNumber} 号 / {item.railType}）
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} md={6}>
              <TextField
                fullWidth
                size="small"
                type="date"
                label="巡检日期"
                InputLabelProps={{ shrink: true }}
                value={dialog.draft.date}
                onChange={(event) => setDialog((prev) => ({ ...prev, draft: { ...prev.draft, date: event.target.value } }))}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                size="small"
                label="巡检人"
                value={dialog.draft.inspector}
                onChange={(event) => setDialog((prev) => ({ ...prev, draft: { ...prev.draft, inspector: event.target.value } }))}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth size="small">
                <InputLabel>气象条件</InputLabel>
                <Select
                  label="气象条件"
                  value={dialog.draft.weather}
                  onChange={(event) =>
                    setDialog((prev) => ({ ...prev, draft: { ...prev.draft, weather: event.target.value as Weather } }))
                  }
                >
                  {(Object.keys(WEATHER_LABEL) as Weather[]).map((key) => (
                    <MenuItem key={key} value={key}>
                      {WEATHER_LABEL[key]}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth size="small">
                <InputLabel>检查方式</InputLabel>
                <Select
                  label="检查方式"
                  value={dialog.draft.method}
                  onChange={(event) =>
                    setDialog((prev) => ({
                      ...prev,
                      draft: { ...prev.draft, method: event.target.value as InspectMethod },
                    }))
                  }
                >
                  {(Object.keys(METHOD_LABEL) as InspectMethod[]).map((key) => (
                    <MenuItem key={key} value={key}>
                      {METHOD_LABEL[key]}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
          </Grid>

          <Divider sx={{ my: 2 }} />

          <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
            <Typography variant="subtitle2">本批次病害（{dialog.rows.length} 条）</Typography>
            <Button
              size="small"
              startIcon={<AddIcon />}
              onClick={() => setDialog((prev) => ({ ...prev, rows: [...prev.rows, newFaultRow()] }))}
            >
              增加一条
            </Button>
          </Stack>

          <Stack spacing={1.25}>
            {dialog.rows.map((row, index) => (
              <Paper key={row.key} variant="outlined" sx={{ p: 1.25 }}>
                <Grid container spacing={1.25} alignItems="center">
                  <Grid item xs={12} md={3}>
                    <FormControl fullWidth size="small">
                      <InputLabel>部件</InputLabel>
                      <Select
                        label="部件"
                        value={row.part}
                        onChange={(event) =>
                          setDialog((prev) => ({
                            ...prev,
                            rows: prev.rows.map((item) =>
                              item.key === row.key ? { ...item, part: event.target.value as FaultPart } : item,
                            ),
                          }))
                        }
                      >
                        {FAULT_PARTS.map((part) => (
                          <MenuItem key={part} value={part}>
                            {FAULT_PART_LABEL[part]}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </Grid>
                  <Grid item xs={12} md={3}>
                    <FormControl fullWidth size="small">
                      <InputLabel>类型</InputLabel>
                      <Select
                        label="类型"
                        value={row.type}
                        onChange={(event) =>
                          setDialog((prev) => ({
                            ...prev,
                            rows: prev.rows.map((item) =>
                              item.key === row.key ? { ...item, type: event.target.value as FaultType } : item,
                            ),
                          }))
                        }
                      >
                        {FAULT_TYPES.map((type) => (
                          <MenuItem key={type} value={type}>
                            {FAULT_TYPE_LABEL[type]}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </Grid>
                  <Grid item xs={12} md={2}>
                    <FormControl fullWidth size="small">
                      <InputLabel>等级</InputLabel>
                      <Select
                        label="等级"
                        value={row.severity}
                        onChange={(event) =>
                          setDialog((prev) => ({
                            ...prev,
                            rows: prev.rows.map((item) =>
                              item.key === row.key ? { ...item, severity: event.target.value as FaultSeverity } : item,
                            ),
                          }))
                        }
                      >
                        {FAULT_SEVERITIES.map((severity) => (
                          <MenuItem key={severity} value={severity}>
                            {FAULT_SEVERITY_LABEL[severity]}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </Grid>
                  <Grid item xs={12} md={3}>
                    <TextField
                      fullWidth
                      size="small"
                      label="尺寸（mm）"
                      value={row.sizeMm}
                      onChange={(event) =>
                        setDialog((prev) => ({
                          ...prev,
                          rows: prev.rows.map((item) =>
                            item.key === row.key ? { ...item, sizeMm: event.target.value } : item,
                          ),
                        }))
                      }
                    />
                  </Grid>
                  <Grid item xs={12} md={1}>
                    <IconButton
                      color="error"
                      size="small"
                      onClick={() =>
                        setDialog((prev) => ({
                          ...prev,
                          rows: prev.rows.length > 1 ? prev.rows.filter((item) => item.key !== row.key) : prev.rows,
                        }))
                      }
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Grid>
                  <Grid item xs={12}>
                    <Typography variant="caption" color="text.secondary">
                      #{index + 1} · {FAULT_PART_LABEL[row.part]}：{weatherHint(dialog.draft.weather)}
                    </Typography>
                  </Grid>
                </Grid>
              </Paper>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog({ open: false, editingId: null, draft: EMPTY_INSPECTION, rows: [newFaultRow()] })}>
            取消
          </Button>
          <Button variant="contained" onClick={() => void submitInspection()}>
            保存
          </Button>
        </DialogActions>
      </Dialog>

      {/* 单条病害表单 */}
      <Dialog
        open={faultDialog.open}
        onClose={() => setFaultDialog({ open: false, editingId: null, inspectionId: '', row: newFaultRow() })}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{faultDialog.editingId ? '编辑病害' : '追加病害'}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <FormControl fullWidth size="small">
              <InputLabel>部件</InputLabel>
              <Select
                label="部件"
                value={faultDialog.row.part}
                onChange={(event) =>
                  setFaultDialog((prev) => ({ ...prev, row: { ...prev.row, part: event.target.value as FaultPart } }))
                }
              >
                {FAULT_PARTS.map((part) => (
                  <MenuItem key={part} value={part}>
                    {FAULT_PART_LABEL[part]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth size="small">
              <InputLabel>病害类型</InputLabel>
              <Select
                label="病害类型"
                value={faultDialog.row.type}
                onChange={(event) =>
                  setFaultDialog((prev) => ({ ...prev, row: { ...prev.row, type: event.target.value as FaultType } }))
                }
              >
                {FAULT_TYPES.map((type) => (
                  <MenuItem key={type} value={type}>
                    {FAULT_TYPE_LABEL[type]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth size="small">
              <InputLabel>等级</InputLabel>
              <Select
                label="等级"
                value={faultDialog.row.severity}
                onChange={(event) =>
                  setFaultDialog((prev) => ({
                    ...prev,
                    row: { ...prev.row, severity: event.target.value as FaultSeverity },
                  }))
                }
              >
                {FAULT_SEVERITIES.map((severity) => (
                  <MenuItem key={severity} value={severity}>
                    {FAULT_SEVERITY_LABEL[severity]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              label="尺寸（mm）"
              value={faultDialog.row.sizeMm}
              onChange={(event) => setFaultDialog((prev) => ({ ...prev, row: { ...prev.row, sizeMm: event.target.value } }))}
              helperText="磨耗 / 掉块类填写实测尺寸；裂纹与螺栓松动可留空"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setFaultDialog({ open: false, editingId: null, inspectionId: '', row: newFaultRow() })}>
            取消
          </Button>
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
      <Typography variant="caption" color="text.secondary" display="block" mt={2}>
        当前时间基准：{nowDateTime()} · 病害录入后可在「病害评定与销号」页批量调整等级与销号。
      </Typography>
    </Box>
  );
}
