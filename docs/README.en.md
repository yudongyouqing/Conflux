<div align="center">
  <h1>Conflux</h1>
  <p>A local-first desktop workspace for connecting AI coding sessions, agents, messages, and shared context</p>
  <p><a href="../README.md">简体中文</a> ｜ English</p>
  <p>
    <img src="https://img.shields.io/badge/Electron-37-47848F?logo=electron&logoColor=white" alt="Electron">
    <img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white" alt="React">
    <img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white" alt="Node.js">
    <a href="../LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  </p>
</div>

Conflux gives AI coding sessions a shared place to exchange context and coordinate work. Each session can publish knowledge, ask another session a question, receive asynchronous replies, and appear as a live node in a conversation graph.

The public project name and new CLI entry are `Conflux`. The npm package name, legacy CLI entry, environment variables, and default data directory retain `muiltchat` compatibility.

Documentation: [Migration](MIGRATION.md) · [Troubleshooting](TROUBLESHOOTING.md) · [Contributing](../CONTRIBUTING.md) · [Changelog](../CHANGELOG.md)

## Overview

AI coding assistants usually run as isolated processes. That makes it difficult to answer simple questions:

- What is another session working on?
- Where did a previous session publish the implementation notes I need?
- How can two agents exchange work without manual copy and paste?
- Which runtime agents are still online?

Conflux connects those sessions without requiring a database server, message broker, or hosted control plane. Data stays in a local SQLite database by default, while the Electron desktop client loads the existing React workspace into a native window.

## Features

- **Session graph:** Browse sessions, agents, and directed conversation channels as a graph.
- **Shared context:** Publish searchable notes and query context owned by other sessions.
- **Async messaging:** Ask another session a question and receive the reply later, including across `/resume` transitions.
- **Internal agents:** Define model-backed agents with a system prompt and chat with them from the workspace.
- **Runtime agents:** Configure Claude Code or Codex CLI presets and launch them in a clean terminal environment.
- **Claude Code integration:** Connect sessions through MCP and optional lifecycle hooks.
- **Multiple interfaces:** Expose the same core capabilities through MCP, HTTP REST, and the CLI.
- **Local-first storage:** Keep application state in SQLite with WAL mode and no external database dependency.
- **Electron client:** Run the React workspace in a desktop window while starting the local services automatically.

## Project Status

Conflux is in active development. The current version includes the Electron desktop shell, production resource paths, packaging configuration, and cross-platform CI. Official releases are currently unsigned artifacts produced by GitHub Actions.

Available now:

- Electron development mode on Windows.
- Electron single-instance behavior, tray support, service lifecycle, port diagnostics, and a secure window boundary.
- Fastify HTTP server.
- Workspace built with React, Vite, and React Flow.
- MCP server and Claude Code hooks.
- Claude Code/Codex liveness detection, resume lineage, and asynchronous collaboration messages.
- Versioned data transfer, legacy directory migration, stable error codes, and secret scanning.
- CI configuration for unsigned Windows NSIS and unpacked directory builds.
- SQLite persistence and core regression tests.

Planned:

- Automatic updates and code signing.
- Official installer distribution for macOS and Linux.
- Full migration of internal package and data-directory names from `muiltchat` to `Conflux` while retaining the compatibility layer.

## Quick Start

### Requirements

- Node.js 22 LTS (the server package still declares Node.js >= 18 compatibility).
- npm >= 9.
- Install Claude Code if you want MCP session integration.
- Prepare an Anthropic or OpenAI API key if you want to use internal agents.

### Install

```bash
git clone https://github.com/yudongyouqing/Conflux.git
cd Conflux
npm ci
```

### Start the Electron desktop client

```bash
npm run dev:desktop
```

This command starts the local API server and Vite development server, waits for both services to become available, and opens the workspace in an Electron window.

Development endpoints:

- Workspace: <http://127.0.0.1:5173>
- API server: <http://127.0.0.1:9527>
- OpenAPI docs: <http://127.0.0.1:9527/docs>

Do not run `npm run dev:all` and `npm run dev:desktop` at the same time. Both commands use the same ports and SQLite data directory.

### Run the web workspace separately

If you prefer a browser during development, run:

```bash
npm run dev:all
```

Then open <http://127.0.0.1:5173>. If `localhost` is unavailable, try `127.0.0.1` first. `dev:all` starts the local API server and Vite development server in parallel.

