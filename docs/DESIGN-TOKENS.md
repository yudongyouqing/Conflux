# 设计令牌规范 / Design Tokens

> Conflux 工作空间的视觉单一事实源。新组件**必须**使用令牌，禁止裸灰阶/裸阴影字面量。
> 本文档与 `apps/web/tailwind.config.js` 对应——改令牌先改这里，再改配置，两边保持一致。

## 为什么有这套规范

在引入令牌前，应用有 40+ 种随手灰阶、从未加载的字体声明、8px 不可读字号和遍地的同款 `shadow-sm`——典型的"AI 生成观感"。规范的目的不是限制创造力，而是把**不需要每次重新决定的事**固定下来，把注意力留给真正需要设计判断的地方。

规范成形于 #45/#46/#48/#50，方法论来自官方 `frontend-design` 技能（`.claude/skills/frontend-design/`）。

## 一、色彩令牌

### 文字与层级

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `text-ink` | `#182234` | 标题、正文主色（蓝黑，呼应画布 navy） |
| `text-ink-muted` | ink / 76% | 次级说明、辅助文字 |
| `text-ink-faint` | ink / 66% | 提示、占位、时间戳；默认明暗主题在表面与 active 行上达到 4.5:1 |

### 表面与边界

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `bg-paper` | `#F6F7F9` | 画布底、页面底 |
| `bg-surface` | `#FFFFFF`（浅色）/ `#172030`（深色） | 卡片、面板面，随主题切换 |
| `border-line` | `#E4E8EF` | 常规 hairline 边框 |
| `border-line-strong` | `#CBD3E0` | hover 强调边框、实线分隔 |

### 强调色（全局唯一）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `accent` / `bg-accent` | `#2563EB` | 品牌汇流蓝——主操作、选中态、焦点 |
| `accent-deep` | `#1E4FC4` | hover 加深 |
| `accent-soft` / `bg-accent-soft` | `#EBF1FE` | 选中底色 |
| `text-on-accent` | 自动选择白色或深墨色 | `bg-accent hover:bg-accent-deep` 按钮文字；不得固定 `text-white` |

### 状态色（只表达状态，不参与装饰）

| 语义令牌 | 浅色文字 / 软底 | 深色文字 / 软底 | 用途 |
| --- | --- | --- | --- |
| `success` | `#16734C` / `#E8F4ED` | `#74D4A5` / `#153A2B` | 在线、成功、送达 |
| `warning` | `#895600` / `#FFF2D6` | `#EDC16C` / `#3E321E` | 忙碌、等待、需要留意 |
| `danger` | `#B33440` / `#FCECEF` | `#F797A0` / `#44252D` | 真实错误、失败、破坏性操作 |
| `info` | `#215DB0` / `#EAF1FC` | `#8AB9FF` / `#203750` | 已读、说明、中间进度 |
| `neutral` | `#5C677D` / `#EDF0F5` | `#A7B3C7` / `#293343` | 离线、已结束、不活跃 |

用法：`text-success bg-success-soft`，其余语义同理；圆点用 `bg-success`，边界可用 `border-success/30`。所有语义文字在默认明暗主题的 `paper`、`surface` 和对应软底上达到 4.5:1。状态同时提供文案或可访问标签，不能只靠颜色辨认。已结束不是错误，不能标红。

语义色由 `data-theme` 的明暗模式选择，独立于品牌强调色。自定义主题继续导入原来的 8 键；无需补充语义色。任意导入色板仍由作者保证自身文字/背景对比度，应用不会改写用户保存的色值。

**规则**：状态色永远绑定语义（有状态徽标/圆点的地方才用），不做渐变、不做装饰性点缀。强调色只有 accent 蓝一种；orange（claude）、slate（codex）、indigo（agent）属于**运行时身份色**，只在图节点身份块等运行时识别场景使用。

### 禁止裸灰阶

组件里**不得**出现 `text-gray-*`、`bg-gray-*`、`border-gray-*`（深色按钮、遮罩等刻意对比除外，见「刻意例外」）。旧代码迁移映射：

| 原值 | 令牌 |
| --- | --- |
| `text-gray-900` / `700` / `800` | `text-ink` |
| `text-gray-500` / `600` | `text-ink-muted` |
| `text-gray-300` / `400` | `text-ink-faint` |
| `bg-gray-50` / `100` | `bg-paper` |
| `border-gray-100` / `200` | `border-line` |
| `border-gray-300` / `bg-gray-200` | `border-line-strong` / `bg-line` |

## 二、字体

- **UI 文本**：`IBM Plex Sans`（自托管 woff2，400/500/600；中文回退 PingFang SC / Microsoft YaHei）
- **终端数据**：`IBM Plex Mono`（400/500）——`font-mono` 类

