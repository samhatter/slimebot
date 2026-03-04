# AGENTS.md

Repository guidance for agents working in `repos/slimebot`.

## Project Snapshot

- Project: `slimebot`
- Runtime: Node.js 22+, TypeScript, ESM
- Entry point: `src/index.ts`
- Core orchestrator: `src/controller/controller.ts`
- Channel layer: `src/channels/` (Matrix implementation in `src/channels/matrix/`)
- Codex JSON-RPC process wrapper: `src/codexProcess/`
- Config parsing/loading: `src/config/`
- State persistence: `src/controller/stateDatabase.ts` (SQLite)

## Working Agreement

- Keep diffs small and task-focused.
- Assume concurrent edits by user; re-read touched files before committing.

## Architecture Notes

- `BotController` should stay focused on orchestration and event wiring.
- Channel transports should remain transport-specific; avoid pushing Matrix logic into generic controller utilities.
- JSON-RPC protocol interaction belongs in `codexProcess/`.
- Config schema changes should be reflected in:
  - parser code
  - `slimebot.example.yaml`
  - README command/config docs

## Command and UX Changes

When adding or changing commands, update all relevant locations:

- command catalog: `src/channels/commands.ts`
- Matrix alias/parser: `src/channels/matrix/matrixCommands.ts`
- controller dispatch/help text: `src/controller/controller.ts`
- formatting/rendering if needed: `src/channels/matrix/matrixFormatting.ts`
- docs: `README.md` and this file when behavior changes are operationally important

## Matrix Channel Guidance

- Preserve rate-limit retry behavior for outbound sends.
- Preserve typing indicator lifecycle semantics.
- Inbound attachments are downloaded to workspace attachments and forwarded as path hints; keep this stable unless requested.
- If adding new Matrix capabilities (media upload, reactions, room actions), keep transport internals in `matrixChannel.ts` and expose only needed abstractions through `Channel`.

## State and Persistence

- Room-thread mappings and thread metadata are persisted in SQLite.
- Avoid schema churn unless required.
- If schema changes are required, keep migrations backward compatible where possible and document operational impact.

## Build and Validation

Minimum after code changes:

- `npm run check`

Recommended when runtime flow changes:

- `npm run build`

If tests are touched or added:

- `npm test`

## GitHub and PR Workflow

- Keep workflow assumptions deployment-agnostic in this file.
- Prefer conservative sync/update behavior:
  - `git fetch --all --prune`
  - `git pull --ff-only` where appropriate
- When opening PRs, follow the host environment's configured contribution model.
- Document any required environment-specific git/gh auth steps in workspace-level guidance, not repo-level guidance.

## Operational Safety

- Do not commit local secrets, runtime tokens, or local-only config.
- Avoid destructive git commands unless explicitly requested.
- Keep generated artifacts and logs out of commits unless explicitly required.
