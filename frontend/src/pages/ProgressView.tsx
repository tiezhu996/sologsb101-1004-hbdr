/**
 * /progress 作业进度与销号回写
 * 按天窗批次更新作业状态，完成项自动回写病害销号；
 * 消费 WorkOrder、Fault、Inspection 与 <FilterBar>。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  Grid,
  LinearProgress,
  Paper,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn';
import DownloadIcon from '@mui/icons-material/Download';
import { useAppDispatch, useAppSelector } from '../hooks/useAppStore';
import { advanceWorkOrder, selectWindowStats, selectWorkOrderViews } from '../stores/workOrderStore';
import { selectFaultViews } from '../stores/faultStore';
import {
  WORK_ORDER_STATE_FLOW,
  WORK_ORDER_STATE_LABEL,
  type WorkOrderState,
} from '../types/workOrder';
import { FAULT_SEVERITY_LABEL } from '../types/fault';
import { ROUTES } from '../router/routes';
import { formatDuration, nowDateTime } from '../utils/window';
import { downloadCsv, share } from '../utils/format';
import { SEVERITY_HEX } from '../utils/severity';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar, { useFilterValues, useKeywordFilter } from '../components/common/FilterBar';

const STATE_ORDER: WorkOrderState[] = ['planned', 'issued', 'working', 'done'];

export default function ProgressView() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const orders = useAppSelector(selectWorkOrderViews);
  const faults = useAppSelector(selectFaultViews);
  const stats = useAppSelector(selectWindowStats);

  const keyword = useKeywordFilter();
  const filters = useFilterValues(['state', 'yard']);
  const [toast, setToast] = useState('');

  const rows = useMemo(() => {
    const lower = keyword.trim().toLowerCase();
    const stateFilter = (filters.state ?? []) as WorkOrderState[];
    const yardFilter = filters.yard ?? [];
    return orders
      .filter((order) => {
        if (stateFilter.length > 0 && !stateFilter.includes(order.state)) return false;
        if (yardFilter.length > 0 && !order.yardNames.some((name) => yardFilter.includes(name))) return false;
        if (lower && !`${order.code} ${order.leader} ${order.faultLabels.join(' ')}`.toLowerCase().includes(lower)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const byState = STATE_ORDER.indexOf(b.state) - STATE_ORDER.indexOf(a.state);
        if (byState !== 0) return byState;
        return a.windowStart.localeCompare(b.windowStart);
      });
  }, [orders, keyword, filters]);

  const overview = useMemo(() => {
    const done = orders.filter((item) => item.state === 'done').length;
    const working = orders.filter((item) => item.state === 'working').length;
    const issued = orders.filter((item) => item.state === 'issued').length;
    const planned = orders.filter((item) => item.state === 'planned').length;
    const pendingFaults = faults.filter((item) => item.state === 'pending').length;
    const solvedFaults = faults.filter((item) => item.state === 'solved').length;
    return {
      done,
      working,
      issued,
      planned,
      pendingFaults,
      solvedFaults,
      completion: orders.length === 0 ? 0 : Number(((done / orders.length) * 100).toFixed(1)),
      solveRate: faults.length === 0 ? 0 : Number(((solvedFaults / faults.length) * 100).toFixed(1)),
    };
  }, [orders, faults]);

  const advance = async (id: string, next: WorkOrderState, code: string): Promise<void> => {
    try {
      const result = await dispatch(advanceWorkOrder({ id, next })).unwrap();
      if (next === 'done') {
        setToast(`${code} 已完成，回写销号 ${result.solvedCount} 处病害`);
      } else {
        setToast(`${code} 已推进为「${WORK_ORDER_STATE_LABEL[next]}」`);
      }
    } catch (error) {
      setToast(`推进失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  const exportCsv = (): void => {
    const header = ['作业单', '状态', '天窗起', '天窗止', '时长(分钟)', '负责人', '作业人员', '机具', '关联病害', '待销号', '冲突'];
    const body = rows.map((order) => [
      order.code,
      WORK_ORDER_STATE_LABEL[order.state],
      order.windowStart,
      order.windowEnd,
      order.durationMinutes,
      order.leader,
      order.members.join(' '),
      order.machines.join(' '),
      order.faultIds.length,
      order.pendingFaultCount,
      order.conflict ? order.conflictCodes.join(' ') : '无',
    ]);
    downloadCsv(`gbrailswitch-progress-${nowDateTime().slice(0, 10)}.csv`, [header, ...body]);
    setToast('进度清单已导出 CSV');
  };

  const availableYards = useMemo(() => [...new Set(orders.flatMap((item) => item.yardNames))], [orders]);

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap mb={1.5}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            作业进度与销号回写
          </Typography>
          <Typography variant="body2" color="text.secondary">
            按天窗批次推进状态：待编排 → 已下达 → 作业中 → 已完成；推进到已完成时自动回写关联病害销号。
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" startIcon={<DownloadIcon />} onClick={exportCsv}>
            导出进度 CSV
          </Button>
          <Button variant="outlined" onClick={() => navigate(ROUTES.workorders)}>
            回编排台
          </Button>
        </Stack>
      </Stack>

      <Grid container spacing={1.5} mb={1.75}>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="作业完成率"
            value={overview.completion}
            suffix="%"
            percent={overview.completion}
            color="#2e7d32"
            hint={`已完成 ${overview.done} / 共 ${orders.length} 张`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="在办作业单"
            value={overview.working + overview.issued}
            suffix="张"
            color="#1565c0"
            hint={`已下达 ${overview.issued} · 作业中 ${overview.working} · 待编排 ${overview.planned}`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="病害销号率"
            value={overview.solveRate}
            suffix="%"
            percent={overview.solveRate}
            color="#00897b"
            hint={`已销号 ${overview.solvedFaults} 处 · 待修 ${overview.pendingFaults} 处`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="累计天窗时长"
            value={stats.minutes}
            suffix="分钟"
            color="#ed6c02"
            hint={`占用率 ${stats.occupationRate}%（基准 180 分钟/日）`}
          />
        </Grid>
      </Grid>

      <FilterBar
        keywordPlaceholder="按作业单号 / 负责人 / 病害搜索"
        selects={[
          {
            key: 'state',
            label: '作业状态',
            options: STATE_ORDER.map((item) => ({ label: WORK_ORDER_STATE_LABEL[item], value: item })),
            width: 180,
          },
          {
            key: 'yard',
            label: '涉及站场',
            options: availableYards.map((name) => ({ label: name, value: name })),
            width: 190,
          },
        ]}
        resultCount={rows.length}
        countUnit="张作业单"
      />

      <Box mt={1.75}>
        {rows.length === 0 ? (
          <EmptyPanel
            title="没有匹配的作业单"
            description="可到编排台新建作业单，或调整筛选条件。"
            extra={
              <Button variant="contained" onClick={() => navigate(ROUTES.workorders)}>
                去天窗编排
              </Button>
            }
          />
        ) : (
          <Stack spacing={1.5}>
            {rows.map((order) => {
              const progressPercent =
                order.state === 'done' ? 100 : order.state === 'working' ? 60 : order.state === 'issued' ? 30 : 10;
              const nextStates = WORK_ORDER_STATE_FLOW[order.state];
              const relatedFaults = faults.filter((item) => order.faultIds.includes(item.id));
              return (
                <Paper key={order.id} variant="outlined" sx={{ borderRadius: 2, p: 1.75 }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap>
                    <Box>
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                        <Typography variant="subtitle1" fontWeight={600}>
                          {order.code}
                        </Typography>
                        <Chip
                          size="small"
                          color={order.state === 'done' ? 'success' : order.state === 'working' ? 'info' : 'default'}
                          label={WORK_ORDER_STATE_LABEL[order.state]}
                        />
                        {order.conflict ? (
                          <Tooltip title={`与 ${order.conflictCodes.join('、')} 时间窗重叠`}>
                            <Chip size="small" color="error" label="时间窗冲突" />
                          </Tooltip>
                        ) : null}
                        <Chip size="small" variant="outlined" label={`负责人 ${order.leader}`} />
                      </Stack>
                      <Typography variant="caption" color="text.secondary" display="block" mt={0.5}>
                        天窗 {order.windowStart} ~ {order.windowEnd}（{formatDuration(order.durationMinutes)}）· 涉及站场{' '}
                        {order.yardNames.join('、') || '—'}
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                      {nextStates.map((next) => (
                        <Button
                          key={next}
                          size="small"
                          variant={next === 'done' ? 'contained' : 'outlined'}
                          color={next === 'done' ? 'success' : 'primary'}
                          startIcon={next === 'done' ? <AssignmentTurnedInIcon /> : <PlayArrowIcon />}
                          onClick={() => void advance(order.id, next, order.code)}
                        >
                          推进为{WORK_ORDER_STATE_LABEL[next]}
                        </Button>
                      ))}
                      {order.state === 'done' ? (
                        <Chip icon={<CheckCircleIcon />} color="success" label="已完成并回写销号" />
                      ) : null}
                    </Stack>
                  </Stack>

                  <Box mt={1.25}>
                    <LinearProgress
                      variant="determinate"
                      value={progressPercent}
                      sx={{ height: 8, borderRadius: 4 }}
                      color={order.state === 'done' ? 'success' : 'primary'}
                    />
                    <Typography variant="caption" color="text.secondary">
                      进度 {progressPercent}% · 关联病害 {order.faultIds.length} 处（待销号 {order.pendingFaultCount}）· 作业人员{' '}
                      {order.members.join('、')} · 机具 {order.machines.join('、')}
                    </Typography>
                  </Box>

                  <TableContainer sx={{ mt: 1 }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>关联病害</TableCell>
                          <TableCell>部件 / 类型</TableCell>
                          <TableCell>等级</TableCell>
                          <TableCell>巡检日期</TableCell>
                          <TableCell>销号状态</TableCell>
                          <TableCell>销号时间</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {relatedFaults.map((fault) => (
                          <TableRow key={fault.id} hover>
                            <TableCell>
                              {fault.yardName} · {fault.switchCode}
                            </TableCell>
                            <TableCell>
                              {fault.part} / {fault.type}
                            </TableCell>
                            <TableCell>
                              <Chip
                                size="small"
                                label={FAULT_SEVERITY_LABEL[fault.severity]}
                                sx={{
                                  backgroundColor: `${SEVERITY_HEX[fault.severity]}1a`,
                                  color: SEVERITY_HEX[fault.severity],
                                }}
                              />
                            </TableCell>
                            <TableCell>{fault.inspectionDate}</TableCell>
                            <TableCell>
                              <Chip
                                size="small"
                                variant="outlined"
                                color={fault.state === 'solved' ? 'success' : 'warning'}
                                label={fault.state === 'solved' ? '已销号' : '待修'}
                              />
                            </TableCell>
                            <TableCell>{fault.solvedAt ?? '—'}</TableCell>
                          </TableRow>
                        ))}
                        {relatedFaults.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={6} align="center">
                              <Typography variant="caption" color="text.secondary">
                                关联病害已被删除或尚未加载
                              </Typography>
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </Paper>
              );
            })}
          </Stack>
        )}
      </Box>

      <Alert severity="info" sx={{ mt: 2 }}>
        说明：天窗作业单推进到「已完成」时，系统会把该单关联的全部待修病害一次性置为已销号并记录销号时间，
        可在「病害评定与销号」页撤销销号。
      </Alert>

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={2800}
        onClose={() => setToast('')}
        message={toast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
      <Typography variant="caption" color="text.secondary" display="block" mt={1}>
        当前时间基准 {nowDateTime()} · 销号率 {share(overview.solvedFaults, faults.length)}%
      </Typography>
    </Box>
  );
}
