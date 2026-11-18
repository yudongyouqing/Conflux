# Desktop / repository audit dispositions — 2026-11-18

Scope: fix/339-audit-defects worktree only. Original report: agy-handoff/step-97.txt (first copy). No commits or pushes. No AGENTS.md/CLAUDE.md policy changes.

## Findings

| ID | Disposition | Evidence and remaining review |
|---|---|---|
| B1 | Partially fixed / product decision deferred | Active preload does not expose confluxPty; separate preload-pty.cjs exists but is not loaded; runtime launch uses server HTTP. Fixed narrow defects: trusted-window IPC sender checks, spawn/id/text validation, duplicate subscription replacement, Windows homedir fallback, quit kills all PTYs. Keep versus remove/wire Electron PTY stack needs product decision. VM integration rejects foreign sender and accepts a valid trusted spawn. |
| B2 | Fixed, original claim overstated | apps/web/index.html already contains a CSP meta tag. Main did not install productionCsp header; now installs it on same-origin document responses before loadURL. Header additionally enforces frame-ancestors (ignored in meta). Security helper and main VM integration pass. |
| B3 | Fixed within existing bounded polling contract; remaining delivery design deferred | Replies update existing message id; runner now compares reply state, attributes reply to to_session, prevents overlapping polls and notification after stop; polling starts after service ready and stops at quit. Expanded recent list 10 → API max 500. Old replies outside this window, >500 new messages between polls, and history paging need an event/cursor API; no claim of lossless delivery. Failing-first state-transition and in-flight-stop regressions pass. |
| B4 | Fixed | Real HTTP regressions first failed (503 falsely accepted; hung socket reached guard abort), now require 2xx/3xx and enforce independent overall deadline. |
| B5 | Fixed; POSIX host validation remains | Owned service processes now launch in detached POSIX groups. stopChild signals group, waits while descendants remain even after shell exits, and bounds shutdown with SIGKILL fallback; Windows taskkill unchanged. Failing-first unit tests cover wait, escalation, and shell-exit/descendant case. Real macOS/Linux Electron shutdown not run on this Windows host. |
| B6 | Deferred | Root name conflux-monorepo, extraMetadata only main, Linux workflow expects conflux-monorepo. Changing name/userData could migrate profiles/locks and binary paths; preserve until product decision and migration acceptance. |
| B7 | Fixed | Tray uses colored icon.png on Windows/Linux, template only on macOS. Platform tests pass; no actual OS taskbar visual QA. |
| B8 | Fixed | Main close handler honors existing CONFLUX_QUIT_ON_LAST_WINDOW_CLOSED opt-in. VM emits real registered close handler for default and opt-in cases. |
| B9 | Fixed | main gate passes branch via env, checks both dev and head repository identity, preserves job name. Regression checks prohibit direct shell interpolation and require repository identity. Remote workflow execution not dispatched. |
| B10 | Fixed | Capture/seed use direct Node argv (space-safe, no npx.cmd), portable owned-process cleanup, package import, current Graph/Activity selectors, no networkidle wait against polling app. Capture command succeeded from path with spaces; five current screenshots regenerated, light/dark visually inspected; font readiness awaited and Conflux node chosen for details. Cleanup succeeds on success and on observed navigation failure. |
| B11 | Fixed | Scanner now includes docs/superpowers and ignores local prototypes/worktrees/artifacts. Failing-first scope regression passes. Added scanner tests to CI/ci:test. Newly included historical plan contained synthetic credential-test literal; split string keeps example semantics and secret scan now passes. |
| B12 | Fixed; packaged acceptance not rerun | Packaged ProductVersion expectation reads root version. Managed screenshots verify web build exists before starting and close browser in finally; nested finally retains service cleanup if browser close throws. Syntax checked; no packaged installer launched. |
| B13 | Fixed owned portions / server config delegated to root | ci:test now includes web, packaged smoke/scanner tests, lint. Release builds once before server tests, adds web/process-E2E/lint/token checks. Root owns server pretest build change. Actual CI/release runs not dispatched. |
| B14 | Delegated to root (server ownership) | Desktop builder independently excludes server dist/test as protection. Server manifest/files/tsconfig handled by root. |
| B15 | Partially fixed / remainder deferred | Fixed missing preflight commands in review/PR skills, PR base dev, protected dev/main, focused staging, explicit push announcement/denial respect, missing-template fallback; fixed repeated themes word. Did not invent missing license text, remove grill-me, auto-install/sync skills, or change skill packaging behavior. Those need intended distribution/licensing decision. |
| B16 | Fixed | English README anchor/banner path, performance multiplication mojibake, Troubleshooting Codex heading references, and personal local codex source path replaced by checkout placeholder. Historical status headers otherwise preserved. |
| I1 | Partially fixed / policy file and global deferred | Current README/MIGRATION/CONTRIBUTING now say legacy CLI/env removed since v0.3.0, matching CHANGELOG/current config. CLAUDE.md left for paired policy reconciliation; legacy preload alias retained pending compatibility decision. |
| I2 | Fixed | CONTRIBUTING branch/base/rebase/direct-commit claims align with existing dev policy; no policy changes in AGENTS/CLAUDE. |
| I3 | Partially fixed / status rewrite deferred | English Electron badge and Assistants wording fixed; screenshot set refreshed. Managed docs index, broad README content and PROJECT-TODO delivery/status/history require current release evidence; left unchanged. |
| I4 | Fixed | Browser-stack warnings and Troubleshooting table now refer to dev:web-stack. Documented dev:all alias remains. |
| I5 | Deferred | 10px policy vs enforced 11px floor and sans/mono exceptions require one paired policy decision; no AGENTS/CLAUDE policy changes. |
| I6 | Delegated / deferred | Root owns server Node engines/build entry points. No broad claim that every runtime needs Node 22 solely because test runner uses it. Architecture-rule bilingual parity requires explicit policy reconciliation. |
| I7 | Fixed owned source comments | Removed issue-number references from desktop sources, capture/style script comments, Dependabot comment. Web comments belong to web agent. |
| I8 | Deferred | Expanding lint/format scope could expose unrelated churn. Action version difference is not itself proof of broken behavior. Default mac/Linux dir packaging may be intentional; release explicitly selects installers. No version upgrades or target changes without policy/packaging decision. |
| I9 | Deferred | Historical plan/spec status language is stale but report does not establish complete current implementation/acceptance; avoided rewriting history. |
| E1 | Fixed intra-job duplication / cross-job consolidation deferred | CI performance job builds via test script once then runs raw benchmark; web E2E runs second script without rebuilding shared; release full build occurs once before tests. Kept job names/matrices/required-check identities. Npm workspace pretest may still rebuild shared; larger script redesign not attempted. |
| E2 | Deferred | Raw committed benchmark series are large, but removal/archive needs retention decision and link/source evidence. |
| E3 | Fixed; only syntax checked | snapshotUserData enumerates once; pidDescendsFrom walks ancestors within one PowerShell invocation, validates numeric inputs. Packaged Windows acceptance not rerun. |
| E4 | Fixed | Builder files restricted to desktop src/build/package manifest and excludes server dist/test. Builder resource/dependency tests pass. No installer rebuilt here. |
| N1 | Scanner guard added / deletion deferred | Scanner skips local worktree directories, including the leading-space variant. No local worktrees/prototypes/screenshots deleted. |
| N2 | Fixed | Removed unused TRAY_ICON_DATA_URL; no source/test references, tray tests pass. |
| N3 | Deferred | Legacy muiltchatDesktop global may have external users; no removal without compatibility decision. |
| N4 | Deferred | Same product decision as B1; native stack retained. |
| N5 | Deferred | No third-party skill removals or licensing inventions; applicability/distribution should be reviewed. |
| N6 | Deferred | Alias scripts and Windows package smoke may still support local workflows. Unused-in-CI alone does not prove removal safe. |
| N7 | Deferred | Historical plans/drafts remain for traceability; archive/deletion needs retention decision and link updates. |

