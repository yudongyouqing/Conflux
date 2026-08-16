# muiltchat

> Cross-session context sharing, async messaging and agent orchestration for AI coding assistants.

AI coding assistants like Claude Code run each session in its own process with
isolated context. Session A cannot see what session B is doing; the only way to
share is copy-paste by hand. **muiltchat** fixes that — and goes further: you
can also define internal agents that chat with you and reach out to other
sessions on their own.

- **query** — search context entries another session has published
- **ask** — fire an async question at another session; it replies later.
  Undelivered mail follows the conversation across `/resume` (id changes),
  and unread mail is surfaced proactively inside the recipient session
- **agents** — create internal agents (system prompt + model), chat with them
  in the web UI, and let them use cross-session tools autonomously
- **runtime agents** — define CLI agent presets (Claude Code / Codex with a
  fixed directory, API channel and instructions) and launch them in new
  terminal windows; spawned sessions auto-tag back to their preset
- **open in terminal** — click any (offline) session node → its conversation
  resumes in a new terminal window, in your terminal of choice
- **graph** — sessions and agents as nodes, edges carry their latest exchange;
  click an edge to read the two-way message flow

Zero ops: everything lives in one SQLite file (WAL mode). No database server,
no message queue, no broker.

## Repository layout

```
apps/server          Node.js + TypeScript backend (Fastify HTTP + MCP + CLI)
apps/web             React 18 + Vite + React Flow dashboard (Dify-style)
packages/shared      TypeScript types shared by server and web
```

## Quick start

```bash
git clone <this-repo> muiltchat && cd muiltchat
npm run setup        # installs all workspaces
npm run dev:all      # backend (:9527) + web dev server (:5173) concurrently
```

Open http://localhost:5173 — tabs: 图拓扑 (view modes: 仅活跃 / 目录分层 with
orphan-archive cluster / 全部; click nodes for details, click edges for the
message flow), 会话 (project-grouped list), 消息流, Agents, 运行时, 设置.
Production mode: `npm start` builds everything and serves the UI from the API
port (http://localhost:9527).

### Claude Code integration (MCP)

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "muiltchat": {
      "command": "npx",
      "args": ["tsx", "<repo>/apps/server/src/index.ts", "mcp"]
    }
  }
}
```

Each Claude Code session spawns its own MCP process, auto-registers as a node
in the graph, and gains these tools: `publish_context`, `query_context`,
`ask_session`, `reply_ask`, `check_inbox`, `check_replies`, `get_graph`.

### Claude Code hooks (session identity + liveness)

MCP alone cannot see the conversation id. Optional hooks close the gap:

```bash
npm run mcp -- hooks install    # merges SessionStart/UserPromptSubmit/Stop
                                # into ~/.claude/settings.json (backup first)
```

With hooks installed: resuming a conversation reactivates the same graph node,
`/rename` titles sync (node name = your title, first prompt as fallback), every
prompt refreshes a live "doing right now" description, and sessions heartbeat
every 30s so idle-but-open sessions stay alive.

Hooks also close two delivery gaps: a session with unread inbox gets a short
notice injected into its context on the next prompt (so it actually calls
`check_inbox`), and `/resume` re-addresses undelivered mail to the new
conversation id — matched by process pid, or by transcript lineage when the
conversation was resumed in a different terminal.

## Internal agents + chat

1. Agents tab → create an agent (name, system prompt, provider, model)
2. Click 对话 and chat — responses stream token by token
3. The agent can call cross-session tools on its own: `list_sessions`,
   `query_context`, `ask_session`, `check_inbox`, `reply_ask`,
   `publish_context`. Tool calls render inline in the chat.

Providers via the [Vercel AI SDK](https://ai-sdk.dev): `anthropic`, `openai`.
Set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` before starting the server;
`GET /settings` reports which are configured.

## Runtime agents (spawn real CLI agents)

The 运行时 tab: create a preset — runtime (Claude Code / Codex), working
directory, model, API base URL + key (injected as env on launch, replacing
inherited credentials), extra env, system instructions — then hit 启动. The
preset opens in a new terminal window with a clean environment (no
session-scoped vars leak in), and the spawned session carries the preset tag
so the graph shows it under the preset name with a runtime badge. It is a
normal node: ask it from the web console, from other sessions, or open its
directory in another terminal.

The terminal opener is configurable in 设置: Windows Terminal / PowerShell /
cmd / WezTerm, with live availability detection (`where.exe`) and automatic
fallback chains when a terminal is missing.

## Three equivalent interfaces (white-box by design)

Every capability is reachable three ways, all audited to `audit_log`:

| Interface | Entry |
|---|---|
| MCP | `muiltchat mcp` (Claude Code spawns per session) |
| HTTP REST | `muiltchat serve` — OpenAPI docs at `/docs` |
| CLI | `muiltchat sessions / context / msg / agents / graph / hooks / audit` |

The database is a plain SQLite file — open it with any client
(`muiltchat path` prints the location). `muiltchat audit` replays every call.

## Development

```bash
npm run build                 # shared → server → web
npm test -w apps/server       # core regression suite (node:test, 74 tests)
npm run dev:all               # both dev servers
```

Stack: Fastify 5 · better-sqlite3 (WAL) · MCP SDK · AI SDK 7 · React 18 ·
Vite · React Flow · Tailwind · TanStack Query.

## License

MIT
