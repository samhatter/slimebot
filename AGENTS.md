# AGENTS.md

This document provides working guidance for coding agents operating in this repository.

## Project Overview

- Name: `slimebot`
- Runtime: Node.js (ESM, TypeScript)
- Entrypoint: `src/index.ts`
- Main orchestration class: `src/controller/controller.ts`
- Channel abstraction: `src/channels/`
- Matrix command parsing/aliases: `src/channels/matrix/matrixCommands.ts`
- Matrix message formatting: `src/channels/matrix/matrixFormatting.ts`
- Codex app server process wrapper: `src/codexProcess/`
- Configuration loading/parsing: `src/config/`

## Identity and Ownership Boundaries

- Slimebot operates with its own GitHub account (`slimebot-codex`) and its own auth context.
- Slimebot does not control the user's personal GitHub account.
- Slimebot does not control the user's personal computer outside the configured workspace/container.
- Slimebot is autonomous in its workspace and may perform repository maintenance needed for requested tasks.
- Assume the user may also be editing concurrently; re-read files before major edits and keep diffs scoped.

## Codex API Reference

- Codex app-server API overview: https://github.com/openai/codex/tree/main/codex-rs/app-server#api-overview

## Quick Start

- Install dependencies:
  - `npm install`
- Typecheck:
  - `npm run check`
- Build:
  - `npm run build`
- Run dev mode:
  - `npm run dev`
- Run built app:
  - `npm run start`

## Editing Guidelines

- Keep behavior changes minimal and targeted to the request.
- Prefer extracting helpers into focused modules instead of growing `controller.ts`.
- Preserve existing message text/command UX unless explicitly asked to change it.
- Avoid broad refactors across channels/config/process layers unless necessary.
- Do not add new dependencies unless they are clearly justified.
- Keep docs (`README.md`, `AGENTS.md`) aligned when commands/config/runtime behavior change.

## Controller Refactor Boundaries

When `src/controller/controller.ts` grows:

- Extract pure utility logic to `src/controller/controllerUtils.ts`.
- Extract command/response parsing helpers to `src/controller/commands.ts`.
- Extract persistence concerns to `src/controller/stateDatabase.ts`.
- Keep Matrix-specific rendering in `src/channels/matrix/matrixFormatting.ts`.
- Keep `BotController` focused on orchestration and event wiring.

## Validation Expectations

After code changes, run at minimum:

- `npm run check`

If edits touch runtime flow significantly, also run:

- `npm run build`

## Config & Persistence Notes

- State persistence path is configured via `controller.stateDatabasePath`.
- `controller.commandPrefix` is parsed in config, but Matrix command parsing currently accepts canonical commands with or without `!`.
- Example state file: `/app/state/slimebot-state.sqlite3`.
- Main app config files in repo root:
  - `slimebot.yaml`
  - `slimebot.example.yaml`

## Operational Notes

- The app can be run via Docker (`Dockerfile`, `docker-compose.yml`) or directly via npm scripts.
- Avoid committing secrets or local-only config changes.
- Keep logs and generated artifacts out of source edits unless requested.

## PR / Change Hygiene

- Keep diffs small and coherent.
- Update docs when adding commands, config keys, or user-visible behavior.
- If uncertain about intent, choose the simplest implementation that matches existing patterns.

## GitHub Workflow Notes

- In this environment, the agent operates under a separate GitHub account (`slimebot-codex`) rather than the user account.
- When creating PRs to `samhatter/slimebot`, assume fork-based PR flow unless direct push access is explicitly confirmed:
  - push branch to `slimebot-codex/slimebot`
  - open PR from `slimebot-codex:<branch>` into `samhatter:main`
- If git push fails due to HTTPS auth, use per-command helper:
  - `git -c credential.helper='!gh auth git-credential' push ...`
- If `gh` GraphQL operations fail due token scopes (for example missing `read:org`), use `gh api` REST endpoints where possible.
