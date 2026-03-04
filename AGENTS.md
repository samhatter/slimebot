# AGENTS.md

Repository-level guidance for agents working in `repos/slimebot`.

## Load Order

Read these files in order before making substantial changes:

1. `../../AGENTS.md`
2. `../../slimebot/identity.md`
3. `../../slimebot/user.md`
4. `../../slimebot/github.md`
5. `../../slimebot/runtime.md`
6. this file

This keeps repo work aligned with Slimebot identity/runtime context, not just local repo assumptions.

## Scope

- Project: `slimebot`
- Runtime: Node.js 22+, TypeScript, ESM
- Entry point: `src/index.ts`
- Core orchestrator: `src/controller/controller.ts`
- Channel layer: `src/channels/` (Matrix transport in `src/channels/matrix/`)
- Codex JSON-RPC wrapper: `src/codexProcess/`
- State persistence: `src/controller/stateDatabase.ts` (SQLite)

## Working Rules

- Keep diffs small and task-focused.
- Assume concurrent user edits; re-read touched files before committing.
- Avoid destructive git operations unless explicitly requested.
- Keep secrets/local runtime tokens out of commits.

## Architecture Guardrails

- Keep `BotController` focused on orchestration/event wiring.
- Keep transport-specific logic inside transport implementations (for Matrix: `matrixChannel.ts`).
- Keep protocol handling in `codexProcess/`.
- Reflect config schema changes in parser code, `slimebot.example.yaml`, and `README.md`.

## Command Surface Changes

When adding/changing commands, update all relevant locations:

- `src/channels/commands.ts`
- `src/channels/matrix/matrixCommands.ts`
- `src/controller/controller.ts`
- `src/channels/matrix/matrixFormatting.ts` (if rendering changes)
- `README.md` and this file for operationally relevant behavior

## Validation

- Minimum: `npm run check`
- Recommended for runtime flow changes: `npm run build`
- If tests are changed/added: `npm test`
