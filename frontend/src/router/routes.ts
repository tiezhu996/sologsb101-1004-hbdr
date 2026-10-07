/**
 * 路由常量（叶子模块）
 * 只导出路径常量，不 import 任何应用内模块（尤其不 import App / 页面 / store）。
 * 目的：切断 App.tsx ⇄ router/index.tsx 的循环依赖 —— App 在模块顶层读取 ROUTES，
 * 若这些常量仍定义在 router/index.tsx 中，就会出现「Cannot access 'X' before initialization」的 TDZ 报错。
 * 路径与项目提示词逐字一致：/yards、/inspections、/faults、/workorders、/progress、/backup
 */

/** 全部路由路径 */
export const ROUTES = {
  yards: '/yards',
  inspections: '/inspections',
  faults: '/faults',
  workorders: '/workorders',
  progress: '/progress',
  intake: '/intake',
  backup: '/backup',
} as const;

export type RouteKey = keyof typeof ROUTES;
