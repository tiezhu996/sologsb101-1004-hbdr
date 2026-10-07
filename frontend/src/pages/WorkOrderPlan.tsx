/**
 * /workorders 天窗作业单编排
 * 勾选病害成单、分配时间窗 / 人员 / 机具并做冲突校验；
 * 消费 WorkOrder、Fault 与 <StatBadge>。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
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
  ListItemText,
  MenuItem,
  OutlinedInput,
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
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { useAppDispatch, useAppSelector } from '../hooks/useAppStore';
import {
  clearFaultSelection,
  createWorkOrder,
  deleteWorkOrder,
  selectPlanableFaults,
  selectWindowStats,
  selectWorkOrderViews,
  setFaultSelection,
  updateWorkOrder,
} from '../stores/workOrderStore';
import {
  MACHINE_LIBRARY,
  MEMBER_LIBRARY,
  WORK_ORDER_STATE_FLOW,
  WORK_ORDER_STATE_LABEL,
  buildWorkOrderCode,
  type WorkOrderView,
} from '../types/workOrder';
import { FAULT_SEVERITY_LABEL, type FaultSeverity } from '../types/fault';
import { ROUTES } from '../router/routes';
import { endTimeOf, findMachineConflicts, findMemberConflicts, formatDuration, nowDateTime, windowMinutes } from '../utils/window';
import { share } from '../utils/format';
import { SEVERITY_HEX } from '../utils/severity';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import SeverityTag from '../components/common/SeverityTag';

interface OrderFormState {
  code: string;
  windowStart: string;
  windowEnd: string;
  leader: string;
  machines: string[];
  members: string[];
  faultIds: string[];
}

function defaultForm(): OrderFormState {
  const start = `${nowDateTime().slice(0, 10)} 09:00`;
  return {
    code: buildWorkOrderCode(new Date(), Math.floor(Math.random() * 90) + 10),
    windowStart: start,
    windowEnd: endTimeOf(start, 120),
    leader: MEMBER_LIBRARY[0],
    machines: ['道尺', '捣固镐'],
    members: [MEMBER_LIBRARY[0], MEMBER_LIBRARY[1]],
    faultIds: [],
  };
}

export default function WorkOrderPlan() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const orders = useAppSelector(selectWorkOrderViews);
  const planable = useAppSelector(selectPlanableFaults);
  const stats = useAppSelector(selectWindowStats);
  const allOrderRows = useAppSelector((state) => state.workOrder.workOrders);

  const [toast, setToast] = useState('');
  const [selectedFaults, setSelectedFaults] = useState<string[]>([]);
  const [dialog, setDialog] = useState<{ open: boolean; editingId: string | null; form: OrderFormState }>({
    open: false,
    editingId: null,
    form: defaultForm(),
  });

  /** 当前表单的冲突预检结果 */
  const draftConflicts = useMemo(() => {
    const others = allOrderRows
      .filter((item) => item.id !== dialog.editingId)
      .map((item) => ({
        id: item.id,
        code: item.code,
        windowStart: item.windowStart,
        windowEnd: item.windowEnd,
        members: item.members,
        machines: item.machines,
      }));
    const target = {
      id: dialog.editingId ?? 'draft',
      windowStart: dialog.form.windowStart,
      windowEnd: dialog.form.windowEnd,
      members: dialog.form.members,
      machines: dialog.form.machines,
    };
    const timeConflicts = others.filter(
      (item) => item.windowStart < target.windowEnd && target.windowStart < item.windowEnd,
    );
    const memberConflicts = findMemberConflicts(
      { id: target.id, windowStart: target.windowStart, windowEnd: target.windowEnd, members: target.members },
      others,
    );
    const machineConflicts = findMachineConflicts(
      { id: target.id, windowStart: target.windowStart, windowEnd: target.windowEnd, machines: target.machines },
      others,
    );
    return {
      time: timeConflicts.map((item) => item.code),
      members: memberConflicts,
      machines: machineConflicts,
      duration: windowMinutes({ windowStart: target.windowStart, windowEnd: target.windowEnd }),
    };
  }, [allOrderRows, dialog]);

  const openCreate = (): void => {
    const next = defaultForm();
    next.faultIds = selectedFaults;
    setDialog({ open: true, editingId: null, form: next });
  };

  const openEdit = (order: WorkOrderView): void => {
    setDialog({
      open: true,
      editingId: order.id,
      form: {
        code: order.code,
        windowStart: order.windowStart,
        windowEnd: order.windowEnd,
        leader: order.leader,
        machines: order.machines,
        members: order.members,
        faultIds: order.faultIds,
      },
    });
  };

  const submit = async (): Promise<void> => {
    if (!dialog.form.leader.trim()) {
      setToast('请选择负责人');
      return;
    }
    if (dialog.form.faultIds.length === 0) {
      setToast('请至少关联一处病害');
      return;
    }
    if (windowMinutes({ windowStart: dialog.form.windowStart, windowEnd: dialog.form.windowEnd }) <= 0) {
      setToast('天窗止必须晚于天窗起');
      return;
    }
    if (dialog.editingId) {
      await dispatch(updateWorkOrder({ id: dialog.editingId, draft: dialog.form }));
      setToast('作业单已更新');
    } else {
      try {
        const result = await dispatch(createWorkOrder(dialog.form)).unwrap();
        setToast(
          result.conflicts.length > 0
            ? `作业单已创建，但与 ${result.conflicts.join('、')} 时间窗重叠，请复核`
            : '作业单已创建',
        );
      } catch (error) {
        setToast(`建单失败：${error instanceof Error ? error.message : '未知错误'}`);
        return;
      }
      dispatch(clearFaultSelection());
    }
    setDialog((prev) => ({ ...prev, open: false, editingId: null }));
  };

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap mb={1.5}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            天窗作业单编排
          </Typography>
          <Typography variant="body2" color="text.secondary">
            勾选待修病害成单，分配天窗时间窗、负责人、作业人员与机具，并做时间窗 / 人员 / 机具三重冲突校验。
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" onClick={() => navigate(ROUTES.progress)}>
            去进度与销号回写
          </Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
            新建作业单
          </Button>
        </Stack>
      </Stack>

      <Grid container spacing={1.5} mb={1.75}>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge title="作业单总数" value={stats.total} suffix="张" color="#1565c0" />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="天窗占用率"
            value={stats.occupationRate}
            suffix="%"
            percent={stats.occupationRate}
            color="#00897b"
            hint={`累计占用 ${formatDuration(stats.minutes)}（按每日 180 分钟基准）`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="时间窗冲突"
            value={stats.conflictCount}
            suffix="张"
            color={stats.conflictCount > 0 ? '#d32f2f' : '#2e7d32'}
            hint="同一时间窗内存在重叠作业单"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="待编排病害"
            value={planable.length}
            suffix="处"
            color="#ed6c02"
            hint={`已完成 ${stats.doneCount} 张作业单`}
          />
        </Grid>
      </Grid>

      <Grid container spacing={1.75}>
        <Grid item xs={12} lg={7}>
          <Paper variant="outlined" sx={{ borderRadius: 2, p: 1.5 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
              <Typography variant="subtitle1" fontWeight={600}>
                待编排病害（未销号且未编排）
              </Typography>
              <Stack direction="row" spacing={1}>
                <Button size="small" onClick={() => setSelectedFaults(planable.map((item) => item.id))}>
                  全选
                </Button>
                <Button size="small" onClick={() => setSelectedFaults([])}>
                  清空
                </Button>
                <Button size="small" variant="contained" disabled={selectedFaults.length === 0} onClick={openCreate}>
                  用选中病害建单（{selectedFaults.length}）
                </Button>
              </Stack>
            </Stack>

            {planable.length === 0 ? (
              <EmptyPanel
                title="没有待编排病害"
                description="所有待修病害都已编排进作业单，或已在病害页销号。"
                extra={
                  <Button variant="contained" onClick={() => navigate(ROUTES.faults)}>
                    去病害评定
                  </Button>
                }
              />
            ) : (
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell padding="checkbox">
                        <Checkbox
                          indeterminate={selectedFaults.length > 0 && selectedFaults.length < planable.length}
                          checked={planable.length > 0 && selectedFaults.length === planable.length}
                          onChange={() =>
                            setSelectedFaults(
                              selectedFaults.length === planable.length ? [] : planable.map((item) => item.id),
                            )
                          }
                        />
                      </TableCell>
                      <TableCell>病害</TableCell>
                      <TableCell>等级</TableCell>
                      <TableCell align="right">操作</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {planable.map((item) => (
                      <TableRow key={item.id} hover selected={selectedFaults.includes(item.id)}>
                        <TableCell padding="checkbox">
                          <Checkbox
                            checked={selectedFaults.includes(item.id)}
                            onChange={() =>
                              setSelectedFaults((prev) =>
                                prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id],
                              )
                            }
                          />
                        </TableCell>
                        <TableCell>{item.label}</TableCell>
                        <TableCell>
                          <SeverityTag severity={item.severity as FaultSeverity} />
                        </TableCell>
                        <TableCell align="right">
                          <Button
                            size="small"
                            onClick={() => {
                              setSelectedFaults([item.id]);
                              const next = defaultForm();
                              next.faultIds = [item.id];
                              setDialog({ open: true, editingId: null, form: next });
                            }}
                          >
                            单独建单
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>
        </Grid>

        <Grid item xs={12} lg={5}>
          <Paper variant="outlined" sx={{ borderRadius: 2, p: 1.5 }}>
            <Typography variant="subtitle1" fontWeight={600} mb={1}>
              已编排作业单（{orders.length}）
            </Typography>
            {orders.length === 0 ? (
              <EmptyPanel title="暂无作业单" description="勾选左侧病害后建单，系统会做冲突校验。" />
            ) : (
              <Stack spacing={1.25}>
                {orders.map((order) => (
                  <Paper key={order.id} variant="outlined" sx={{ p: 1.25 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" useFlexGap>
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                        <Typography variant="subtitle2" fontWeight={600}>
                          {order.code}
                        </Typography>
                        <Chip size="small" label={WORK_ORDER_STATE_LABEL[order.state]} color={order.state === 'done' ? 'success' : 'default'} />
                        {order.conflict ? (
                          <Tooltip title={`与 ${order.conflictCodes.join('、')} 时间窗重叠`}>
                            <Chip size="small" color="error" icon={<WarningAmberIcon />} label="时间窗冲突" />
                          </Tooltip>
                        ) : null}
                        {order.memberConflict ? <Chip size="small" color="warning" label="人员占用冲突" /> : null}
                        {order.machineConflict ? <Chip size="small" color="warning" label="机具占用冲突" /> : null}
                      </Stack>
                      <Stack direction="row" spacing={0.5}>
                        <Button size="small" startIcon={<EditIcon />} onClick={() => openEdit(order)}>
                          编辑
                        </Button>
                        <Button
                          size="small"
                          color="error"
                          startIcon={<DeleteIcon />}
                          onClick={async () => {
                            await dispatch(deleteWorkOrder(order.id));
                            setToast('作业单已删除');
                          }}
                        >
                          删除
                        </Button>
                      </Stack>
                    </Stack>
                    <Typography variant="caption" color="text.secondary" display="block" mt={0.5}>
                      天窗 {order.windowStart} ~ {order.windowEnd.slice(-5)}（{formatDuration(order.durationMinutes)}）· 负责人{' '}
                      {order.leader}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block">
                      关联病害 {order.faultIds.length} 处（待销号 {order.pendingFaultCount}）· 涉及站场{' '}
                      {order.yardNames.join('、') || '—'}
                    </Typography>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap mt={0.75}>
                      {order.members.map((member) => (
                        <Chip key={member} size="small" variant="outlined" label={`人 ${member}`} />
                      ))}
                      {order.machines.map((machine) => (
                        <Chip key={machine} size="small" variant="outlined" color="info" label={`机具 ${machine}`} />
                      ))}
                    </Stack>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap mt={0.75}>
                      {order.faultLabels.slice(0, 4).map((label) => (
                        <Chip key={label} size="small" label={label} sx={{ borderColor: SEVERITY_HEX.light }} />
                      ))}
                      {order.faultLabels.length > 4 ? <Chip size="small" label={`+${order.faultLabels.length - 4}`} /> : null}
                    </Stack>
                    {WORK_ORDER_STATE_FLOW[order.state].length > 0 ? (
                      <Typography variant="caption" color="text.secondary" display="block" mt={0.5}>
                        下一步可推进为：{WORK_ORDER_STATE_FLOW[order.state].map((item) => WORK_ORDER_STATE_LABEL[item]).join('、')}
                      </Typography>
                    ) : null}
                  </Paper>
                ))}
              </Stack>
            )}
          </Paper>
        </Grid>
      </Grid>

      {/* 作业单表单 */}
      <Dialog open={dialog.open} onClose={() => setDialog((prev) => ({ ...prev, open: false }))} fullWidth maxWidth="md">
        <DialogTitle>{dialog.editingId ? '编辑天窗作业单' : '新建天窗作业单'}</DialogTitle>
        <DialogContent dividers>
          <Grid container spacing={2} mt={0.5}>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                size="small"
                label="作业单编号"
                value={dialog.form.code}
                onChange={(event) => setDialog((prev) => ({ ...prev, form: { ...prev.form, code: event.target.value } }))}
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                size="small"
                type="datetime-local"
                label="天窗起"
                InputLabelProps={{ shrink: true }}
                value={dialog.form.windowStart.replace(' ', 'T')}
                onChange={(event) =>
                  setDialog((prev) => ({
                    ...prev,
                    form: {
                      ...prev.form,
                      windowStart: event.target.value.replace('T', ' '),
                      windowEnd: endTimeOf(event.target.value.replace('T', ' '), draftConflicts.duration || 120),
                    },
                  }))
                }
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <TextField
                fullWidth
                size="small"
                type="datetime-local"
                label="天窗止"
                InputLabelProps={{ shrink: true }}
                value={dialog.form.windowEnd.replace(' ', 'T')}
                onChange={(event) =>
                  setDialog((prev) => ({
                    ...prev,
                    form: { ...prev.form, windowEnd: event.target.value.replace('T', ' ') },
                  }))
                }
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth size="small">
                <InputLabel>负责人</InputLabel>
                <Select
                  label="负责人"
                  value={dialog.form.leader}
                  onChange={(event) => setDialog((prev) => ({ ...prev, form: { ...prev.form, leader: event.target.value } }))}
                >
                  {[...new Set([...MEMBER_LIBRARY, ...dialog.form.members])].map((name) => (
                    <MenuItem key={name} value={name}>
                      {name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth size="small">
                <InputLabel>作业人员</InputLabel>
                <Select
                  multiple
                  label="作业人员"
                  value={dialog.form.members}
                  input={<OutlinedInput label="作业人员" />}
                  onChange={(event) =>
                    setDialog((prev) => ({
                      ...prev,
                      form: {
                        ...prev.form,
                        members: typeof event.target.value === 'string' ? [event.target.value] : event.target.value,
                      },
                    }))
                  }
                  renderValue={(selected) => (selected as string[]).join('、')}
                >
                  {MEMBER_LIBRARY.map((name) => (
                    <MenuItem key={name} value={name}>
                      <Checkbox checked={dialog.form.members.includes(name)} />
                      <ListItemText primary={name} />
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth size="small">
                <InputLabel>机具清单</InputLabel>
                <Select
                  multiple
                  label="机具清单"
                  value={dialog.form.machines}
                  input={<OutlinedInput label="机具清单" />}
                  onChange={(event) =>
                    setDialog((prev) => ({
                      ...prev,
                      form: {
                        ...prev.form,
                        machines: typeof event.target.value === 'string' ? [event.target.value] : event.target.value,
                      },
                    }))
                  }
                  renderValue={(selected) => (selected as string[]).join('、')}
                >
                  {MACHINE_LIBRARY.map((name) => (
                    <MenuItem key={name} value={name}>
                      <Checkbox checked={dialog.form.machines.includes(name)} />
                      <ListItemText primary={name} />
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>

            <Grid item xs={12}>
              <FormControl fullWidth size="small">
                <InputLabel>关联病害</InputLabel>
                <Select
                  multiple
                  label="关联病害"
                  value={dialog.form.faultIds}
                  input={<OutlinedInput label="关联病害" />}
                  onChange={(event) =>
                    setDialog((prev) => ({
                      ...prev,
                      form: {
                        ...prev.form,
                        faultIds: typeof event.target.value === 'string' ? [event.target.value] : event.target.value,
                      },
                    }))
                  }
                  renderValue={(selected) => `已选 ${(selected as string[]).length} 处病害`}
                >
                  {[
                    ...planable,
                    ...dialog.form.faultIds
                      .filter((id) => !planable.some((item) => item.id === id))
                      .map((id) => ({ id, label: `已编排病害 ${id}`, severity: 'medium' as FaultSeverity, state: 'pending' })),
                  ].map((item) => (
                    <MenuItem key={item.id} value={item.id}>
                      <Checkbox checked={dialog.form.faultIds.includes(item.id)} />
                      <ListItemText primary={item.label} secondary={`等级 ${FAULT_SEVERITY_LABEL[item.severity as FaultSeverity]}`} />
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>

            <Grid item xs={12}>
              <Alert
                severity={draftConflicts.time.length > 0 || draftConflicts.members.length > 0 ? 'warning' : 'success'}
              >
                冲突预检：时间窗重叠 {draftConflicts.time.length > 0 ? draftConflicts.time.join('、') : '无'} · 人员占用{' '}
                {draftConflicts.members.length > 0 ? draftConflicts.members.join('、') : '无'} · 机具占用{' '}
                {draftConflicts.machines.length > 0 ? draftConflicts.machines.join('、') : '无'} · 天窗时长{' '}
                {formatDuration(draftConflicts.duration)}
              </Alert>
            </Grid>

            <Grid item xs={12}>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() =>
                    setDialog((prev) => ({
                      ...prev,
                      form: { ...prev.form, windowEnd: endTimeOf(prev.form.windowStart, 120) },
                    }))
                  }
                >
                  按 120 分钟设置天窗止
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() =>
                    setDialog((prev) => ({
                      ...prev,
                      form: { ...prev.form, windowEnd: endTimeOf(prev.form.windowStart, 180) },
                    }))
                  }
                >
                  按 180 分钟设置天窗止
                </Button>
                <Button size="small" onClick={() => dispatch(setFaultSelection(selectedFaults))}>
                  同步左侧勾选（{selectedFaults.length}）
                </Button>
                <Button size="small" onClick={() => setSelectedFaults([])}>
                  重置勾选状态
                </Button>
              </Stack>
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog((prev) => ({ ...prev, open: false }))}>取消</Button>
          <Button variant="contained" onClick={() => void submit()}>
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
      <Typography variant="caption" color="text.secondary" display="block" mt={2}>
        当前时间基准 {nowDateTime()} · 天窗占用率按每日 180 分钟基准计算，占比 {share(stats.minutes, 180)}%。
      </Typography>
    </Box>
  );
}