If the page or API does not open, see the [troubleshooting guide](TROUBLESHOOTING.md) for endpoint checks, port diagnostics, MCP restart steps, and data recovery instructions.

### Run the local production server

```bash
npm start
```

This command builds the shared package, server, and web workspace, then serves the built frontend from `apps/web/dist` through the API server at <http://127.0.0.1:9527>.

For startup, port, database, MCP, or migration issues, see the [troubleshooting guide](TROUBLESHOOTING.md). See the [migration guide](MIGRATION.md) for legacy compatibility and the [contribution guide](../CONTRIBUTING.md) before making changes.

## Releases and installers

GitHub Actions builds Windows releases from `v*` tags. Each release contains an unsigned NSIS installer and a `win-unpacked` directory artifact. The artifacts are not code-signed and should be verified before use.

Build an unpacked directory for the current platform locally:

```bash
npm run package:desktop:dir
```

Build the NSIS installer on Windows:

```bash
npm run package:desktop
```

Artifacts are written to `release/` and are ignored by Git. Native `better-sqlite3` packaging on Windows may require Visual Studio C++ Build Tools; use the repository Windows CI when the local toolchain is unavailable. Uninstalling Conflux does not delete user data under `%USERPROFILE%\\.muiltchat`.

## Architecture

```text
                    +----------------------+
                    |  Electron desktop    |
                    |  apps/desktop        |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    |  React workspace     |
                    |  apps/web + Vite     |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    |  Fastify local API   |
                    |  HTTP + OpenAPI      |
                    +-----+-----------+----+
                          |           |
                          v           v
                 +------------+  +----------+
                 | SQLite     |  | MCP + CLI|
                 | local data |  | adapters |
                 +------------+  +----------+
```

The Electron main process lives in `apps/desktop`. In development mode it starts the API and Vite services, waits for health checks, and then loads the desktop window. The React UI lives in `apps/web`, Fastify, SQLite, and core business logic live in `apps/server`, and shared TypeScript types live in `packages/shared`.

Core business logic lives in `apps/server/src/core`. The HTTP, MCP, and CLI interfaces call the same core operations, keeping data behavior consistent across interfaces.

## Repository Layout

```text
apps/
  desktop/       Electron main process and desktop development runtime
  server/        Fastify API, SQLite core, MCP server, and CLI
  web/            React workspace built with Vite and React Flow
packages/
  shared/        Shared TypeScript types for the server and web apps
docs/
  README.en.md   English README
  superpowers/   Development plans and design specifications
```

## Claude Code Integration

### MCP

Add Conflux to the `.mcp.json` used by a Claude Code project:

```json
{
  "mcpServers": {
    "conflux": {
      "command": "npx",
      "args": [
        "tsx",
        "<repo>/apps/server/src/index.ts",
        "mcp"
      ]
    }
  }
}
```

The repository-root configuration starts only the `conflux` MCP server by default. Older projects can manually rename that single key to `muiltchat`; do not keep both keys in one configuration or two servers will start.

Completely restart the MCP host after changing `.mcp.json`; reloading the web page does not recreate a stdio connection. Confirm that the configured path points to the current repository and never run both the `conflux` and `muiltchat` entries for one project.

An MCP-connected session can use tools such as:

- `publish_context`
- `query_context`
- `ask_session`
- `reply_ask`
- `check_inbox`
- `check_replies`
- `get_graph`

Each session registers itself in the graph and can participate in shared context and asynchronous messaging.

### Hooks

Install the Claude Code hooks:

```bash
npx tsx apps/server/src/index.ts hooks install
```

Uninstall the hooks:

```bash
npx tsx apps/server/src/index.ts hooks uninstall
```

Hooks associate lifecycle events with session identity and keep liveness information current. The current integration supports `SessionStart`, `UserPromptSubmit`, and `Stop`, and backs up the existing `settings.json` before installation.

Hooks also maintain custom titles, `/resume` lineage, and undelivered messages. Set `CLAUDE_CONFIG_DIR` when Claude Code uses a custom configuration directory.

### Codex session titles

Codex has no hooks, so the server maintains titles itself: every 30 seconds, alongside the MCP heartbeat and the liveness probe, it scans the rollout records under `~/.codex/sessions` plus `~/.codex/session_index.jsonl`, preferring the thread title Codex maintains itself and falling back to an excerpt of the first user instruction. A session gains its title within about 30 seconds of its first instruction; sessions named manually via `register_session` or the UI are never overridden.

