# Conflux session directory implementation plan

**Goal:** Let users list all visible registered sessions from Codex/Claude Code and reference exact sessions without sending messages as a side effect.

**Design:** Reuse session visibility rules. Add an MCP `list` prompt, a read-only `list_session_directory` tool, a directory resource and individual `conflux://sessions/id-{id}` resources. Return full IDs, names, status, runtime, project, current-session marker and stable resource URIs. Encode IDs and escape display fields. Prompt/resource availability does not imply a host-specific native menu name or messaging authorization.

**Client entry points:** A shared `conflux` skill provides `list` behavior. Codex uses `/skills` or `$conflux list`; Claude Code uses `/conflux list` when the skill is installed, and native MCP `/conflux:list`. Add `conflux commands install --client codex|claude|all` to install the bundled instructions outside this repository; preserve unrelated files and refuse conflicting content unless an explicit backup-preserving force option is supplied. Reconnect the MCP host to discover new capabilities; do not terminate an active host.

- [x] Write failing SDK protocol tests for prompt/tool/resource discovery, all-status listings, empty state, duplicate names, unusual IDs, safe text, no message writes and fresh data.
- [x] Implement `apps/server/src/mcp/session-directory.ts` and register it in the existing server with adoption/lease/audit behavior. Check for resource-list changes on the existing heartbeat and explicit directory reads.
- [x] Add the shared skill and portable command installer with isolated filesystem tests (both clients, paths with spaces, conflicts and idempotence).
- [x] Run focused tests, full server tests, build, lint and secret scan. Test actual stdio prompt/resources with an isolated database. Document supported host syntax and distinguish protocol tests from real menu acceptance.
- [ ] Independent review, push an announced feature branch, create a PR linked to the tracking issue and verify CI. Preserve the independent performance PR.

**Validation so far (2026-10-30):** server 282/282, desktop58/58, release config3/3, full build passed; lint0 errors/10 existing warnings; secret scan and skill validator passed. npm pack dry-run includes the bundled skill. Compiled stdio smoke verifies prompt/tool/resource identity and zero message inserts. The URI dot-segment regression was observed failing before the prefix fix and passes after it; independent re-review found no remaining important issues. The unhosted stdio test explicitly sets runtime PID overrides to zero to avoid unrelated real-ancestor probes; initial parallel regression timeout was retained in local logs. Skills installed locally for both clients and repeat install reported unchanged. Actual client menu/@ acceptance still requires reconnect and has not been claimed.
