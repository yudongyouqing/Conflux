# Conflux

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933.svg)](https://nodejs.org/)

> A local-first desktop workspace for connecting AI coding sessions, agents, messages, and shared context.

Conflux gives AI coding sessions a shared place to exchange context and coordinate work. Each session can publish knowledge, ask another session a question, receive asynchronous replies, and appear as a live node in a conversation graph.

The project is built for local development and personal workflows. Data stays in a SQLite database on your machine, while the Electron desktop client brings the existing React workspace into a native window.

## Why Conflux?

AI coding assistants usually run as isolated processes. That makes it difficult to answer simple questions such as:

- What is another session working on?
- Where did a previous session publish the implementation notes I need?
- How can two agents exchange work without manual copy and paste?
- Which runtime agents are active, stale, or offline?

Conflux connects those sessions without requiring a database server, message broker, or hosted control plane.

## Features

- **Session graph**: Browse sessions, agents, and directed conversation channels as a graph.
- **Shared context**: Publish searchable notes and query context owned by other sessions.
- **Async messaging**: Ask another session a question and receive the reply later, including across `/resume` transitions.
- **Internal agents**: Define model-backed agents with a system prompt and chat with them from the workspace.
- **Runtime agents**: Configure Claude Code or Codex CLI presets and launch them in a clean terminal environment.
- **Claude Code integration**: Connect sessions through MCP and optional lifecycle hooks.
- **Three interfaces**: Use the same capabilities through MCP, HTTP REST, or the CLI.
- **Local-first storage**: Keep application state in one SQLite database with WAL mode.
- **Electron client**: Run the React workspace in a desktop window while the local server starts automatically.

## Project Status

Conflux is in active development. The current development version includes the first Electron desktop development shell and the existing web workspace.

Available now:

- Electron development mode on Windows
- Fastify HTTP server
- React, Vite, and React Flow workspace
- MCP server and Claude Code hooks
- SQLite persistence and core regression tests

Still planned:

- Packaged installers for Windows, macOS, and Linux
- Tray and background process support
- Automatic updates
- Full migration of internal package and data-directory names from `muiltchat` to `Conflux`

## Quick Start

### Requirements

- Node.js 18 or newer
- npm 9 or newer
- Claude Code, if you want MCP session integration
- An Anthropic or OpenAI API key, if you want to use internal agents

### Install

```bash
git clone https://github.com/yudongyouqing/Conflux.git
cd Conflux
npm install
```

### Start the desktop client

```bash
npm run dev:desktop
```

The Electron process starts the local API server and Vite development server, waits for both services to become available, and opens the workspace in a desktop window.

The development endpoints are:

- Web workspace: http://127.0.0.1:5173
- API server: http://127.0.0.1:9527
- OpenAPI docs: http://127.0.0.1:9527/docs

Do not run `npm run dev:all` at the same time as `npm run dev:desktop`. Both commands use the same ports and SQLite data directory.

### Run the web workspace separately

If you prefer a browser during development:

```bash
npm run dev:all
```

Then open http://127.0.0.1:5173.

### Run the local production server

```bash
npm start
```

This builds the shared package, server, and web workspace, then serves the built frontend from the API server at http://127.0.0.1:9527.

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

The core business logic lives in `apps/server/src/core`. The HTTP, MCP, and CLI interfaces call the same core operations, so data behavior stays consistent across interfaces.

## Repository Layout

```text
apps/
  desktop/       Electron main process and desktop development runtime
  server/        Fastify API, SQLite core, MCP server, and CLI
  web/           React workspace built with Vite and React Flow
packages/
  shared/        Shared TypeScript types for server and web
docs/
  plans/         Development plans
  specs/         Design specifications
```

## Claude Code Integration

### MCP

Add Conflux to a project's `.mcp.json`:

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

Hooks associate lifecycle events with the session identity and keep liveness information current:

```bash
npm run mcp -- hooks install
```

The hook integration supports session start, prompt submission, and stop events. It also keeps custom titles, `/resume` lineage, and undelivered messages synchronized with the local graph.

## Internal Agents

Internal agents are model-backed agents stored in the local database. Create one from the Agents tab with a name, system prompt, provider, and model, then chat with it from the workspace.

Supported provider environment variables:

```bash
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
```

The settings endpoint reports which providers are configured:

```text
GET /settings
```

## Runtime Agents

Runtime agents are presets for launching real CLI coding assistants. A preset can define:

- Runtime: Claude Code or Codex
- Working directory
- Model
- API base URL and API key
- Extra environment variables
- Startup instructions
- Heartbeat interval

The terminal launcher removes session-scoped variables before starting a new process and uses platform-specific fallback chains when a preferred terminal is unavailable.

## Data and Configuration

By default, Conflux stores its SQLite data under:

```text
~/.muiltchat
```

The current implementation still uses `.muiltchat` for compatibility during the rename transition. You can override the data directory with `MUILTCHAT_HOME` or the CLI `--data-dir` option:

```bash
MUILTCHAT_HOME=/path/to/conflux-data npm run dev:server
```

On Windows PowerShell:

```powershell
$env:MUILTCHAT_HOME = "C:\\path\\to\\conflux-data"
npm run dev:server
```

The database uses SQLite WAL mode. No external database service is required.

## Development Commands

```bash
# Build shared types, server, and web workspace
npm run build

# Start the Electron desktop development client
npm run dev:desktop

# Start the server and browser development server together
npm run dev:all

# Start only the server development process
npm run dev:server

# Start only the web development process
npm run dev:web

# Run the server regression suite
npm test -w apps/server

# Run Electron service and runtime tests
node --test "apps/desktop/test/*.test.cjs"
```

## HTTP API

The local server exposes OpenAPI documentation and Swagger UI at `/docs` when running in development mode. Common resources include:

- `/graph`
- `/sessions`
- `/messages`
- `/context`
- `/agents`
- `/conversations`
- `/runtimes`
- `/settings`
- `/audit`

The API binds to `127.0.0.1` by default.

## Contributing

Issues, ideas, and pull requests are welcome. Before opening a pull request:

1. Keep changes focused and explain the user-facing behavior.
2. Run `npm run build`.
3. Run `npm test -w apps/server`.
4. Run `node --test "apps/desktop/test/*.test.cjs"` when changing the desktop runtime.

## License

Conflux is released under the [MIT License](./LICENSE).
