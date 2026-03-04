# Slimebot

Matrix-hosted Codex app-server bot.

Slimebot bridges Matrix rooms to a Codex `app-server` process over JSON-RPC (stdio). Each room can be mapped to a Codex thread, with room/thread routes persisted locally.

## API Reference

- Codex app-server API overview: https://github.com/openai/codex/tree/main/codex-rs/app-server#api-overview

## Features

- Matrix channel with:
  - auto-join invite handling (optionally restricted by `allowedInviteSender`)
  - rate-limit aware send retries (`M_LIMIT_EXCEEDED`)
  - command parsing with canonical names + aliases
- SQLite-backed state persistence (room routes + per-thread state).
- SQLite-backed unified schedule job queue (RRULE-based) with timer restore on startup.
- Controller-owned MCP server over a Unix domain socket.
- Startup restore flow that resumes persisted thread mappings when possible.
- Turn handling:
  - `turn/steer` when a room sends a new message during an in-flight turn
  - fallback to `turn/start` when steering is unavailable/stale
  - interrupt support (`!interrupt` / `!i`)
- Thread lifecycle support (`new`, `resume`, `list`, `status`, `rollback`, `compact`, `archive`, `unarchive`).
- Approval workflow for:
  - `item/commandExecution/requestApproval`
  - `item/fileChange/requestApproval`
- Model and reasoning controls per thread (`!model` / `!m`, `!reasoning` / `!r`).
- Account APIs (`!account`, `!account ratelimits`) + ChatGPT login flow (`!login`, `!callback`).
- Tool activity notifications in-room (`item/started`, `item/completed`).
- Matrix typing indicator during active turns with periodic heartbeat refresh.

## Requirements

- Node.js 22+
- A Matrix bot user and access token
- Codex CLI (installed via `@openai/codex` in this project)

## Quick Start

1. Install dependencies:
   - `npm install`
2. Copy and edit config:
   - `cp slimebot.example.yaml slimebot.yaml`
3. Start in dev mode:
   - `npm run dev`

Production run (after build):

- `npm run build`
- `npm run start`

Or with Docker Compose:

- `docker compose up --build`

Compose persists runtime logs to `./logs/slimebot.log` (also still visible in `docker compose logs`).
Compose also persists SQLite bot state under `./state/slimebot-state.sqlite3`.

## Configuration

Primary config file: `slimebot.yaml`

You can override config path with:

- `SLIMEBOT_CONFIG_PATH=/path/to/slimebot.yaml`

Key sections:

- `channel.matrix`
  - homeserver URL
  - bot access token
  - bot user ID
  - optional allowed invite sender
- `controller`
  - `commandPrefix` (currently parsed but not enforced by Matrix command parsing)
  - `stateDatabasePath`
  - `mcpSocketPath` (Unix socket for controller MCP server)
- `codex`
  - command and args used to launch app-server
  - optional `threadStart` defaults forwarded to `thread/start` (for example `personality`, `developerInstructions`, `baseInstructions`, `config`)
  - optional `turnStart` defaults forwarded to `turn/start` (reserved keys `threadId` and `input` are ignored)

Default Codex launch is equivalent to:

- `codex app-server --listen stdio://`

Example override to de-emphasize generic Codex persona:

```yaml
codex:
  command: "/app/node_modules/.bin/codex"
  cwd: "/var/lib/slimebot/workspace"
  args: ["app-server", "--listen", "stdio://"]
  threadStart:
    personality: "none"
    developerInstructions: |
      You are Slimebot, a persistent workspace agent.
      Prefer concise, practical responses.
  turnStart:
    personality: "none"
```

Notes:

- `threadStart` applies when creating threads with `!new`.
- `turnStart` applies to each new turn started by room messages.

## Controller MCP Server (Unix Socket)

Slimebot exposes a controller-owned MCP server over a Unix socket (default: `/var/lib/slimebot/workspace/slimebot-controller.sock`).

Exposed tools are composed from:

- controller-level tools:
  - `schedule_list`
  - `schedule_create`
  - `schedule_cancel`
- channel-provided tools:
  - Matrix channel currently registers `matrix_upload_file`

`schedule_create` expects one unified schedule spec shape:

