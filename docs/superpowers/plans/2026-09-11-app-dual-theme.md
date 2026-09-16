# Application Dual Theme Implementation Plan

> **For the implementing agent:** Required sub-skill: use `superpowers-zh:executing-plans` to implement this plan task by task.

**Goal:** Add persistent system/light/dark application themes so the complete web UI has a coherent workbench light mode and terminal-inspired dark mode.

**Architecture:** A pure `theme.ts` module owns preference normalization and root-attribute application. A Vite module executes before the React entrypoint to prevent a wrong-theme flash under the existing strict CSP. CSS variables and scoped dark utility overrides supply application-wide colors, while graph renderers use semantic CSS variables for their inline SVG colors.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind CSS, React Flow, Node test runner with `tsx`.

---

## File Structure

- Create: `apps/web/src/theme.ts` - theme types, persistence, resolution, root application, and system-preference listener.
- Create: `apps/web/src/theme-bootstrap.ts` - applies the saved resolved theme before the React entrypoint.
- Create: `apps/web/test/theme.test.ts` - browser-independent tests for normalization, resolution, persistence, and system changes.
- Modify: `apps/web/index.html` - load `theme-bootstrap.ts` before `main.tsx` as external modules allowed by the CSP.
- Modify: `apps/web/package.json` - run every `test/*.test.ts` file, including the new theme tests.
- Modify: `apps/web/src/index.css` - semantic variables, dark-mode utility adaptation, React Flow, Markdown, and focus styling.
- Modify: `apps/web/src/components/SettingsTab.tsx` - add the three-choice visual-theme segmented control.
- Modify: `apps/web/src/App.tsx`, `apps/web/src/components/Sidebar.tsx` - use semantic shell surfaces instead of fixed light-only colors.
- Modify: `apps/web/src/components/GraphTab.tsx`, `apps/web/src/graph-builders.ts`, `apps/web/src/components/CurvedPairEdge.tsx`, `apps/web/src/components/SessionNode.tsx`, `apps/web/src/components/GroupFrame.tsx` - make graph canvas, node, edge, label, selection, and dimming colors theme-aware.
- Modify: `apps/web/src/components/DetailPanel.tsx`, `apps/web/src/components/MarkdownText.tsx`, `apps/web/src/components/ChatPanel.tsx`, `apps/web/src/components/MentionComposer.tsx`, `apps/web/src/components/MessageCard.tsx`, `apps/web/src/components/MessageTab.tsx`, `apps/web/src/components/SessionsTab.tsx`, `apps/web/src/components/AgentTab.tsx`, `apps/web/src/components/RuntimesTab.tsx`, `apps/web/src/components/StatusDot.tsx` - retain existing roles and interactions while migrating hard-coded surfaces and text to theme-safe colors.

### Task 1: Establish And Test Theme Semantics

**Files:**
- Create: `apps/web/src/theme.ts`
- Create: `apps/web/test/theme.test.ts`
- Modify: `apps/web/package.json`

- [ ] **Step 1: Write failing pure-theme tests**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeThemePreference, resolveTheme } from "../src/theme.ts";

test("invalid saved theme falls back to system and system resolves from media preference", () => {
  assert.equal(normalizeThemePreference("terminal"), "system");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});
```

- [ ] **Step 2: Run the focused test to confirm it fails**

Run: `npm test -w apps/web -- theme.test.ts`

Expected: FAIL because `theme.ts` does not exist.

- [ ] **Step 3: Implement the pure theme contract**

```ts
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === "light" || preference === "dark") return preference;
  return prefersDark ? "dark" : "light";
}
```

Add dependency-injected DOM helpers in the same module to read/write the `muiltchat.theme` key, set `document.documentElement.dataset.theme`, and listen only while preference is `system`.

- [ ] **Step 4: Extend tests for persistence and live system changes**

Use a small fake storage, root element, and media-query listener object. Assert that selecting `dark` persists and applies `dark`, a manual choice ignores media events, and `system` responds to a media event.

- [ ] **Step 5: Run all web unit tests**

Run: `npm test -w apps/web`

Expected: PASS, including existing graph-builder tests and new theme tests. Update the package test command to `node --import tsx --test "test/*.test.ts"` if required for discovery.

- [ ] **Step 6: Commit the foundation**

```bash
git add apps/web/src/theme.ts apps/web/test/theme.test.ts apps/web/package.json
git commit -m "feat(web): add theme preference foundation"
```

### Task 2: Apply Theme Before First Paint And Expose The Setting

**Files:**
- Create: `apps/web/src/theme-bootstrap.ts`
- Modify: `apps/web/index.html`
- Modify: `apps/web/src/components/SettingsTab.tsx`

- [ ] **Step 1: Write the bootstrap assertion in the pure-theme test**

```ts
test("applyTheme marks the root with the resolved theme", () => {
  const root = { dataset: {} as Record<string, string> };
  applyTheme(root, "system", true);
  assert.equal(root.dataset.theme, "dark");
});
```

- [ ] **Step 2: Run the focused test to confirm it fails**

Run: `npm test -w apps/web -- theme.test.ts`

Expected: FAIL because `applyTheme` is not exported yet.

- [ ] **Step 3: Create the CSP-safe bootstrap module and load it first**

```ts
// apps/web/src/theme-bootstrap.ts
import { installTheme } from "./theme";

