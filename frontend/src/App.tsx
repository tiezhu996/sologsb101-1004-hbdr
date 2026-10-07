/**
 * 应用外壳：左侧导航 + 顶栏当前站场上下文 + 内容出口。
 * 首屏在此处初始化 IndexedDB、播种演示数据并订阅变更广播。
 */
import { useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  AppBar,
  Badge,
  Box,
  Chip,
  CssBaseline,
  Divider,
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Snackbar,
  Stack,
  Toolbar,
  Typography,
} from '@mui/material';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import ReportProblemIcon from '@mui/icons-material/ReportProblem';
import EventNoteIcon from '@mui/icons-material/EventNote';
import TimelineIcon from '@mui/icons-material/Timeline';
import MoveToInboxIcon from '@mui/icons-material/MoveToInbox';
import ArchiveIcon from '@mui/icons-material/Archive';
// 路径常量取自叶子模块 ./router/routes：App 在模块顶层就要用 ROUTES 构造菜单，
// 若从 ./router（会 import App）引入会形成循环依赖 → TDZ「Cannot access before initialization」
import { ROUTES } from './router/routes';
import { initDatabase } from './utils/db';
import { refreshAll, subscribeStoreRefresh } from './stores';
import { useAppSelector } from './hooks/useAppStore';
import { selectFaultCounts } from './stores/faultStore';
import { selectWindowStats } from './stores/workOrderStore';
import { selectYardViews } from './stores/yardStore';

const DRAWER_WIDTH = 236;

const MENU = [
  { key: ROUTES.yards, label: '站场与道岔台账', icon: <AccountTreeIcon /> },
  { key: ROUTES.inspections, label: '巡检与病害录入', icon: <FactCheckIcon /> },
  { key: ROUTES.faults, label: '病害评定与销号', icon: <ReportProblemIcon /> },
  { key: ROUTES.workorders, label: '天窗作业单编排', icon: <EventNoteIcon /> },
  { key: ROUTES.progress, label: '作业进度与销号', icon: <TimelineIcon /> },
  { key: ROUTES.sync, label: '离线包接收区', icon: <MoveToInboxIcon /> },
  { key: ROUTES.backup, label: '封锁条件与版本', icon: <ArchiveIcon /> },
];

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const yards = useAppSelector(selectYardViews);
  const faultCounts = useAppSelector(selectFaultCounts);
  const windowStats = useAppSelector(selectWindowStats);
  const activeYardId = useAppSelector((state) => state.yard.activeYardId);
  const error = useAppSelector((state) => state.yard.error || state.fault.error || state.workOrder.error);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await initDatabase();
      if (cancelled) return;
      subscribeStoreRefresh();
      await refreshAll();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeYard = yards.find((item) => item.id === activeYardId) ?? null;

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <CssBaseline />
      <AppBar
        position="fixed"
        elevation={0}
        sx={{ zIndex: (theme) => theme.zIndex.drawer + 1, backgroundColor: '#0b3d91' }}
      >
        <Toolbar variant="dense" sx={{ gap: 1.5, flexWrap: 'wrap' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            铁路道岔巡检与天窗修编排台
          </Typography>
          <Typography variant="caption" sx={{ opacity: 0.75 }}>
            gbrailswitch
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Chip
              size="small"
              sx={{ backgroundColor: 'rgba(255,255,255,0.16)', color: '#fff' }}
              label={activeYard ? `当前站场 ${activeYard.name}` : '未选择站场'}
            />
            <Badge badgeContent={faultCounts.pending} color="error" max={999}>
              <Chip size="small" sx={{ backgroundColor: 'rgba(255,255,255,0.16)', color: '#fff' }} label="待修病害" />
            </Badge>
            <Chip
              size="small"
              sx={{ backgroundColor: 'rgba(255,255,255,0.16)', color: '#fff' }}
              label={`作业单 ${windowStats.total} 张 / 占用 ${windowStats.occupationRate}%`}
            />
          </Stack>
        </Toolbar>
      </AppBar>

      <Drawer
        variant="permanent"
        sx={{
          width: DRAWER_WIDTH,
          flexShrink: 0,
          '& .MuiDrawer-paper': {
            width: DRAWER_WIDTH,
            boxSizing: 'border-box',
            backgroundColor: '#0f172a',
            color: '#e2e8f0',
            borderRight: 'none',
          },
        }}
      >
        <Toolbar variant="dense" />
        <Box sx={{ px: 2, py: 1.5 }}>
          <Typography variant="caption" sx={{ color: 'rgba(226,232,240,0.65)' }}>
            工务段线路巡检 · 天窗修作业
          </Typography>
          <Box
            sx={{
              height: 3,
              mt: 1,
              borderRadius: 2,
              background: 'linear-gradient(90deg,#1976d2,#26a69a 60%,#ed6c02)',
            }}
          />
        </Box>
        <Divider sx={{ borderColor: 'rgba(226,232,240,0.12)' }} />
        <List dense>
          {MENU.map((item) => (
            <ListItemButton
              key={item.key}
              component={NavLink}
              to={item.key}
              selected={location.pathname.startsWith(item.key)}
              sx={{
                color: 'inherit',
                '&.Mui-selected': { backgroundColor: 'rgba(25,118,210,0.28)' },
                '&.Mui-selected:hover': { backgroundColor: 'rgba(25,118,210,0.36)' },
              }}
            >
              <ListItemIcon sx={{ color: 'inherit', minWidth: 36 }}>{item.icon}</ListItemIcon>
              <ListItemText primary={item.label} primaryTypographyProps={{ fontSize: 13.5 }} />
            </ListItemButton>
          ))}
        </List>
        <Box sx={{ px: 2, py: 1.5, color: 'rgba(226,232,240,0.6)', fontSize: 12, lineHeight: 1.9 }}>
          <div>站场 {yards.length} 个</div>
          <div>
            待修 {faultCounts.pending} · 重级 {faultCounts.heavy}
          </div>
          <div>已编排 {faultCounts.planned} 处病害</div>
        </Box>
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, backgroundColor: '#f4f6f8', minHeight: '100vh' }}>
        <Toolbar variant="dense" />
        <Box sx={{ p: 2 }}>
          <Outlet />
        </Box>
        <Box sx={{ textAlign: 'center', py: 2, color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>
          数据仅保存在本机浏览器 IndexedDB（库名 gbrailswitch）· 纯前端 SPA，无后端与外部接口
        </Box>
      </Box>

      <Snackbar
        open={Boolean(error)}
        message={error ? `本地数据库异常：${error}` : ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        onClick={() => navigate(ROUTES.yards)}
      />
    </Box>
  );
}
