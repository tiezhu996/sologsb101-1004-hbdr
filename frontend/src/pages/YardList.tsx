/**
 * /yards 站场与道岔台账
 * 建立站场与道岔，按辙叉号与轨型筛选；卡片回显道岔数与待修病害数。
 * 消费 Yard、Switch 与 <StatBadge>、<EmptyPanel>、<FilterBar>。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
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
import type { YardDraft } from '../types/yard';
import type { FrogNumber, RailType, SwitchDraft, TurnoutType } from '../types/switch';
import {
  FROG_NUMBER_OPTIONS,
  FROG_SPEED_LIMIT,
  RAIL_TYPE_OPTIONS,
  TURNOUT_TYPE_LABEL,
  railWeight,
  switchHealth,
} from '../types/switch';
import { ROUTES } from '../router/routes';
import { useAppDispatch, useAppSelector } from '../hooks/useAppStore';
import {
  batchCreateSwitches,
  createSwitch,
  createYard,
  deleteSwitch,
  deleteYard,
  selectSwitchViews,
  selectYardViews,
  setActiveYard,
  updateSwitch,
  updateYard,
} from '../stores/yardStore';
import { share } from '../utils/format';
import { PART_CHECK_HINT } from '../types/fault';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar, { useFilterValues, useKeywordFilter } from '../components/common/FilterBar';

const EMPTY_YARD: YardDraft = { name: '', mileage: 'K0+000', trackCount: 4, region: '' };
const EMPTY_SWITCH: SwitchDraft = {
  yardId: '',
  code: '',
  frogNumber: '12',
  railType: '60kg/m',
  position: '',
  turnoutType: 'single',
};

export default function YardList() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const yardViews = useAppSelector(selectYardViews);
  const switchViews = useAppSelector(selectSwitchViews);
  const activeYardId = useAppSelector((state) => state.yard.activeYardId);

  const keyword = useKeywordFilter();
  const filters = useFilterValues(['yard', 'frog', 'rail']);
  const [toast, setToast] = useState('');

  const [yardDialog, setYardDialog] = useState<{ open: boolean; editingId: string | null; draft: YardDraft }>({
    open: false,
    editingId: null,
    draft: EMPTY_YARD,
  });
  const [switchPanel, setSwitchPanel] = useState<{ open: boolean; yardId: string }>({ open: false, yardId: '' });
  const [switchDialog, setSwitchDialog] = useState<{
    open: boolean;
    editingId: string | null;
    draft: SwitchDraft;
  }>({ open: false, editingId: null, draft: EMPTY_SWITCH });
  const [batchDialog, setBatchDialog] = useState({ open: false, startSeq: 13, count: 2 });

  const filtered = useMemo(() => {
    const lower = keyword.trim().toLowerCase();
    const yardFilter = filters.yard ?? [];
    const frogFilter = (filters.frog ?? []) as FrogNumber[];
    const railFilter = (filters.rail ?? []) as RailType[];
    return yardViews.filter((yard) => {
      if (yardFilter.length > 0 && !yardFilter.includes(yard.id)) return false;
      if (lower && !`${yard.name} ${yard.region} ${yard.mileage}`.toLowerCase().includes(lower)) return false;
      if (frogFilter.length > 0 || railFilter.length > 0) {
        // 站场维度筛选辙叉号/轨型：站场内存在匹配道岔才保留
        const owned = switchViews.filter((item) => item.yardId === yard.id);
        const matchFrog = frogFilter.length === 0 || owned.some((item) => frogFilter.includes(item.frogNumber));
        const matchRail = railFilter.length === 0 || owned.some((item) => railFilter.includes(item.railType));
        if (!matchFrog || !matchRail) return false;
      }
      return true;
    });
  }, [yardViews, switchViews, keyword, filters]);

  const totals = useMemo(() => {
    const switchCount = yardViews.reduce((sum, item) => sum + item.switchCount, 0);
    const pending = yardViews.reduce((sum, item) => sum + item.pendingFaultCount, 0);
    const severe = yardViews.reduce((sum, item) => sum + item.severeCount, 0);
    return {
      yards: yardViews.length,
      switches: switchCount,
      pending,
      severe,
      pendingShare: share(pending, switchCount),
    };
  }, [yardViews]);

  const panelSwitches = useMemo(
    () => switchViews.filter((item) => item.yardId === switchPanel.yardId),
    [switchViews, switchPanel.yardId],
  );

  const submitYard = async (): Promise<void> => {
    if (!yardDialog.draft.name.trim()) {
      setToast('请填写站场名');
      return;
    }
    if (yardDialog.editingId) {
      await dispatch(updateYard({ id: yardDialog.editingId, draft: yardDialog.draft }));
      setToast('站场已更新');
    } else {
      await dispatch(createYard(yardDialog.draft));
      setToast('站场已创建，可继续录入道岔');
    }
    setYardDialog({ open: false, editingId: null, draft: EMPTY_YARD });
  };

  const submitSwitch = async (): Promise<void> => {
    if (!switchDialog.draft.code.trim()) {
      setToast('请填写道岔编号');
      return;
    }
    if (switchDialog.editingId) {
      await dispatch(updateSwitch({ id: switchDialog.editingId, draft: switchDialog.draft }));
      setToast('道岔已更新');
    } else {
      await dispatch(createSwitch({ ...switchDialog.draft, yardId: switchPanel.yardId }));
      setToast('道岔已新增');
    }
    setSwitchDialog({ open: false, editingId: null, draft: { ...EMPTY_SWITCH, yardId: switchPanel.yardId } });
  };

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap mb={1.5}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            站场与道岔台账
          </Typography>
          <Typography variant="body2" color="text.secondary">
            建立站场与道岔台账，按辙叉号与轨型筛选；卡片回显道岔数与待修病害数。
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" onClick={() => navigate(ROUTES.faults)}>
            病害评定与销号
          </Button>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setYardDialog({ open: true, editingId: null, draft: EMPTY_YARD })}
          >
            新建站场
          </Button>
        </Stack>
      </Stack>

      <Grid container spacing={1.5} mb={1.75}>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge title="站场总数" value={totals.yards} suffix="个" color="#1565c0" />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="道岔总数"
            value={totals.switches}
            suffix="组"
            color="#00897b"
            hint="辙叉号 9/12/18，轨型 60kg/m 与 50kg/m"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge
            title="待修病害"
            value={totals.pending}
            suffix="处"
            percent={totals.pendingShare}
            color="#d32f2f"
            hint="进度条为待修病害 / 道岔总数"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatBadge title="重级病害" value={totals.severe} suffix="处" color="#ed6c02" hint="建议优先纳入天窗修" />
        </Grid>
      </Grid>

      <FilterBar
        keywordPlaceholder="按站场名 / 里程 / 车间搜索"
        selects={[
          {
            key: 'yard',
            label: '站场',
            options: yardViews.map((item) => ({ label: item.name, value: item.id })),
            width: 190,
          },
          {
            key: 'frog',
            label: '辙叉号',
            options: FROG_NUMBER_OPTIONS.map((item) => ({ label: `${item} 号`, value: item })),
            width: 150,
          },
          {
            key: 'rail',
            label: '轨型',
            options: RAIL_TYPE_OPTIONS.map((item) => ({ label: item, value: item })),
            width: 150,
          },
        ]}
        resultCount={filtered.length}
        countUnit="个站场"
        onChange={() => setToast('')}
      />

      <Box mt={1.75}>
        {filtered.length === 0 ? (
          <EmptyPanel
            title="没有匹配的站场"
            description="可新建站场并录入道岔，或清空筛选条件后重试。"
            createLabel="新建站场"
            onCreate={() => setYardDialog({ open: true, editingId: null, draft: EMPTY_YARD })}
          />
        ) : (
          <Grid container spacing={1.75}>
            {filtered.map((yard) => {
              const owned = switchViews.filter((item) => item.yardId === yard.id);
              const health = switchHealth(yard.pendingFaultCount, yard.severeCount);
              return (
                <Grid item xs={12} md={6} xl={4} key={yard.id}>
                  <Card
                    variant="outlined"
                    sx={{
                      height: '100%',
                      borderRadius: 2,
                      borderColor: activeYardId === yard.id ? 'primary.main' : undefined,
                      cursor: 'pointer',
                      '&:hover': { boxShadow: 3 },
                    }}
                    onClick={() => dispatch(setActiveYard(yard.id))}
                  >
                    <CardContent>
                      <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
                        <Box>
                          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                            {yard.name}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {yard.mileage} · {yard.region} · {yard.trackCount} 条线路
                          </Typography>
                        </Box>
                        <Stack direction="row" spacing={0.5}>
                          <Chip
                            size="small"
                            label={health}
                            color={health === '正常' ? 'success' : health === '关注' ? 'warning' : 'error'}
                          />
                          <IconButton
                            size="small"
                            onClick={(event) => {
                              event.stopPropagation();
                              setYardDialog({
                                open: true,
                                editingId: yard.id,
                                draft: {
                                  name: yard.name,
                                  mileage: yard.mileage,
                                  trackCount: yard.trackCount,
                                  region: yard.region,
                                },
                              });
                            }}
                          >
                            <EditIcon fontSize="small" />
                          </IconButton>
                          <IconButton
                            size="small"
                            color="error"
                            onClick={async (event) => {
                              event.stopPropagation();
                              await dispatch(deleteYard(yard.id));
                              setToast('站场及其道岔、巡检、病害已删除');
                            }}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Stack>
                      </Stack>

                      <Grid container spacing={1} mt={0.5}>
                        <Grid item xs={4}>
                          <StatBadge title="道岔" value={yard.switchCount} suffix="组" inline color="#00897b" />
                        </Grid>
                        <Grid item xs={4}>
                          <StatBadge
                            title="待修"
                            value={yard.pendingFaultCount}
                            suffix="处"
                            inline
                            color={yard.pendingFaultCount > 0 ? '#d32f2f' : '#2e7d32'}
                          />
                        </Grid>
                        <Grid item xs={4}>
                          <StatBadge title="重级" value={yard.severeCount} suffix="处" inline color="#ed6c02" />
                        </Grid>
                      </Grid>

                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap mt={1}>
                        {owned.length === 0 ? (
                          <Chip size="small" label="暂无道岔" />
                        ) : (
                          owned.slice(0, 5).map((item) => (
                            <Tooltip key={item.id} title={`${item.position} · ${TURNOUT_TYPE_LABEL[item.turnoutType]}`}>
                              <Chip
                                size="small"
                                label={`${item.code} · ${item.frogNumber}号`}
                                color={item.pendingFaultCount > 0 ? 'warning' : 'default'}
                                variant={item.pendingFaultCount > 0 ? 'filled' : 'outlined'}
                              />
                            </Tooltip>
                          ))
                        )}
                        {owned.length > 5 ? <Chip size="small" label={`+${owned.length - 5}`} /> : null}
                      </Stack>

                      <Stack direction="row" justifyContent="space-between" mt={1}>
                        <Button
                          size="small"
                          onClick={(event) => {
                            event.stopPropagation();
                            setSwitchPanel({ open: true, yardId: yard.id });
                          }}
                        >
                          道岔管理
                        </Button>
                        <Button
                          size="small"
                          onClick={(event) => {
                            event.stopPropagation();
                            dispatch(setActiveYard(yard.id));
                            navigate(ROUTES.inspections);
                          }}
                        >
                          录入巡检
                        </Button>
                      </Stack>
                    </CardContent>
                  </Card>
                </Grid>
              );
            })}
          </Grid>
        )}
      </Box>

      {/* 站场表单 */}
      <Dialog open={yardDialog.open} onClose={() => setYardDialog({ open: false, editingId: null, draft: EMPTY_YARD })} fullWidth maxWidth="sm">
        <DialogTitle>{yardDialog.editingId ? '编辑站场' : '新建站场'}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <TextField
              label="站场名"
              required
              value={yardDialog.draft.name}
              onChange={(event) => setYardDialog((prev) => ({ ...prev, draft: { ...prev.draft, name: event.target.value } }))}
            />
            <Stack direction="row" spacing={2}>
              <TextField
                label="中心里程"
                value={yardDialog.draft.mileage}
                onChange={(event) =>
                  setYardDialog((prev) => ({ ...prev, draft: { ...prev.draft, mileage: event.target.value } }))
                }
                sx={{ flex: 1 }}
              />
              <TextField
                label="线路数"
                type="number"
                value={yardDialog.draft.trackCount}
                onChange={(event) =>
                  setYardDialog((prev) => ({
                    ...prev,
                    draft: { ...prev.draft, trackCount: Number(event.target.value) },
                  }))
                }
                sx={{ width: 140 }}
              />
            </Stack>
            <TextField
              label="管辖车间"
              value={yardDialog.draft.region}
              onChange={(event) => setYardDialog((prev) => ({ ...prev, draft: { ...prev.draft, region: event.target.value } }))}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setYardDialog({ open: false, editingId: null, draft: EMPTY_YARD })}>取消</Button>
          <Button variant="contained" onClick={() => void submitYard()}>
            保存
          </Button>
        </DialogActions>
      </Dialog>

      {/* 道岔管理面板 */}
      <Dialog
        open={switchPanel.open}
        onClose={() => setSwitchPanel({ open: false, yardId: '' })}
        fullWidth
        maxWidth="lg"
      >
        <DialogTitle>
          道岔台账 · {yardViews.find((item) => item.id === switchPanel.yardId)?.name ?? ''}
        </DialogTitle>
        <DialogContent dividers>
          <Stack direction="row" spacing={1} mb={1.5}>
            <Button
              variant="contained"
              size="small"
              startIcon={<AddIcon />}
              onClick={() =>
                setSwitchDialog({
                  open: true,
                  editingId: null,
                  draft: { ...EMPTY_SWITCH, yardId: switchPanel.yardId, code: `${panelSwitches.length * 2 + 1}#` },
                })
              }
            >
              新增道岔
            </Button>
            <Button variant="outlined" size="small" onClick={() => setBatchDialog({ open: true, startSeq: 13, count: 2 })}>
              批量新增
            </Button>
            <Typography variant="caption" color="text.secondary" alignSelf="center">
              共 {panelSwitches.length} 组道岔，轴承重量提示：60kg/m 轨型需配 60 级扣件
            </Typography>
          </Stack>

          {panelSwitches.length === 0 ? (
            <EmptyPanel title="该站场暂无道岔" description="新增单组道岔或用批量新增按编号连续登记。" />
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>编号</TableCell>
                    <TableCell>辙叉号</TableCell>
                    <TableCell>轨型</TableCell>
                    <TableCell>类型</TableCell>
                    <TableCell>位置</TableCell>
                    <TableCell>检查要点</TableCell>
                    <TableCell align="right">巡检 / 病害</TableCell>
                    <TableCell align="right">操作</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {panelSwitches.map((item) => (
                    <TableRow key={item.id} hover>
                      <TableCell>
                        <Typography variant="body2" fontWeight={600}>
                          {item.code}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        {item.frogNumber} 号
                        <Typography variant="caption" color="text.secondary" display="block">
                          侧向限速 {FROG_SPEED_LIMIT[item.frogNumber]} km/h
                        </Typography>
                      </TableCell>
                      <TableCell>
                        {item.railType}
                        <Typography variant="caption" color="text.secondary" display="block">
                          {railWeight(item.railType)} kg/m
                        </Typography>
                      </TableCell>
                      <TableCell>{TURNOUT_TYPE_LABEL[item.turnoutType]}</TableCell>
                      <TableCell>{item.position}</TableCell>
                      <TableCell>
                        <Typography variant="caption" color="text.secondary">
                          {PART_CHECK_HINT.frog}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        {item.inspectionCount} 次 / {item.pendingFaultCount} 处待修
                      </TableCell>
                      <TableCell align="right">
                        <IconButton
                          size="small"
                          onClick={() =>
                            setSwitchDialog({
                              open: true,
                              editingId: item.id,
                              draft: {
                                yardId: item.yardId,
                                code: item.code,
                                frogNumber: item.frogNumber,
                                railType: item.railType,
                                position: item.position,
                                turnoutType: item.turnoutType,
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
                            await dispatch(deleteSwitch(item.id));
                            setToast('道岔及其巡检病害已删除');
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
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSwitchPanel({ open: false, yardId: '' })}>关闭</Button>
        </DialogActions>
      </Dialog>

      {/* 道岔表单 */}
      <Dialog open={switchDialog.open} onClose={() => setSwitchDialog({ open: false, editingId: null, draft: EMPTY_SWITCH })} fullWidth maxWidth="sm">
        <DialogTitle>{switchDialog.editingId ? '编辑道岔' : '新增道岔'}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <TextField
              label="道岔编号"
              required
              value={switchDialog.draft.code}
              onChange={(event) =>
                setSwitchDialog((prev) => ({ ...prev, draft: { ...prev.draft, code: event.target.value } }))
              }
            />
            <Stack direction="row" spacing={2}>
              <FormControl fullWidth size="small">
                <InputLabel>辙叉号</InputLabel>
                <Select
                  label="辙叉号"
                  value={switchDialog.draft.frogNumber}
                  onChange={(event) =>
                    setSwitchDialog((prev) => ({
                      ...prev,
                      draft: { ...prev.draft, frogNumber: event.target.value as FrogNumber },
                    }))
                  }
                >
                  {FROG_NUMBER_OPTIONS.map((item) => (
                    <MenuItem key={item} value={item}>
                      {item} 号（侧向限速 {FROG_SPEED_LIMIT[item]} km/h）
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth size="small">
                <InputLabel>轨型</InputLabel>
                <Select
                  label="轨型"
                  value={switchDialog.draft.railType}
                  onChange={(event) =>
                    setSwitchDialog((prev) => ({
                      ...prev,
                      draft: { ...prev.draft, railType: event.target.value as RailType },
                    }))
                  }
                >
                  {RAIL_TYPE_OPTIONS.map((item) => (
                    <MenuItem key={item} value={item}>
                      {item}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Stack>
            <FormControl fullWidth size="small">
              <InputLabel>道岔类型</InputLabel>
              <Select
                label="道岔类型"
                value={switchDialog.draft.turnoutType}
                onChange={(event) =>
                  setSwitchDialog((prev) => ({
                    ...prev,
                    draft: { ...prev.draft, turnoutType: event.target.value as TurnoutType },
                  }))
                }
              >
                {(Object.keys(TURNOUT_TYPE_LABEL) as TurnoutType[]).map((key) => (
                  <MenuItem key={key} value={key}>
                    {TURNOUT_TYPE_LABEL[key]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              label="位置描述"
              value={switchDialog.draft.position}
              onChange={(event) =>
                setSwitchDialog((prev) => ({ ...prev, draft: { ...prev.draft, position: event.target.value } }))
              }
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSwitchDialog({ open: false, editingId: null, draft: EMPTY_SWITCH })}>取消</Button>
          <Button variant="contained" onClick={() => void submitSwitch()}>
            保存
          </Button>
        </DialogActions>
      </Dialog>

      {/* 批量新增道岔 */}
      <Dialog open={batchDialog.open} onClose={() => setBatchDialog((prev) => ({ ...prev, open: false }))} fullWidth maxWidth="xs">
        <DialogTitle>批量新增道岔</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <TextField
              label="起始编号序号"
              type="number"
              value={batchDialog.startSeq}
              onChange={(event) => setBatchDialog((prev) => ({ ...prev, startSeq: Number(event.target.value) }))}
              helperText="按站场惯例以奇数编号递增（+2）"
            />
            <TextField
              label="生成组数"
              type="number"
              value={batchDialog.count}
              onChange={(event) => setBatchDialog((prev) => ({ ...prev, count: Number(event.target.value) }))}
            />
            <Divider />
            <Alert severity="info">
              批量新增默认辙叉号 12、轨型 60kg/m、单开道岔；重复编号将自动跳过。
            </Alert>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBatchDialog((prev) => ({ ...prev, open: false }))}>取消</Button>
          <Button
            variant="contained"
            onClick={async () => {
              const created = await dispatch(
                batchCreateSwitches({
                  yardId: switchPanel.yardId,
                  startSeq: batchDialog.startSeq,
                  count: batchDialog.count,
                  frogNumber: '12',
                  railType: '60kg/m',
                }),
              );
              setToast(created.payload ? `已批量新增 ${created.payload} 组道岔` : '编号重复，未新增道岔');
              setBatchDialog((prev) => ({ ...prev, open: false }));
            }}
          >
            生成
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