## Internal Agents

Internal agents are model-backed agents stored in the local database. Create one from the Agents tab with a name, system prompt, provider, and model, then chat with it from the workspace.

Supported provider environment variables include:

```bash
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
```

The settings endpoint reports which providers are configured:

```text
GET /settings
```

Keep provider keys in local secure configuration. Do not commit real credentials or put them in logs or export files. Run `npm run check:secrets` before sharing changes.

## Runtime Agents

Runtime agents are presets for launching real CLI coding assistants. A preset can define:

- Runtime: Claude Code or Codex.
- Working directory.
- Model.
- API base URL and API key.
- Extra environment variables.
- Startup instructions.
- Heartbeat and scheduled-run interval.

The workspace can launch runtime agents in a new terminal window, and scheduled presets can run headlessly in the background. The launcher removes session-scoped environment variables and uses platform-specific fallback chains when a preferred terminal is unavailable.

## Data and Configuration

By default, Conflux stores SQLite data under:

```text
~/.muiltchat
```

The current implementation defaults to `.muiltchat` for compatibility with pre-rename versions. Directory precedence is CLI `--data-dir`, `CONFLUX_HOME`, `MUILTCHAT_HOME`, an existing project directory, and finally `~/.muiltchat`. Without an explicit migration command it does not create `~/.conflux` or move the old directory. The database file is `data.db`, and SQLite WAL mode is enabled.

On Linux, macOS, or Git Bash:

```bash
MUILTCHAT_HOME=/path/to/conflux-data npm run dev:server
```

On Windows PowerShell:

```powershell
$env:MUILTCHAT_HOME = "C:\path\to\conflux-data"
npm run dev:server
```

The CLI also supports `--scope global` and `--scope project`. To specify an exact path, run:

```bash
npx tsx apps/server/src/index.ts --data-dir /path/to/conflux-data path
```

To explicitly migrate an old directory, run `conflux migrate --from <legacy-dir> --to <conflux-dir>`. Check the destination marker with `conflux migrate --status --to <conflux-dir>`. Migration copies only the database files and preserves the source directory.

Export readable data for backup:

```bash
npx tsx apps/server/src/index.ts data export --output ./conflux-backup.json
```

Import with `data import --file <bundle.json> --conflict skip|overwrite|copy`. The bundle is validated before one SQLite transaction, and a failed import rolls back as a whole.

No external database service is required.

## Development Commands

```bash
# Build the shared package, server, and web workspace
npm run build

# Start the Electron desktop development client
npm run dev:desktop

# Start the server and browser development server together
npm run dev:all

# Start only the server development process
npm run dev:server

# Start only the Vite development server
npm run dev:web

# Start the stdio MCP server
npm run mcp

# Run the server regression suite
npm test -w apps/server

# Run CI-equivalent tests and release configuration checks
npm run ci:test

# Run the CI-equivalent build
npm run ci:build

# Scan public files for credentials
npm run check:secrets

# Run Electron service and runtime tests
node --test apps/desktop/test/dev-services.test.cjs apps/desktop/test/runtime-config.test.cjs
```

## HTTP API

The local server binds to `127.0.0.1:9527` by default. In development mode, OpenAPI documentation and Swagger UI are available at `/docs`: <http://127.0.0.1:9527/docs>.

Common resources include:

- `/healthz`
- `/graph`
- `/sessions`
- `/messages`
- `/context`
- `/agents`
- `/conversations`
- `/runtimes`
- `/settings`
- `/audit`
- `/data/export`
- `/data/import`

Requests that require a session identity should provide the `X-Session-Id` header. The HTTP, MCP, and CLI interfaces share the same core data operations.

For startup failures, port conflicts, database locks, MCP configuration, or migration recovery, see [Troubleshooting](TROUBLESHOOTING.md).

## Contributing

Issues, ideas, and pull requests are welcome. Read the [contribution guide](../CONTRIBUTING.md) before opening a pull request:

1. Keep changes focused and explain user-facing behavior changes.
2. Run `npm run build`.
3. Run `npm test -w apps/server`.
4. Run `npm run test:desktop` when changing the desktop runtime.
5. Run `npm run check:secrets` and `git diff --check`.

## License

Conflux is released under the [MIT License](../LICENSE).