installTheme(window, document);
```

```html
<script type="module" src="/src/theme-bootstrap.ts"></script>
<script type="module" src="/src/main.tsx"></script>
```

Keep both scripts external. Do not add an inline script or weaken the
`script-src 'self'` CSP directive.

- [ ] **Step 4: Add the Settings segmented control**

Render `跟随系统`, `工作台`, and `终端` as a three-option `<fieldset>` in
`SettingsTab`. Its selected value comes from `getThemePreference()` and each
choice calls `setThemePreference()` immediately; no server save button or API
mutation is involved. Use `aria-pressed` or native radio inputs so the current
choice is exposed to assistive technology.

- [ ] **Step 5: Run focused tests and build**

Run: `npm test -w apps/web -- theme.test.ts`

Expected: PASS.

Run: `npm run build -w apps/web`

Expected: PASS; Vite emits both the bootstrap and application modules.

- [ ] **Step 6: Commit the user-facing selection flow**

```bash
git add apps/web/index.html apps/web/src/theme-bootstrap.ts apps/web/src/components/SettingsTab.tsx apps/web/src/theme.ts apps/web/test/theme.test.ts
git commit -m "feat(web): add application theme selector"
```

### Task 3: Create Global Theme Tokens And Adapt The Application Shell

**Files:**
- Modify: `apps/web/src/index.css`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/Sidebar.tsx`
- Modify: `apps/web/src/components/SettingsTab.tsx`
- Modify: `apps/web/src/components/AgentTab.tsx`
- Modify: `apps/web/src/components/MessageTab.tsx`
- Modify: `apps/web/src/components/RuntimesTab.tsx`
- Modify: `apps/web/src/components/SessionsTab.tsx`

- [ ] **Step 1: Add a failing CSS-token assertion**

Add a file-content test that reads `src/index.css` and asserts both root
attributes define `--surface`, `--canvas`, `--text-primary`, and
`--border-subtle`. This prevents the dark theme from becoming an accidental
partial inversion.

```ts
assert.match(css, /html\[data-theme="dark"\][\s\S]*--surface:/);
assert.match(css, /html\[data-theme="light"\][\s\S]*--canvas:/);
```

- [ ] **Step 2: Run the focused test to confirm it fails**

Run: `npm test -w apps/web -- theme.test.ts`

Expected: FAIL because no theme token blocks exist.

- [ ] **Step 3: Define tokens and scoped adaptation rules**

Define light and dark values for canvas, surface, raised surface, border,
primary/muted text, focus, selected edge, dimmed edge, question, reply,
warning, and danger. Update `body` to use variables. Add narrowly scoped dark
rules for the existing Tailwind surface/text utilities used across list and
card components, preserving semantic blue/emerald/amber/red feedback colors.

- [ ] **Step 4: Migrate shell and tab surfaces**

Replace fixed `bg-white`, `bg-gray-*`, `border-gray-*`, and neutral text
classes on app shell, sidebar, settings cards, and tab/list containers with
the shared theme-safe classes or CSS variables. Do not alter action colors,
data loading, selection behavior, or layout dimensions.

- [ ] **Step 5: Run tests and inspect both resolved themes**

Run: `npm test -w apps/web`

Expected: PASS.

Run: `npm run build -w apps/web`

Expected: PASS.

Start the web development server and inspect the graph, Sessions, Messages,
Agents, Runtimes, and Settings tabs with the root attribute set to each theme.

- [ ] **Step 6: Commit the global visual system**

```bash
git add apps/web/src/index.css apps/web/src/App.tsx apps/web/src/components/Sidebar.tsx apps/web/src/components/SettingsTab.tsx apps/web/src/components/AgentTab.tsx apps/web/src/components/MessageTab.tsx apps/web/src/components/RuntimesTab.tsx apps/web/src/components/SessionsTab.tsx apps/web/test/theme.test.ts
git commit -m "feat(web): adapt application surfaces to themes"
```

### Task 4: Adapt Graph And Conversation Semantics

