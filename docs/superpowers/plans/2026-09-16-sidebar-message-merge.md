# 侧边栏会话 × 消息流合并 实施计划

> Spec：`2026-09-16-sidebar-message-merge-design.md` · Issue #14

## 步骤

1. 新建 `apps/web/src/components/WorkbenchTab.tsx`
   - 左栏：会话列表（原 SessionsTab 逻辑：搜索/分组/排序/徽标），点选回调 `onSelectSession`
   - 右栏落地态：MentionComposer + 状态过滤 + 搜索 + MessageCard 流
   - 右栏线程态：`usePeerMessages` 气泡线程 + `webAsk` 固定目标输入框 + 收起
   - `selectedSessionId` 变化（外部选中，如图拓扑）经 useEffect 同步为本地 peer
2. `Sidebar.tsx`：TabId 收敛 `sessions`/`messages` → `workbench`，navItems 合并为一项「会话与消息」（MessageSquare 图标）
3. `App.tsx`：`tab === "workbench"` 渲染 WorkbenchTab，透传会话/消息两组选中 props；删除旧分支
4. 删除 `SessionsTab.tsx`、`MessageTab.tsx`（逻辑已被吸收）
5. 验证：`npm run lint`、`npm run build`、`npm test -w apps/web`、Playwright 截图（默认图拓扑 + 点开工作台两态）
6. PR → dev，过三项检查后合并

## 风险与回归点

- `tab` 初始值仍为 `graph`，无默认路由迁移问题。
- MessageCard 点击语义不变（选消息 + 开线程）。
- 线程态对离线会话同样可发（异步投递语义，与产品一致）。
