# Repository Guidelines

## Project Structure & Module Organization

This repository is an npm workspaces monorepo for Conflux (legacy alias `muiltchat`). The server and CLI live in `apps/server/src`; HTTP routes, core SQLite logic, MCP integration, and CLI commands are separated by directory. The React Flow web UI is in `apps/web/src`, with web tests in `apps/web/test`. Shared TypeScript contracts are in `packages/shared/src`. Electron packaging and desktop tests are in `apps/desktop`. Repository automation lives in `scripts` and `.github`; design specifications and implementation plans belong under `docs/superpowers`.

## Build, Test, and Development Commands

- `npm install` installs all workspace dependencies.
- `npm run build` builds shared types, the server, and the web app.
- `npm test -w apps/server` runs the server and CLI Node test suite.
- `npm test -w apps/web` runs web unit tests.
- `npm run test:desktop` runs Electron/desktop tests.
- `npm run lint` checks server, web, and shared TypeScript with ESLint.
- `npm run format` formats supported TypeScript, TSX, and CSS files.
- `npm run dev:server` and `npm run dev:web` start local development services.
- `npm run check:secrets` scans the repository for accidentally committed secrets.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, semicolons, and double quotes, matching Prettier and the existing source. Use `camelCase` for functions and variables, `PascalCase` for React components and types, and kebab-case for descriptive filenames where established. Prefer existing helpers and workspace packages over new abstractions. Keep MCP stdio protocol output off stdout; use the project logger for diagnostics.

## Testing Guidelines

Tests use Node's built-in test runner with `tsx`; name files `*.test.ts` (desktop tests use `*.test.cjs`). Place tests beside the owning workspace's test directory and describe behavior in test names. Add focused regression coverage for changed contracts, then run the affected workspace suite and `npm run build`. UI changes should also be checked at desktop and narrow viewport sizes when layout is involved.

## Commit & Pull Request Guidelines

Use concise Conventional Commit messages such as `feat(web): ...`, `fix(cli): ...`, `docs: ...`, or `ci: ...`. Keep commits focused and avoid unrelated formatting churn. Pull requests should explain the user-visible behavior, link the relevant issue, list validation commands and results, and include screenshots for visual changes. Keep generated build output, secrets, and local `.superpowers` prototypes out of commits.

When picking up a newly discovered problem, first search the issue tracker for an existing issue; create one if none matches, then branch from the latest `dev` and link the issue in the pull request.

Branch naming: `<type>/<slug>` where `type` mirrors Conventional Commits (`feat`, `fix`, `docs`, `ci`, `chore`, `refactor`, `test` — use `feat`, never `feature`). When tied to an issue, include the number: `<type>/<issue>-<slug>` (e.g. `feat/13-channel-highlight`). Keep the slug lowercase kebab-case English, at most ~5 words, describing the behavior. No mechanical suffixes like `-from-dev`; worktrees live under `.worktrees/<branch-name>`.

Agent collaboration rules:

- Pushes must be explicit: announce the branch and commits in the conversation before any push (direct command, embedded in a script, or via `gh`); a permission denial is the user's intent — never route around it through a different vehicle.
- Merging is tiered: docs/chore PRs (no behavior change) may be auto-merged once all checks are green; feat/fix PRs stay open for the user to merge manually even when green.
- Use the `gh` CLI for PR operations (`gh pr create`, `gh pr merge --merge --auto`); no hand-rolled API scripts.
- AGENTS.md and CLAUDE.md are maintained in parallel (English/Chinese); any rule change updates both.
- dev → main PRs happen at milestones (or after a batch of PRs) and are initiated only with the user's confirmation. Merged remote branches are auto-deleted by GitHub; delete the local branch when done.

## Security & Configuration Tips

Do not commit API keys or local databases. Run `npm run check:secrets` before pushing. Review `.env` and local data paths before sharing logs. Changes to SQLite schema or HTTP contracts require corresponding migration and regression tests.
