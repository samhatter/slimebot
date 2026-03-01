# AGENTS.md

This document provides working guidance for coding agents operating in this repository.

## Project Overview

- Name: `slimebot`
- Runtime: Node.js (ESM, TypeScript)
- Entrypoint: `src/index.ts`
- Main orchestration class: `src/controller/controller.ts`
- Channel abstraction: `src/channels/`
- Codex app server process wrapper: `src/codexProcess/`
- Configuration loading/parsing: `src/config/`

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

## Controller Refactor Boundaries

When `src/controller/controller.ts` grows:

- Extract pure utility logic to `src/controller/controllerUtils.ts`.
- Extract formatting/rendering concerns to `src/controller/controllerFormatting.ts`.
- Extract persistence/file I/O concerns to `src/controller/routingPersistence.ts`.
- Keep `BotController` focused on orchestration and event wiring.

## Validation Expectations

After code changes, run at minimum:

- `npm run check`

If edits touch runtime flow significantly, also run:

- `npm run build`

## Config & Persistence Notes

- Default route persistence path is configured via `controller.routingPersistencePath`.
- Example state file: `slimebot-routing.json`.
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