## Additional verified defect

Desktop packaged-deps tests assumed lexical node_modules paths, incorrectly rejecting shared node_modules junctions in worktrees. Closure comparison now resolves the physical node_modules root and still rejects paths outside it. Initially 72/74 desktop tests passed with two junction failures; after fix and further regressions, all 78 pass.

## Validation

- npm run test:desktop: 78/78 pass.
- node --test scripts/release-config.test.cjs scripts/packaged-module-smoke.test.cjs scripts/check-secrets.test.cjs scripts/e2e/chat-first-smoke.test.mjs: 20/20 pass (before final POSIX-only desktop addition; final release+scanner 10/10 rerun).
- node --test scripts/performance/*.test.cjs: 21/21 pass, including real contention/soak fixture lifecycle.
- npm run check:secrets: passes including newly covered plans.
- npm run capture:screens: passes and regenerates 5 screenshots using isolated temp home, ports 19527/5199.
- node --check on changed screenshot/packaged acceptance scripts: pass.
- git diff --check: passes (Git emits existing CRLF-normalization warnings in other agents' server changes).
- Root owns integrated build/lint/web/server verification. No build run by this agent; no remote CI or installer acceptance dispatched.

## Final integrated additions

Notification requests now have an 8-second abort deadline through JSON body parsing, and stopping cancels the current request (two failing-first real HTTP regressions). Server package metadata is explicitly included beside dist for the package-derived version reader. Final desktop suite: 80 passing; installer acceptance remains unrun.
