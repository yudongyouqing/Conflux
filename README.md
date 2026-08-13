# muiltchat

> Cross-session context query and async messaging for AI coding assistants.

AI coding assistants like Claude Code run each session in its own process with
isolated context. Session A cannot see what session B is doing, and the only
way to "share" between them is to copy-paste by hand.

**muiltchat** fixes that. Each session keeps its own context but exposes two
capabilities to other sessions:

- **query** — search and read context entries another session has published
- **ask** — fire an async question at another session; it replies later

Zero ops: every session writes to the same SQLite file in WAL mode. No
database server, no message queue, no broker. Just `npx`.

## Quick start

```bash
# 1. Add muiltchat to your Claude Code project (or home dir)
cat > .mcp.json <<'EOF'
{
  "mcpServers": {
    "muiltchat": {
      "command": "npx",
      "args": ["-y", "muiltchat", "mcp"]
    }
  }
}
EOF

# 2. Open two Claude Code sessions in the same project.
#    In session A: "register yourself and publish what you're working on."
#    In session B: "search what session A published."
```

You can also run muiltchat in HTTP mode for non-MCP clients:

```bash
npx muiltchat serve --port 9527
# Then any HTTP client can talk to http://localhost:9527
# API docs at http://localhost:9527/docs
```

## Three equivalent front-ends

Every operation is reachable from MCP, HTTP, and the CLI. All three write to
the same audit log, so you can verify what happened.

| Operation | MCP tool | HTTP | CLI |
|---|---|---|---|
| Register a session | `register_session` | `POST /sessions/register` | `muiltchat sessions register` |
| List sessions | `list_sessions` | `GET /sessions` | `muiltchat sessions list` |
| Publish context | `publish_context` | `POST /context` | `muiltchat context publish` |
| Update context | `update_context` | `PUT /context/:id` | (via HTTP/SQLite) |
| Delete context | `delete_context` | `DELETE /context/:id` | `muiltchat context delete` |
| List my context | `list_my_context` | `GET /context/mine` | `muiltchat context list-mine` |
| FTS query | `query_context` | `GET /context/query` | `muiltchat context query` |
| Ask a session | `ask_session` | `POST /messages/ask` | `muiltchat msg ask` |
| Check inbox | `check_inbox` | `GET /messages/inbox` | `muiltchat msg inbox` |
| Reply | `reply_ask` | `POST /messages/:id/reply` | `muiltchat msg reply` |
| Check replies | `check_replies` | `GET /messages/replies` | `muiltchat msg replies` |
| Audit log | — | `GET /audit` | `muiltchat audit` |

## Data directory

The data directory contains a single `data.db` SQLite file (plus its WAL/SHM
siblings). muiltchat resolves it in this order:

1. `MUILTCHAT_HOME` env var (always wins if set & non-empty)
2. `$CLAUDE_PROJECT_DIR/.muiltchat/` — when scope is `project` or this dir already exists
3. `~/.muiltchat/` (global default)

```bash
muiltchat path                       # prints the resolved data dir
muiltchat --scope project path       # forces project scope
muiltchat --data-dir ./custom-db path
```

Inspect the database with any SQLite client:

```bash
sqlite3 "$(muiltchat path | jq -r .dbPath)" "SELECT * FROM audit_log ORDER BY id DESC LIMIT 20"
```

## CLI

```bash
muiltchat mcp                                       # stdio MCP server
muiltchat serve [--port 9527] [--host 127.0.0.1]    # HTTP server
muiltchat sessions list [--status active]
muiltchat sessions register --name "..." [--desc "..."]
muiltchat context publish --title "..." --content "..." [--tags a,b]
muiltchat context query [--session ID] [--tags a,b] [QUERY]
muiltchat context list-mine
muiltchat context delete --id N
muiltchat msg ask --to SESSION "question"
muiltchat msg inbox
muiltchat msg reply --id N "reply"
muiltchat msg replies
muiltchat audit [--session ID] [--action NAME] [--interface mcp|http|cli] [--limit 50]
muiltchat path
```

The CLI talks to either:

- the local SQLite file (default), or
- a remote HTTP server, when you pass `--http http://localhost:9527`

A fresh CLI session auto-registers itself as `cli-<user>` and prints its
`MUILTCHAT_SESSION_ID` to stderr. Set that env var to reuse the same identity
across commands.

## How staleness works

Each MCP/HTTP tool call updates `last_heartbeat_at`. Sessions whose last
heartbeat is older than 5 minutes are lazily marked `stale` by the next
`list_sessions`/`query_context` call. There is no native process-exit hook —
that's why we use heartbeat. If you want to end a session explicitly, set its
status to `ended` via the CLI.

## Multi-process safety

muiltchat opens SQLite in WAL mode with:

- `busy_timeout = 10000` — wait up to 10s if another writer holds the lock
- `synchronous = NORMAL` — safe under WAL, fast
- `foreign_keys = ON`

Each process keeps its own connection. Reads are concurrent; writes are
serialized by SQLite's database-level write lock. Long-running HTTP servers
run a 30s checkpoint monitor that triggers `wal_checkpoint(TRUNCATE)` if the
WAL exceeds 64MB.

## Environment variables

| Variable | Purpose |
|---|---|
| `MUILTCHAT_HOME` | Override data directory |
| `MUILTCHAT_SESSION_ID` | Pin a CLI session id |
| `MUILTCHAT_LOG_LEVEL` | pino level: `trace`/`debug`/`info`/`warn`/`error` |
| `MUILTCHAT_LOG_FILE` | Redirect logs to a file (default: stderr) |
| `CLAUDE_PROJECT_DIR` | Used by MCP runtime to find the project root |

## Troubleshooting

- **`SQLITE_BUSY` errors**: another process is mid-write; muiltchat waits 10s
  by default. If you still hit it, raise `busy_timeout` or reduce write frequency.
- **MCP server not connecting**: check stderr — muiltchat logs there. Never
  logs to stdout. Set `MUILTCHAT_LOG_LEVEL=debug` for verbose output.
- **Sessions stuck as `active`**: heartbeat timeout is 5 minutes. Force
  `ended` with the CLI if needed.
- **WAL file growing**: only long-running HTTP servers worry about this; the
  30s checkpoint monitor handles it. For MCP/CLI, processes exit and SQLite
  checkpoints naturally.

## Roadmap

- v1.0 — MCP, HTTP, CLI, FTS search (this release)
- v1.1 — semantic vector search via `sqlite-vec` (still single-file)
- Future — namespaces / ACLs, optional web UI

## License

MIT
