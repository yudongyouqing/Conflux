# 对话通道代码高亮 设计

> Issue #13「对话通道加上高亮显示」
> 日期：2026-09-17 · 分支：feat/13-channel-highlight

## 问题

对话通道的气泡（MessageTab 线程、DetailPanel 上下文）经 `MarkdownText` 渲染 Markdown，但围栏代码块只是深底白字的纯文本——AI 会话往来携带大量代码，无语法高亮可读性差。

## 方案

- 引入 `rehype-highlight`（highlight.js/lowlight，react-markdown 官方搭配）作为 `MarkdownText` 的 rehype 插件，围栏代码块按语言高亮
- 代码块深色底（现状 `bg-gray-900`）在明暗双主题下均保留，故统一用 github-dark 配色（在 `index.css` 引入 hljs 主题 CSS）
- 围栏块右上角显示语言标签（如 `ts`），无语言时显示 `code`
- 行内 code 维持现状粉色高亮，不受影响

## 非目标

- ChatPanel（Agent 流式聊天）目前渲染纯文本，不在通道定义内，不动
- MessageCard 列表摘要保持 truncate 纯文本（列表态不渲染高亮）

## 测试

- `apps/web/test/markdown-highlight.test.ts`：用 `react-dom/server` 的 `renderToStaticMarkup` 渲染含 ```ts 围栏的 Markdown，断言输出含 `hljs-keyword` 等 token 类与 `language-ts` 标记
- 验证：lint / web 测试 / build / Playwright 截图（含代码的通道气泡）
