# Slimebot

Matrix-hosted Codex App Server bot (MVP).

Slimebot bridges a Matrix room to a Codex `app-server` process using JSON-RPC over stdio. Each room is mapped to a Codex thread and persisted locally.

## API Reference

- Codex app-server API overview: https://github.com/openai/codex/tree/main/codex-rs/app-server#api-overview

## Features

- Matrix room message handling with automatic invite-join support.
- Per-room thread mapping persisted to `slimebot-routing.json`.
- Codex app-server initialization and session restore (`thread/resume`) on startup.
- In-flight turn steering (`turn/steer`) when a new room message arrives during generation.
- Turn interruption command with hotkey (`!interrupt` / `!i`).
- Thread lifecycle commands:
  - `thread/start`
  - `thread/resume`
  - `thread/list`
  - `thread/rollback`
  - `thread/compact/start`
  - `thread/archive`
  - `thread/unarchive`
- Approval request handlers for:
  - `item/commandExecution/requestApproval`
  - `item/fileChange/requestApproval`
- Approval commands with hotkeys:
  - approve: `!approve` / `!a`
  - decline/skip: `!skip` / `!s`
- ChatGPT auth flow support (`account/login/start`, callback trigger, completion notifications).

## Requirements

- Node.js 22+
- A Matrix bot user and access token
- Codex CLI available to the runtime container or host

## Quick Start

1. Install dependencies:
   - `npm install`
2. Copy and edit config:
   - `cp slimebot.example.yaml slimebot.yaml`
3. Start in dev mode:
   - `npm run dev`

Or with Docker Compose:

- `docker compose up --build`

Compose persists runtime logs to `./logs/slimebot.log` (also still visible in `docker compose logs`).

## Configuration

Primary config file: `slimebot.yaml`

Key sections:

- `channel.matrix`
  - homeserver URL
  - bot access token
  - bot user ID
  - optional allowed invite sender
- `controller`
  - `commandPrefix`
  - `routingPersistencePath`
- `codex`
  - command and args used to launch app-server

Default codex launch is equivalent to:

- `codex app-server --listen stdio://`

## Commands

General:

- `!help` — list commands
- `!new` — create and map a new thread to this room
- `!resume <threadId>` — resume thread and map to this room
- `!thread list [archived|true]` — list recent threads (`archived`/`true` lists archived threads)
- `!thread status [threadId]` — show thread status (`thread/read`) for a thread; defaults to mapped thread
- `!models` — list model catalog response
- `!account` — read account/auth information

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

Auth:

- `!login` — start ChatGPT managed login flow
- `!callback <full-callback-url>` — trigger callback from posted URL

## Runtime Notes

- When a room message arrives and the mapped thread has an active turn, Slimebot sends `turn/steer` with `expectedTurnId`.
- If steering fails (stale turn state), Slimebot falls back to `turn/start`.
- Active turn state is tracked from `turn/started` and `turn/completed` notifications.
- Pending approval state is tracked per room and cleared when resolved.

## Build & Check

- Type-check: `npm run check`
- Build: `npm run build`