**Files:**
- Modify: `apps/web/src/graph-builders.ts`
- Modify: `apps/web/src/components/GraphTab.tsx`
- Modify: `apps/web/src/components/CurvedPairEdge.tsx`
- Modify: `apps/web/src/components/SessionNode.tsx`
- Modify: `apps/web/src/components/GroupFrame.tsx`
- Modify: `apps/web/src/components/DetailPanel.tsx`
- Modify: `apps/web/src/components/MarkdownText.tsx`
- Modify: `apps/web/src/components/ChatPanel.tsx`
- Modify: `apps/web/src/components/MentionComposer.tsx`
- Modify: `apps/web/src/components/MessageCard.tsx`
- Modify: `apps/web/src/components/StatusDot.tsx`
- Modify: `apps/web/test/graph-builders.test.ts`

- [ ] **Step 1: Update graph selection expectations to semantic color variables**

Replace literal blue/gray stroke assertions with variable-backed expected
values. Add one test that selected, incident, and dimmed edges use distinct
semantic token strings.

```ts
assert.equal(styled[0]!.style!.stroke, "var(--graph-edge-selected)");
assert.equal(styled[1]!.style!.stroke, "var(--graph-edge-dimmed)");
```

- [ ] **Step 2: Run the graph test to confirm it fails**

Run: `npm test -w apps/web -- graph-builders.test.ts`

Expected: FAIL because graph styles still contain literal hex values.

- [ ] **Step 3: Replace graph renderer literals with semantic variables**

Use `var(--graph-edge-selected)`, `var(--graph-edge-incident)`, and
`var(--graph-edge-dimmed)` in `styleEdges`, edge markers, custom SVG paths,
node rings, frame borders, canvas/grid/minimap styles, and React Flow controls.
Keep edge width, animation, click/drag behavior, and the selected-edge label
rules unchanged.

- [ ] **Step 4: Migrate channel and message surfaces without changing roles**

Apply theme-safe surfaces to the channel header, message metadata, composer,
pending state, Markdown code/table/link rendering, ChatPanel, MessageCard,
and mention controls. Questions remain right-aligned with the theme question
token; replies remain left-aligned with the reply token and reply badge.

- [ ] **Step 5: Run targeted and full web checks**

Run: `npm test -w apps/web`

Expected: PASS.

Run: `npm run build -w apps/web`

Expected: PASS.

- [ ] **Step 6: Commit graph and channel theming**

```bash
git add apps/web/src/graph-builders.ts apps/web/src/components/GraphTab.tsx apps/web/src/components/CurvedPairEdge.tsx apps/web/src/components/SessionNode.tsx apps/web/src/components/GroupFrame.tsx apps/web/src/components/DetailPanel.tsx apps/web/src/components/MarkdownText.tsx apps/web/src/components/ChatPanel.tsx apps/web/src/components/MentionComposer.tsx apps/web/src/components/MessageCard.tsx apps/web/src/components/StatusDot.tsx apps/web/test/graph-builders.test.ts
git commit -m "feat(web): theme graph and channel conversations"
```

### Task 5: Full Regression And Visual Verification

**Files:**
- Modify only if verification exposes a concrete defect in the files above.

- [ ] **Step 1: Start the local application**

Run: `npm run dev -w apps/server` and `npm run dev -w apps/web` on available
ports. Use the local UI test workflow to open the web application.

- [ ] **Step 2: Capture desktop and narrow screenshots for both themes**

At desktop and narrow viewport widths, select each preference: `system`,
`light`, and `dark`. In light and dark resolved themes verify the sidebar,
graph canvas, selected edge, dimmed edges, node endpoint rings, a channel with
pending and replied messages, Markdown code, settings, and an empty detail
panel. Confirm no text overlaps, clips, or loses contrast.

- [ ] **Step 3: Verify persistence and system behavior manually**

Reload after selecting `light` and `dark`; each must remain selected. Clear
the storage key and reload; the control must show `system`. Emulate a dark
system preference while `system` is selected and verify the root attribute
changes to `dark`; select `light` and verify later system changes do not alter
it.

- [ ] **Step 4: Run repository regression commands**

Run: `npm test -w apps/server`

Expected: PASS.

Run: `npm test -w apps/web`

Expected: PASS.

Run: `npm run test:desktop`

Expected: PASS.

Run: `npm run lint`

Expected: no new errors; report any pre-existing warnings separately.

Run: `npm run build`

Expected: PASS.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 5: Commit any verification-only fixes and prepare the branch**

```bash
git add apps/web/index.html apps/web/package.json apps/web/src/theme.ts apps/web/src/theme-bootstrap.ts apps/web/src/index.css apps/web/src/App.tsx apps/web/src/graph-builders.ts apps/web/src/components apps/web/test/theme.test.ts apps/web/test/graph-builders.test.ts
git commit -m "fix(web): polish dual theme states"
```

Do not commit `.superpowers/` prototype files.