- `spec.version`: `"v1"`
- `spec.timezone`: IANA timezone (for example `America/New_York`)
- `spec.dtstart`: ISO-8601 timestamp
- `spec.rrule`: RFC5545 RRULE (for example `FREQ=WEEKLY;BYDAY=MO,WE,FR`)

## Codex MCP Bridge

This repo also includes a thin stdio bridge for Codex that forwards bytes between stdio and the controller MCP socket:

- Source: `src/mcp/controllerSocketBridge.ts`
- Build/run: `npm run build && npm run start:mcp-bridge`

Environment:

- `SLIMEBOT_CONTROLLER_MCP_SOCKET_PATH` (optional): defaults to `/var/lib/slimebot/workspace/slimebot-controller.sock`

Example Codex MCP config:

```toml
[mcp_servers.slimebot_controller]
command = "node"
args = ["/app/dist/mcp/controllerSocketBridge.js"]
env = { SLIMEBOT_CONTROLLER_MCP_SOCKET_PATH = "/var/lib/slimebot/workspace/slimebot-controller.sock" }
startup_timeout_sec = 20
tool_timeout_sec = 120
```

A fuller Codex config example (including `context7`) is available in `codex-config.example.toml`.

## Commands

General:

- `!help` — list commands
- `!new` — create and map a new thread to this room
- `!resume <threadId>` — resume thread and map to this room
- `!thread [threadId]` — show thread status (`thread/read`) for a thread; defaults to mapped thread
- `!threads [archived|true]` — list recent threads (`archived`/`true` lists archived threads)
- `!models` — list model catalog response
- `!model <modelId> [threadId]` — set selected model for subsequent turns (defaults to mapped thread)
- `!account` — read account/auth information
- `!account ratelimits` — show latest received `account/rateLimits/updated` payload
- `!reasoning [default|low|medium|high] [threadId]` — show or set per-thread reasoning effort
- `!verbosity [on|off]` — show or set global tool activity message verbosity (approvals unaffected)
- `!schedule create <timezone> <ISO-8601-dtstart> <RRULE> <message>` — create schedule from unified spec
- `!schedule once <ISO-8601> <message>` — create one-shot schedule convenience wrapper
- `!schedule list` — list active schedules for this room
- `!schedule cancel <id>` — cancel an active schedule in this room

Examples:

- `!schedule once 2026-03-10T14:00:00Z review PR queue`
- `!schedule create America/New_York 2026-03-10T09:00:00-05:00 FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR daily standup reminder`

Thread operations:

- `!rollback [numTurns] [threadId]` — rollback turns (defaults to 1 and mapped thread)
- `!compact [threadId]` — start context compaction
- `!archive [threadId]` — archive thread
- `!unarchive [threadId]` — unarchive thread

Turn control:

- `!interrupt [threadId]` — interrupt active turn
- `!i` — hotkey alias for interrupt (mapped thread)

Approvals:

- `!approve` — approve pending approval request in this room
- `!a` — hotkey alias for approve
- `!skip` — decline pending approval request in this room
- `!s` — hotkey alias for decline/skip

Model & reasoning aliases:

- `!m <modelId> [threadId]` — alias for `!model`
- `!r [default|low|medium|high] [threadId]` — alias for `!reasoning`
- `!v [on|off]` — alias for `!verbosity`
- `!t [threadId]` — alias for `!thread`
- `!sch ...` — alias prefix for `!schedule`

Auth:

- `!login` — start ChatGPT managed login flow
- `!callback <full-callback-url>` — trigger callback from posted URL

## Runtime Notes

- When a room message arrives and the mapped thread has an active turn, Slimebot sends `turn/steer` with `expectedTurnId`.
- If steering fails (stale turn state), Slimebot falls back to `turn/start`.
- Active turn state is tracked from `turn/started` and `turn/completed` notifications.
- Pending approval state is tracked per room and cleared when resolved.
- Room-thread routes, per-thread controller state (reasoning/model overrides, token usage, active-turn metadata, verbosity), and scheduled messages are persisted in `controller.stateDatabasePath`.

## Build & Check

- Type-check: `npm run check`
- Build: `npm run build`