**mono 的语义边界**：只用于真正的终端数据——路径、id、代码、CLI 命令、运行时标签（`claude`/`codex`，小写）。会话名、按钮文案、说明文字一律 sans。**不要**用 mono 做装饰性标签。

字体文件在 `apps/web/public/fonts/`（latin 子集，共 ~296KB）；新增字重时同步更新 `src/index.css` 的 `@font-face`。

### 字阶（11px 地板）

| 值 | 用途 |
| --- | --- |
| `11px` | 微标签下限、次级正文、描述 |
| `12px` | 正文、节点标题 |
| `13px` | 消息、导航项 |
| `14px` | 面板标题 |
| `15px`+ | 区块大标题 |

## 三、阴影（只给浮起物）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `shadow-card` | 1px + 2px 极浅 | 卡片静态——贴在纸面上，不是浮空 |
| `shadow-raised` | 4px + 16px | hover 抬升、下拉、选中 |
| `shadow-overlay` | 12px + 32px | 模态、拖拽中的节点 |

**规则**：静止的列表/卡片不加影或只加 `shadow-card`；影是"这东西浮起来了"的信号（hover/拖拽/弹层/选中），不是装饰。

## 四、圆角与间距

- 圆角随层级：小件 `rounded-md/lg`（chip、输入框）→ 卡片 `rounded-xl` → 弹层 `rounded-2xl`。不要全局一种圆角。
- 间距走 4 的倍数（4/8/12/16/20/24）。

## 五、运行时品牌图标

`apps/web/src/components/brand-icons.tsx`：`ClaudeIcon`（星芒）/ `OpenAIIcon`（结花）。path 来自 simple-icons（CC0），单色 glyph——**身份色由所在色块提供**（claude 橙块 / codex 石墨块）。props 与 lucide 一致（`size`/`className`），可互换。

## 六、反模式清单（from frontend-design）

写新界面时自查，命中任意一条就改：

1. **同款卡片套装**——所有东西同圆角 + 同 `shadow-sm` + 1px 灰边。层级靠阴影分级和圆角分级表达，不是人手一套。
2. **ALL-CAPS 微标签**——`uppercase tracking-wide` 的 9px 标签。运行时标签用 mono 小写；其余用常规 case。
3. **middle-dot 装饰串**——`A · B · C` 式元信息拼接。middle-dot 只在真的承载信息分隔时用（如"3 条 · 最新在上"），不为风格而加。
4. **单字重排版的"强调"**——给标题里某个词单独上色/斜体。强调用字重（500/600）或字号，不用花体。
5. **装饰性动效**——每张卡片 hover 都 fade-slide、每个区块入场都动画。动效回答用户动作（打开/展开/确认），非用户触发的动效一个页面最多一处。
6. **低于 11px 的字号**——不可读；主列表内容最低 12px。

## 七、刻意例外（不是漂移）

以下用法是**有意的**，review 时不要"顺手修掉"：

- 深色主按钮 `bg-gray-800 text-white`（RuntimesTab「新建」等）——刻意的重操作对比
- 模态遮罩 `bg-gray-900/30`
- `placeholder-gray-400`——placeholder 属于"未填"状态，弱于 ink-faint 的语义分层
- 流式光标 `bg-gray-400 animate-pulse`
- 图拓扑的 Dify 式节点阴影（`#42` 引入的分层软阴影体系，独立于三级令牌）

## 八、验证

- UI 改动：`npx playwright screenshot` 截图自查（CLAUDE.md 验证清单第 5 条）
- 新增界面过一遍第六节反模式清单
- 令牌值变更：先改本文档 → 再改 `tailwind.config.js` → PR 里两处一起出现


## P2 令牌升级（#109，2026-09-24）

- **次级文字 alpha 派生**：`ink-muted` = `rgb(var(--tk-ink) / 0.76)`、`ink-faint` = `/ 0.66`——不再独立取色。色板导入格式从 10 键减为 8 键（inkMuted/inkFaint 退役，旧 bundle 兼容忽略）。默认明暗色板通过对比度回归测试；任意导入色板的可读性取决于自身 ink 与表面色的搭配。
- **tile 色块三档**：`bg-tile` = ink/3.5%、`bg-tile-hover` = /6%、`bg-tile-active` = /9%。行级内嵌结构（列表行、工具行、设置行）用色块分层，不用描边；行 hover 统一 `hover:bg-tile-hover`。
- **字阶**：新增 `text-2xs`(11px)、`text-md-plus`(13.5px)、`text-base-plus`(15px)；**11px 为任意值字号的地板**（`npm run check:tokens` 守卫，随 ci:test 执行）。主列表内容最低 `text-xs`(12px)。
- **阴影原则不变**：浮起物才有影；行内分层优先 tile 色块。
