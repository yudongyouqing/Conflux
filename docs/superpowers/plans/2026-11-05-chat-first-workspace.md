# 聊天优先工作界面与助手整合执行计划

> **面向 AI 代理的工作者：** 使用 `superpowers:executing-plans` 逐任务执行，按阶段进行审查。步骤使用复选框记录真实进度。本计划不要求并行代理；需要并行时单独确认文件所有权与依赖。

**目标：** 打开 Conflux 即进入可操作的聊天工作界面，图谱与对话相邻，助手配置和实际会话清晰关联。

**架构：** 在现有 React/React Query 前端内增加受控工作界面状态，复用房间、peer 消息与运行实例协议。图谱范围与助手关联分别由纯函数投影，发送、唤醒、进程控制继续由已有服务端处理。

**技术栈：** TypeScript、React 18、TanStack Query、React Flow、Node test runner、Testing Library/JSDOM、Playwright、Electron。

**规格：** [总体规格](../specs/2026-11-05-chat-first-workspace-design.md)。追踪：[issue #302](https://github.com/yudongyouqing/Conflux/issues/302)。

**状态：** 计划文档已编写，所有实现步骤尚未执行。文档基线为 dev `85791cf`；每阶段从最新 dev 开分支，不假定基线没有变化。

---

## 一、交付批次与完成边界

| 阶段 | 任务 | 交付结果 | 依赖与 PR |
| --- | --- | --- | --- |
| P1 聊天首页 | 0—4 | 房间/单聊直接进入，草稿与选择隔离，现有管理入口保留 | 第一条行为 PR → dev |
| P2 图谱与活动 | 5—6 | 房间/全局图谱切换、活动入口、隐藏查询和布局暂停 | P1 合入后从新 dev 开第二条 PR |
| P3 助手整合 | 7—8 | 编码/模型统一入口，创建直达类型，实例归属清晰 | P2 合入后从新 dev 开第三条 PR |
| P4 联调验收 | 9—10 | 真实 API 浏览器回归、实际包和桌面入口验收、文档同步 | P3 后第四条 PR；修改 CI 时说明影响 |

P1 暂时保留原 Agents、运行时、全局图谱入口，直到对应替代页面就绪后移除；每个阶段均可单独使用。P4 中需要真实 Codex/Claude 宿主、其他操作系统或安装权限的项目必须提供实际证据，缺条件就保留未完成。不能以浏览器 mock 替代桌面或真实宿主验收。

P5「模型助手加入房间」单独立项：先设计成员类型、消息归属、上下文、费用、取消/重试和迁移，再决定实现。P1—P4 不实现 P5，也不把它列入本批完成门槛。

## 二、文件结构与职责

所有路径均相对仓库根；新建文件遵循所在目录现有的命名习惯。

| 操作 | 路径 | 职责 |
| --- | --- | --- |
| 新增 | `apps/web/src/workspace-state.ts` | 目标联合、恢复校验、草稿状态与 reducer |
| 新增 | `apps/web/src/room-hooks.ts` | 房间列表、当前房间任务/消息、成员 mutation 的 Query 封装 |
| 修改 | `apps/web/src/hooks.ts` | peer/活动查询可见性开关与请求取消 |
| 修改 | `apps/web/src/api.ts` | 只读请求可选 AbortSignal，保持 URL/body 兼容 |
| 修改 | `apps/web/src/App.tsx` | 主导航、全局选中目标、详情、阶段间兼容入口 |
| 修改 | `apps/web/src/components/Sidebar.tsx` | 房间/最近会话导航，取消强制跳 graph 的选择行为 |
| 修改 | `apps/web/src/components/ChatRoomList.tsx` | 改为受控房间导航，不自行维护另一份房间列表 |
| 新增 | `apps/web/src/components/WorkspaceTab.tsx` | 当前目标、聊天/图谱切换及空态 |
| 新增 | `apps/web/src/components/WorkspaceDetails.tsx` | 成员、任务、会话详情、房间管理操作 |
| 修改 | `apps/web/src/components/RoomsTab.tsx` | 迁移原房间卡片操作；所有引用迁移后移除旧页面 |
| 修改 | `apps/web/src/components/ChatRoomWizard.tsx` | 创建后回传真实 ChatRoom，由上层选择 |
| 修改 | `apps/web/src/components/RoomChat.tsx` | 受控草稿/目标、Query 数据、定向与广播 |
| 新增 | `apps/web/src/components/PeerConversation.tsx` | 从 MessageTab 提取单聊线程，使用既有接口 |
| 修改 | `apps/web/src/components/MessageTab.tsx` | 保留活动筛选/边对话，复用单聊组件 |
| 新增 | `apps/web/src/graph-scope.ts` | 过滤房间图，保持真实边与孤立成员 |
| 修改 | `apps/web/src/components/GraphTab.tsx` | 消费外部 graph/scope/active，不重复发起 graph 查询 |
| 新增 | `apps/web/src/assistant-catalog.ts` | 分类型 key、预设/实例/会话的确定性关联 |
| 新增 | `apps/web/src/components/AssistantsTab.tsx` | 统一入口与分类，不包含模型调用实现 |
| 修改 | `apps/web/src/components/AgentTab.tsx` | 提取可复用模型助手列表与现有 ChatPanel 入口 |
| 修改 | `apps/web/src/components/RuntimesTab.tsx` | 提取编码助手列表、PTY 与实例列表 |
| 修改 | `apps/web/src/components/RuntimeInstancesPanel.tsx` | 支持按 preset 过滤和无关联实例分区，复用原操作行 |
| 修改 | `apps/web/src/components/CreateAgentWizard.tsx` | 支持初始分类与创建成功的类型化回调 |
| 修改 | `apps/web/src/index.css` | 工作界面断点、焦点与抽屉样式，沿用令牌 |
| 新增 | `apps/web/test/workspace-state.test.ts` | 状态与持久化的可观察边界 |
| 新增 | `apps/web/test/room-hooks.test.ts` | 查询 key、切换取消、轮询可见性 |
| 新增 | `apps/web/test/workspace.test.ts` | 真 QueryClient 挂载与交互 |
| 新增 | `apps/web/test/graph-scope.test.ts` | 成员过滤、孤点、内部边与输入不变 |
| 新增 | `apps/web/test/assistants.test.ts` | 关联函数和统一页挂载行为 |
| 修改 | `apps/web/test/api.test.ts`、`hooks.test.ts`、`collaboration-controls.test.ts` | 既有接口、已读、重试和进程控制回归 |
| 新增 | `scripts/e2e/chat-first-smoke.mjs` | 真实临时数据库、双房间、单聊、响应式浏览器流程 |
| 修改 | `scripts/e2e/web-smoke.mjs` | 更新导航定位，保留原功能路径 |
| 修改 | `package.json`、`.github/workflows/ci.yml` | 新浏览器冒烟命令及 CI 证据上传 |
| 新增 | `docs/CHAT-FIRST-WORKSPACE.md` | 用户操作说明、版本边界、验收矩阵与证据链接 |
| 修改 | `README.md`、`docs/README.en.md`、`docs/PROJECT-TODO.md`、`CHANGELOG.md` | 只按实际交付同步 |

`packages/shared/src/index.ts` 与 server core 原则上不改。如果实现发现现有协议不足，先记录具体失败与增量合同需求，更新规格并独立评审；不能在导航 PR 中隐式改 schema。

## 三、实施任务

### 任务 0：分支、上下文与验证基线

- [ ] 获取最新 `origin/dev`，核对 `AGENTS.md`、`CLAUDE.md`、规划 issue 与本规格。

```powershell
git fetch origin dev
git status --short
git log -5 --oneline origin/dev
gh issue view 302 --repo yudongyouqing/Conflux
```

- [ ] 保留原工作区改动，使用现有隔离 worktree 或按仓库约定创建 `.worktrees/<branch>`；P1 分支示例 `feat/302-chat-first-home`。每一后继阶段先查询 issue，按该阶段实际 issue 号开分支，避免重复建单。
- [ ] 只在功能实施环境安装依赖、建立基线。当前编写文档不需要重新安装或运行全套测试。

```powershell
npm ci
npm test -w apps/web
npm run build
npm run lint
npm run check:tokens
```

Windows 源路径含空格的原生 rebuild 问题仍由独立 issue 跟踪；需要原生重建时采用无空格隔离检出或 CI，不能清理用户已有检出、安装目录与数据库来绕过。

- [ ] 记录通过/失败命令、基线 commit、环境。若新失败阻碍判断，先定位与隔离，不把它归为既有失败后直接忽略。

### 任务 1：工作界面状态与恢复

文件：新增 `workspace-state.ts`、`workspace-state.test.ts`，暂不更换默认首页。

- [ ] 先写恢复选择与隔离草稿的失败测试。测试数据使用真实 ChatRoom 结构；错误 JSON、相同 id 不同 created_at、列表失败、空列表分别断言。

```ts
test("room id reused with a different creation time is not restored", () => {
  const rooms = [
    { id: 7, name: "新房间", description: null, members: [],
      created_at: "2026-11-05T02:00:00Z", updated_at: "2026-11-05T02:00:00Z" },
    { id: 9, name: "最近房间", description: null, members: [],
      created_at: "2026-11-05T03:00:00Z", updated_at: "2026-11-05T03:00:00Z" },
  ];
  const restored = restoreRoom(rooms, { id: 7, createdAt: "2026-11-04T02:00:00Z" });
  assert.equal(restored?.id, 9);
});
```

- [ ] 运行聚焦命令，确认缺失导出/行为导致失败：

```powershell
node --import tsx --test apps/web/test/workspace-state.test.ts
```

- [ ] 定义以下契约，实现 reducer、校验与 try/catch 存储边界：

```ts
export type ConversationTarget =
  | { kind: "room"; id: number }
  | { kind: "session"; id: string }
  | null;
export interface WorkspacePreference {
  version: 1;
  lastRoom: { id: number; createdAt: string } | null;
  detailsOpen: boolean;
}
export interface Draft { text: string; revision: number }
// Key: room:7 / session:<完整 id>，不得依赖显示名。
export function targetKey(target: Exclude<ConversationTarget, null>): string;
export function restoreRoom(
  rooms: readonly ChatRoom[],
  remembered: WorkspacePreference["lastRoom"],
): ChatRoom | null;
```

草稿 reducer 至少支持 `edit` 与 `submitted`；submitted 携带发送时的 targetKey、revision，只有当前保存 revision 与发送快照相同时才清空。恢复函数只接受成功获得的房间列表，网络失败不调用空列表恢复。

- [ ] 增加 room:7 与 session:7 不冲突、发送后编辑不被清空、存储访问抛错和未知版本回退的断言，聚焦测试通过后提交。

提交建议：`feat(web): model chat targets and safe workspace restoration`。

### 任务 2：房间数据与可见性生命周期

文件：`room-hooks.ts`、`hooks.ts`、`api.ts`、`room-hooks.test.ts`、`hooks.test.ts`。

- [ ] 用已有 `QueryClientProvider` + Testing Library 模式写失败测试：房间 A→B 慢响应不串、隐藏页面不调用 inbox、不查询无效房间 id、不对 mutation 自动重试。测试必须挂载真实 hooks，不用对象快照替代。
- [ ] 运行 `node --import tsx --test apps/web/test/room-hooks.test.ts apps/web/test/hooks.test.ts`，确认新增行为失败。
- [ ] 新增有明确启用条件的房间 hooks；Query key 约定如下：

```ts
["chat-rooms"]
["room-messages", roomId]
["room-tasks", roomId]
["peer-messages", peerId]
```

房间列表五秒、可见目标线程/任务三秒；无目标、非聊天可见态、非法房间 id 时不启动轮询。把 Query 提供的 AbortSignal 传入只读 fetch；挂载对象改变时依靠 key 隔离响应。mutation 设置 `retry: false`，网络失败不由 Query 自动重放。

`useMessages(filters, enabled = true)` 与 `usePeerMessages(peer, enabled = true)` 保持旧调用兼容。`useMessages` 的 queryFn 包括 inbox 请求，enabled=false 时整个 queryFn 不执行。房间创建/入退成员后精确失效房间列表与公共 graph，消息发送后失效提交目标的线程/任务，不更改当前选择。

- [ ] 用 fake timers/Query 配置断言周期，避免真实等待多个五秒。断言一次启用不会启动多份房间列表刷新；非活动 query 即使失效也不自动执行副作用。
- [ ] 聚焦测试通过并运行 `npm test -w apps/web`，提交 `refactor(web): centralize room queries and visibility lifecycle`。

### 任务 3：聊天首页外壳、房间导航与详情

文件：`App.tsx`、`Sidebar.tsx`、`ChatRoomList.tsx`、`WorkspaceTab.tsx`、`WorkspaceDetails.tsx`、`RoomsTab.tsx`、`ChatRoomWizard.tsx`、`index.css`、`workspace.test.ts`。

- [ ] 先写挂载失败测试：首次默认聊天、成功恢复/回退、列表失败显示重试而非引导、创建后选中新房间、删除当前房间后选下一个、后台列表刷新不抢走用户选择。
- [ ] 运行 `node --import tsx --test apps/web/test/workspace.test.ts`，确认失败行为属于新增布局与选择。
- [ ] 上提 rooms/selection/drafts 到工作界面所有者，ChatRoomList 改为受控组件；创建回调传回完整 ChatRoom：

```ts
interface RoomNavigationProps {
  rooms: readonly ChatRoom[];
  selectedRoomId: number | null;
  onSelectRoom: (id: number) => void;
  onCreateRoom: () => void;
}
interface WorkspaceTabProps {
  target: ConversationTarget;
  active: boolean;
  onSelectTarget: (target: ConversationTarget) => void;
}
```

迁移房间卡片中的添加/移出成员和删除确认到详情，确保每个操作使用当前渲染房间的真实 id；删除请求完成后核对该房间仍是当前目标才回退选择。最近会话选择直接建立 session 目标，取消原 `handleSidebarSelect` 强制跳 graph 的行为。

导航保留尚未替代的原 Agents、运行时、图谱入口；移除旧 RoomsTab 之前用 `rg -n 'RoomsTab|ChatRoomList' apps/web` 核对引用全部迁移。

- [ ] 实现 >=1280px 三栏、768—1279px 详情抽屉、<768px 导航/详情互斥抽屉；复用 token，不更改主题色值。Esc 关闭抽屉，焦点回到触发按钮。
- [ ] 单测、web 全套、build、tokens 通过后提交。P1 此时仍需任务 4 完成，不能只交空聊天外壳。

### 任务 4：受控房间聊天与单聊

文件：`RoomChat.tsx`、`PeerConversation.tsx`、`MessageTab.tsx`、`WorkspaceTab.tsx`、`workspace.test.ts`、`api.test.ts`。

- [ ] 写失败的交互回归，最少包括以下可观察断言：

```ts
// A/B 房间请求分别延迟，切到 B 后放行 A 的响应。
assert.equal(view.getByRole("heading", { name: "房间 B" }).textContent, "房间 B");
assert.equal(view.queryByText("只属于 A 的结果"), null);
// 捕获所有出站请求，单聊必须使用既有 webAsk，不使用房间 0。
assert.equal(requests.some((r) => r.url.includes("/chat-rooms/0/")), false);
assert.deepEqual(sentBody, { to_session: "peer-full-id", question: "检查构建" });
```

完整用例再覆盖：重复点击只有一个 mutation、输入法组合 Enter 不发送、重名 @ 发送完整 id、成员离房后失效目标、超时不自动重发、提交完成保留新修订草稿。

- [ ] 聚焦运行并确认修复前失败。新增测试使用 `test`、`assert` 和真实 QueryClient；不能只检查源码包含某字符串。
- [ ] 从 MessageTab 提取 peer 分支到 PeerConversation，保留原 edge 分支和发言身份。PeerConversation 以 `peerId`、`draft`、`onDraftChange`、`onSubmitted(targetKey, revision)` 为受控输入；读取 usePeerMessages，提交沿用 api.webAsk。
- [ ] RoomChat 改用任务 2 hooks 与上层草稿；定向调用原 summon、广播调用原 broadcast。捕获提交时 room/peer/草稿 revision，成功后仅更新该目标；不用当前 render 中可能已改变的目标补参数。切换页面不触发外部动作。
- [ ] 运行 web 全套、build、lint；用真实临时库确认空房间、建房、成员操作、房间发送和单聊 URL。P1 PR 描述附桌面/窄屏截图及仍保留的旧入口，关联规划 issue，保持 issue 开放。

提交建议：`feat(web): make room and peer conversations the default workspace`。

### 任务 5：房间图谱与全局范围

文件：`graph-scope.ts`、`GraphTab.tsx`、`WorkspaceTab.tsx`、`App.tsx`、`graph-scope.test.ts`、`workspace.test.ts`。

- [ ] 写纯函数失败测试：A/B 在房间内、C 在外；保留 A→B 与孤立成员 D，去掉 B→C，保持 channel id/方向，输入对象未改动。
- [ ] 运行 `node --import tsx --test apps/web/test/graph-scope.test.ts` 确认缺少函数失败。
- [ ] 实现范围过滤，并将房间成员 id 原样传入：

```ts
import type { Graph } from "@conflux/shared";
export function scopeGraphToRoom(graph: Graph, members: readonly string[]): Graph {
  const ids = new Set(members);
  return {
    nodes: graph.nodes.filter((node) => ids.has(node.id)),
    edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
  };
}
```

GraphTab 接受外部 Graph、范围 key、active/loading/error 和既有选择回调，不再内部调用 useGraph。房间范围用包含所有成员的构图路径；全局保留原 active/dirs/all 控件。数据范围变化先校验节点/边选择再复用现有构图函数。

- [ ] 把 GraphTab import 改为 lazy；仅保留一个图谱渲染器，按 room:<id> / global 在工作界面内保存 viewport 与拖拽位置的 Map。切换范围先保存旧视口与位置，再恢复目标范围；不为每个房间常驻 React Flow 树。active=false 时不运行布局 effect、fitView 定时器和键盘事件；再次 active 时刷新一次。不新增全局 graph 数据请求。
- [ ] 挂载测试断言初始聊天没有图谱、切换保持草稿、房间图无越界边、全局返回原目标；浏览器验证视口保留。全局图节点选择只开详情，显式按钮才进入对话。

提交建议：`feat(web): add room-scoped graph beside conversations`。

### 任务 6：活动记录与性能生命周期收口

文件：`MessageTab.tsx`、`App.tsx`、`Sidebar.tsx`、`hooks.ts`、`workspace.test.ts`、`hooks.test.ts`。

- [ ] 写失败测试：启动聊天时没有 /messages/inbox；进入活动记录才执行既有 inbox 逻辑；返回聊天停止活动轮询；外部 A→B channel 打开后两端和 channel id 不变。
- [ ] 将消息流入口改为活动记录，保留筛选、详情与重试；带明确 peer 的「打开对话」回到工作界面，外部 channel 继续使用原边对话，不自动切换为 web-console 视角。
- [ ] 保留各视图已访问状态与滚动位置，给活动/设置等低频组件明确 active 标志。隐藏 mutation 的结果可以完成写缓存，不能改变当前目标或自动弹回页面。
- [ ] 使用浏览器 network/trace 核对首次聊天未加载 React Flow 渲染 chunk、隐藏图谱无重算、未访问活动页无 inbox。记录固定 fixture 的前后数据，不设置未经多设备验证的通用耗时门槛。
- [ ] web 全套、build、lint、tokens 通过后形成 P2 PR。提交建议 `refactor(web): preserve activity history and pause hidden views`。

### 任务 7：助手目录投影与关联边界

文件：`assistant-catalog.ts`、`assistants.test.ts`。

- [ ] 写失败测试：模型/编码同 id 同名、不同 preset 同名、同 preset 多实例、会话无 preset、实例无 preset、session_id 未绑定、预设 live 与真实实例状态冲突。
- [ ] 运行 `node --import tsx --test apps/web/test/assistants.test.ts`，确认缺失投影函数失败。
- [ ] 定义最小前端投影接口，保持原始对象不含新业务规则：

```ts
interface CodingAssistantItem {
  key: `coding:${number}`;
  preset: RuntimeAgent;
  instances: RuntimeInstance[];
  sessions: GraphNode[];
}
interface AssistantCatalog {
  coding: CodingAssistantItem[];
  models: Array<{ key: `model:${number}`; agent: Agent }>;
  orphanInstances: RuntimeInstance[];
}
```

导出 `buildAssistantCatalog(agents, presets, instances, nodes)`：只按 `preset_id`、节点 `agent_id` 和实例 `session_id` 精确关联；不按名称、标题、目录或时间接近猜关联。已有实例 session_id 的匹配优先，节点 metadata 派生关联作为补充，最终按 session id 去重。

- [ ] 聚焦测试验证同名不同对象不串、全部实例保留、未绑定实例没有虚构会话；API 密钥、extra_env 不进入摘要、搜索字段或持久化投影。
- [ ] 通过后提交 `refactor(web): project assistant presets and runtime instances by identity`。

### 任务 8：统一助手页面与分类创建

文件：`AssistantsTab.tsx`、`AgentTab.tsx`、`RuntimesTab.tsx`、`RuntimeInstancesPanel.tsx`、`CreateAgentWizard.tsx`、`App.tsx`、`Sidebar.tsx`、`assistants.test.ts`、`collaboration-controls.test.ts`。

- [ ] 写挂载失败测试：一个助手入口、当前分类直接创建、创建后定位新对象、模型助手独立聊天、编码助手多个实例、孤儿实例可见、权限禁用与 limitation 原样显示。
- [ ] 分类创建契约使用判别联合，避免两个不同接口返回的 id 混用：

```ts
type CreatedAssistant =
  | { kind: "coding"; id: number }
  | { kind: "model"; id: number };
interface CreateAssistantOptions {
  initialKind: "coding" | "model";
  onCreated: (created: CreatedAssistant) => void;
}
```

对外文案使用编码/模型；内部现有 WizardKind agent/runtime 可在一个适配位置转换。创建成功回传结果，不同时实现第二套创建表单。

- [ ] 助手页复用现有列表、ChatPanel、PtyPanel、RuntimeInstanceRow。实例 panel 支持传入受控实例集合，旧独立调用默认行为保留到所有引用迁移完成。确认没有多个列表同时发起相同轮询。
- [ ] 删除「在线/离线预设」分栏，展示实例状态及独立会话状态；启动按钮调用原接口，starting 实例先出现，真实 session_id 到达后才启用打开会话。停止/恢复只服从 can_stop/can_resume，按钮禁用时仍可阅读 limitation。
- [ ] 类型切换/导航切换不执行 start/stop/resume，不关闭真实 CLI；PTY 隐藏时取消浏览器订阅、显示时重连。模型列表不提供入房按钮，外部会话仍能从聊天侧栏访问。
- [ ] 迁移完成再移除原主导航 Agents/运行时重复入口，保持设置可达。web 全套、build、lint、tokens 和浏览器交互通过后创建 P3 PR，行为变更保持待审。

提交建议：`feat(web): unify coding and model assistant management`。

### 任务 9：真实 API 浏览器验收与自动化

文件：`scripts/e2e/chat-first-smoke.mjs`、`scripts/e2e/web-smoke.mjs`、`package.json`、`.github/workflows/ci.yml`、`docs/CHAT-FIRST-WORKSPACE.md`。

- [ ] 复用现有 e2e 的临时 CONFLUX_HOME、VITE_API_TARGET、子进程日志与有界退出方式。新增脚本必须先检查端口；同一 checkout 的 e2e 串行运行，不复用真实服务。
- [ ] 脚本通过真实 HTTP API 建立两个房间、三个受控假会话、内外部消息边。假会话只用于数据/UI 验收，不把它写成真实 Codex/Claude 验收；设置禁用自动唤醒/外部动作的隔离 fixture，发送仍走真实 API。
- [ ] 自动断言：默认聊天、恢复房间、切换草稿、单聊 URL、@完整 id、房间图范围、活动边对话、助手分类、设置可达；mutation 后查询临时库/API 核对数量，不只检查 toast。
- [ ] 新增根命令并在普通 CI 的浏览器验证 job 串行执行，失败上传有界日志与截图：

```json
"test:e2e:chat-first": "npm run build -w packages/shared && node scripts/e2e/chat-first-smoke.mjs"
```

```powershell
npm run test:e2e:web
npm run test:e2e:chat-first
```

- [ ] 1440×900、1024×768、390×844、320×740 各保存截图；检查浅色/深色、长名称、长路径、空态、加载失败、重名成员、抽屉焦点和输入法行为。生成 commit、环境、命令、结果、跳过原因与原始证据路径清单，不提交真实消息或凭证。

### 任务 10：实际打包入口验收、文档与阶段收尾

文件：`docs/CHAT-FIRST-WORKSPACE.md`、`README.md`、`docs/README.en.md`、`docs/PROJECT-TODO.md`、`CHANGELOG.md`。

- [ ] 完成以下受影响检查；不要在这些通过后无理由重复长测：

```powershell
npm test -w apps/web
npm run build
npm run lint
npm run check:tokens
npm run test:desktop
node --test scripts/release-config.test.cjs
npm run check:secrets
```

若触及 server/shared 协议或生产进程逻辑，再补受影响的 server 测试与 `npm run test:process-e2e -w apps/server`，后二者不能在高负载下互相并行。本计划正常范围无需重新跑 30 分钟 soak，也无需重录数据库基线。

- [ ] 使用当前候选提交的打包产物，先验证包版本和 hash、原生模块 smoke，再证明 dataDir/userData/sessionData 隔离。打包后执行图谱/聊天/助手导航和正常退出，记录健康状态、自己的 PID、端口释放。
- [ ] 单独验证安装路径和快捷方式：使用独立测试目录与快捷方式，保留安装前的真实桌面入口；核对快捷方式 TargetPath→文件 ProductVersion→运行 app.getVersion 三者一致，并从该入口启动。仅运行解包目录不能标记「安装与快捷方式验收」通过。测试启动必须继承已证明的隔离环境，不能双击默认配置来试真实库。
- [ ] 若需要更新用户日常桌面入口，先准备具体候选与验证结果，沿用用户对该安装更新的实际授权；没有授权时保持现有入口不变。旧安装/QA 目录不做顺手清理；不按名称结束全部 node、Conflux 或 OpenConsole。
- [ ] 更新规格 A01—A13 的证据映射；缺设备/真实宿主的记录保持未完成并关联 #267/#288/#289。只把实际已交付项目勾选，CHANGELOG 放在 Unreleased，不把 dev 的代码写成现有已发布包能力。
- [ ] 每次推送前明确告诉用户分支和提交，再执行 `git push`；用 gh 创建 PR，正文说明触发场景、最终行为、验证和剩余边界。不要用 `Closes #302` 提前关整个规划；仅 P1—P4 证据齐全后关闭该批次，P5 是独立项目。

## 四、验收映射与审查检查点

| 规格验收 | 对应任务 | 检查点 |
| --- | --- | --- |
| A01/A02 | 1、2、3 | P1 默认选择与失败路径 |
| A03/A04/A05 | 2、3、4、9 | P1 真实发送与成员管理 |
| A06/A07 | 5、6、9 | P2 作用域与隐藏生命周期 |
| A08/A09/A10 | 7、8、9 | P3 助手与安全守卫 |
| A11 | 4、6、9 | 活动与 edge 视角回归 |
| A12 | 3、8、9 | 四种宽度及键盘 |
| A13 | 10 | 包、安装路径、快捷方式和实际版本 |

每个 PR 的审查重点：身份 id 是否原样保留；页面切换是否产生外部动作；慢响应是否修改错误目标；隐藏组件是否仍有副作用；权限是否由服务端字段决定；新增 UI 是否让模型助手看起来已能进群；截图是否来自被验收的构建。

本轮计划完成不表示以上复选框可以勾选。实施开始时按 P1 顺序执行，在每阶段 PR 中报告变更、测试与剩余项；功能 PR 不因 CI 绿色自动合并。main、tag、发布继续按仓库规则与用户当次授权处理。
