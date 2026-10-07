/**
 * 路由表（路径与项目提示词逐字一致）
 * /yards、/inspections、/faults、/workorders、/progress、/backup
 * 页面按路由懒加载，构建时自动分包。
 *
 * 路径常量定义在叶子模块 ./routes 中：本文件 import App，App 也 import 路径常量，
 * 常量留在本文件会形成 App ⇄ router 循环依赖并在首屏抛 TDZ 错误（整站白屏）。
 */
import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { Box, CircularProgress } from '@mui/material';
import App from '../App';
import { ROUTES } from './routes';

const YardList = lazy(() => import('../pages/YardList'));
const InspectionEntry = lazy(() => import('../pages/InspectionEntry'));
const FaultBoard = lazy(() => import('../pages/FaultBoard'));
const WorkOrderPlan = lazy(() => import('../pages/WorkOrderPlan'));
const ProgressView = lazy(() => import('../pages/ProgressView'));
const BackupView = lazy(() => import('../pages/BackupView'));

/** 兼容出口：路径常量请优先直接从 './routes' 引入（叶子模块，不产生环） */
export { ROUTES } from './routes';
export type { RouteKey } from './routes';

function RouteFallback() {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
      <CircularProgress size={28} />
    </Box>
  );
}

function withSuspense(node: ReactNode): ReactNode {
  return <Suspense fallback={<RouteFallback />}>{node}</Suspense>;
}

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to={ROUTES.yards} replace /> },
      { path: 'yards', element: withSuspense(<YardList />) },
      { path: 'inspections', element: withSuspense(<InspectionEntry />) },
      { path: 'faults', element: withSuspense(<FaultBoard />) },
      { path: 'workorders', element: withSuspense(<WorkOrderPlan />) },
      { path: 'progress', element: withSuspense(<ProgressView />) },
      { path: 'backup', element: withSuspense(<BackupView />) },
      { path: '*', element: <Navigate to={ROUTES.yards} replace /> },
    ],
  },
];

export default appRoutes;
