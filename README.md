# 铁路道岔巡检与天窗修编排台（sologsb101-1004 / gbrailswitch）

## 一、Docker 一键启动（推荐）

```bash
cd sologsb101-1004
cp .env.example .env
docker compose up -d --build
```

启动后访问：**http://localhost:22804**

停止与清理：

```bash
docker compose down          # 停止并删除容器
docker compose up -d --build # 代码改动后重建
```

## 二、项目简介

面向工务段线路巡检与天窗修作业人员，把管内道岔的巡检病害按部件汇总，并在天窗点内编排检修顺序、人员与机具。

核心动作：

- 建立站场与道岔台账（辙叉号 9/12/18、轨型 60kg/m 与 50kg/m），按辙叉号与轨型筛选
- 按巡检批次录入病害并定位到部件（尖轨 / 基本轨 / 辙叉 / 转辙机）
- 评定病害等级（轻 / 中 / 重）、批量调整、批量升级、手工销号与撤销
- 勾选待修病害编排天窗作业单，分配时间窗 / 负责人 / 作业人员 / 机具，并做**时间窗 + 人员 + 机具三重冲突校验**
- 按天窗批次推进状态（待编排 → 已下达 → 作业中 → 已完成），推进到已完成时**自动回写病害销号**
- 登记慢行 / 封锁条件，查看结构版本并导出 / 导入整库 JSON

本项目为**纯前端单页应用**：无后端、无数据库服务、无外部接口，全部数据保存在浏览器 IndexedDB。

## 三、技术栈

| 分类 | 选型 | 版本 |
| --- | --- | --- |
| 框架 | React | 18.3 |
| 语言 | TypeScript | 5.7 |
| UI 组件库 | MUI（@mui/material + icons） | 5.16 |
| 构建工具 | Vite | 5.4 |
| 状态管理 | Redux Toolkit + React Redux | 2.5 / 9.2 |
| 路由 | React Router（History 路由，`createBrowserRouter`） | 6.28 |
| 本地持久化 | Dexie（IndexedDB） | 4.0 |
| 容器 | 多阶段构建 node:20-alpine → nginx:alpine | — |

## 四、路由一览

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/yards` | 站场与道岔台账 | 建立站场与道岔，按辙叉号与轨型筛选 |
| `/inspections` | 巡检与病害录入 | 按巡检批次录入病害并定位到部件 |
| `/faults` | 病害评定与销号 | 评定等级、批量调整、手工销号与撤销 |
| `/workorders` | 天窗作业单编排 | 勾选病害成单、分配时间窗与人员机具并校验冲突 |
| `/progress` | 作业进度与销号回写 | 更新状态，完成项自动回写病害销号 |
| `/backup` | 封锁条件与版本 | 登记慢行 / 封锁条件，结构版本与 JSON 管理 |

> 路由使用 `createBrowserRouter`（History 模式），真实路径 `/yards`、`/workorders` 等可直接访问，
> 刷新任意深链接由 `nginx.conf` 的 `try_files $uri $uri/ /index.html;` 回落到 `index.html` 后交给前端路由。
> 路径常量与导航配置抽到叶子模块 `src/router/routes.ts`，切断 `App.tsx ⇄ router/index.tsx` 的循环依赖
> （该环会在模块顶层读取尚未初始化的 `ROUTES`，触发 TDZ 报错导致整站白屏）。

## 五、目录结构

```
sologsb101-1004/
├── README.md
├── docker-compose.yml           # 顶层 name: gbrailswitch，无 version 字段
├── .env / .env.example          # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile               # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf               # try_files 前端路由回退 + gzip
    ├── .dockerignore
    ├── package.json / tsconfig.json / tsconfig.node.json
    ├── vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx             # 入口：Redux Provider + ThemeProvider + RouterProvider
        ├── App.tsx              # 应用外壳（侧边导航 + 站场上下文 + 统计）
        ├── styles/main.css
        ├── types/               # yard.ts switch.ts inspection.ts fault.ts workOrder.ts persistence.ts
        ├── stores/              # index.ts yardStore.ts switchStore.ts faultStore.ts workOrderStore.ts
        ├── components/common/   # SeverityTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── hooks/               # useFaultFilter.ts useIdbTable.ts useAppStore.ts
        ├── pages/               # YardList.tsx InspectionEntry.tsx FaultBoard.tsx WorkOrderPlan.tsx ProgressView.tsx BackupView.tsx
        ├── router/index.tsx     # 路由表（懒加载页面 + App 布局）
        ├── router/routes.ts     # 叶子模块：仅路径常量，切断 App ⇄ router 循环依赖
        └── utils/               # severity.ts window.ts db.ts export.ts events.ts format.ts
```

## 六、数据存储说明

- **存储介质**：浏览器 IndexedDB，库名 **`gbrailswitch`**，通过 Dexie 4.x 封装。
- **数据结构版本**：`utils/db.ts` 中 `DB_SCHEMA_VERSION = 2`，并登记 v1 → v2 的 `upgrade` 迁移（补齐行修订号、迁移 `faultType → type` / `faultPart → part`、`faultIds` 字符串拆分为数组、新增 `restrictions` 与 `settings` 表）。
- **数据表**：

  | 表名 | 实体 | 主要索引 |
  | --- | --- | --- |
  | `yards` | 站场 | id / name / region / mileage |
  | `switches` | 道岔 | id / yardId / code / frogNumber / railType / [yardId+code] |
  | `inspections` | 巡检 | id / switchId / date / inspector / [switchId+date] |
  | `faults` | 病害 | id / inspectionId / part / severity / state / [inspectionId+part] |
  | `workOrders` | 天窗作业单 | id / code / state / windowStart / leader |
  | `restrictions` | 封锁 / 慢行条件 | id / yardId / switchCode |
  | `settings` | 自定义字典 | id |

- **首屏自动播种**：`initDatabase()` 在 `yards` 表为空时写入演示数据（幂等）——2 个站场 × 各 4 组道岔 × 1~2 次巡检 × 每次 0~3 条病害 + 3 张天窗作业单（含 1 张刻意与人员时间窗冲突）+ 2 条封锁条件，父子记录通过 `yardId / switchId / inspectionId / faultIds` 互相引用。
- **跨页状态**：全部放在 Redux Toolkit store（`yardStore / switchStore / faultStore / workOrderStore`），页面只读 store；Dexie 写入后由 `utils/events.ts` 广播，store 自动重新拉取。
- **数据不出浏览器**：容器无状态，不挂载卷、不使用数据库服务。

## 七、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22804
npm run typecheck  # tsc --noEmit
npm run build      # tsc --noEmit && vite build
npm run preview    # 预览构建产物
```

## 八、容器化细节

- `Dockerfile` 两阶段构建：`node:20-alpine` 安装依赖并执行 `npm run build`（内含 TypeScript 类型检查），随后拷贝 `dist` 到 `nginx:alpine`。
- 运行阶段在 `COPY --from=builder /app/dist /usr/share/nginx/html` 之后执行 `RUN chmod -R a+rX /usr/share/nginx/html`，规避历史遗留的 favicon 权限 0600 导致 nginx 403 的问题。
- `nginx.conf` 使用 `try_files $uri $uri/ /index.html;` 支持前端路由直接刷新，并开启 gzip。
- `docker-compose.yml` 不写 `version:`，顶层 `name: gbrailswitch` 兜底（避免中文目录名导致项目名为空），服务名 `frontend`，容器名 `${COMPOSE_PROJECT_NAME:-gbrailswitch}-frontend`，端口 `${FRONTEND_PORT:-22804}:80`，`restart: unless-stopped`。
