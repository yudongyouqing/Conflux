# 对话通道代码高亮 实施计划

> Spec：`2026-09-17-channel-highlight-design.md` · Issue #13

## 步骤

1. `npm install rehype-highlight -w apps/web`
2. `MarkdownText.tsx`：接入 `rehypePlugins={[rehypeHighlight]}`；code 组件按 `language-*` 分流围栏/行内；`pre` 增加相对定位容器与语言标签
3. `index.css`：引入 `highlight.js/styles/github-dark.css`（放自有样式之前，避免覆盖组件基色）
4. 新增 `apps/web/test/markdown-highlight.test.ts`（renderToStaticMarkup 断言 hljs token 类）
5. 验证：`npm run lint`、`npm test -w apps/web`、`npm run build`、Playwright 截图
6. 提交：`docs: specify` → `docs: plan` → `feat(web): 对话通道代码块语法高亮`，PR → dev（feat 级，绿后停 open 等用户合并）
