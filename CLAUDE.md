# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenClaw is a multi-channel AI gateway with extensible messaging integrations. It's a personal AI assistant that runs on users' own devices, connecting to messaging platforms (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Google Chat, Matrix, Microsoft Teams, and more).

- **Language**: TypeScript (ESM, strict mode), Node >=22.12.0
- **Package manager**: pnpm (monorepo with workspaces)
- **Build tool**: tsdown (TS bundler), Vite (UI)
- **Linter/formatter**: Oxlint (`oxlint --type-aware`) and Oxfmt
- **Test framework**: Vitest (V8 coverage, 70% threshold)

## Build, Test, and Development Commands

```bash
pnpm install              # Install dependencies
pnpm build                # Full build (TS → JS, UI bundle, plugin SDK)
pnpm check                # TypeScript check + lint + format (run before commits)
pnpm openclaw ...          # Run CLI in dev mode

# Testing
pnpm test                 # Run unit tests (vitest, parallel)
pnpm test:watch           # Watch mode
pnpm test:coverage        # Coverage report
pnpm test:e2e             # End-to-end tests
pnpm test:live            # Live tests (requires OPENCLAW_LIVE_TEST=1 + real API keys)
pnpm test:docker:all      # Docker integration tests

# Linting/Formatting
pnpm lint                 # Oxlint (type-aware)
pnpm format               # Oxfmt check
pnpm lint:fix             # Auto-fix lint issues
pnpm format:fix           # Auto-fix formatting

# UI (Lit-based control panel)
pnpm ui:build             # Build control UI
pnpm ui:dev               # Dev server for control UI

# Full validation (what CI runs)
pnpm build && pnpm check && pnpm test
```

Use `scripts/committer "<msg>" <file...>` for commits instead of manual `git add`/`git commit`.

## Architecture

### Monorepo Structure

Workspaces defined in `pnpm-workspace.yaml`:

- **Root (`.`)** — Core application
- **`ui/`** — Control UI (Lit web components, Vite build)
- **`packages/*`** — Workspace packages (clawdbot, moltbot)
- **`extensions/*`** — 36+ channel/feature plugins

### Source Code (`src/`) — Key Modules

- **`src/cli/`, `src/commands/`** — CLI wiring (Commander.js), 183 command files
- **`src/gateway/`** — Control plane server (HTTP/WebSocket), protocol, auth, sessions, channel coordination
- **`src/agents/`** — Agent orchestration, auth profiles, model switching/failover, sandbox execution, tool definitions
- **`src/channels/`, `src/routing/`** — Channel abstraction layer, message routing between channels and agents
- **`src/config/`** — Config loading/parsing, session management, user preferences
- **`src/infra/`** — Environment, port management, binary detection, error handling, process management
- **`src/memory/`** — Conversation memory, vector embeddings, semantic search
- **`src/media/`, `src/media-understanding/`** — Media processing pipeline, image/video understanding
- **`src/hooks/`** — Lifecycle and event hooks
- **`src/web/`** — Web chat UI integration
- **`src/canvas-host/`** — Canvas rendering host

Built-in messaging channels: `src/telegram/`, `src/discord/`, `src/slack/`, `src/signal/`, `src/imessage/`, `src/web/`, `src/line/`

### Extensions (`extensions/`)

Each extension has its own `package.json`. Plugin-only deps go in the extension's `package.json`, not root. Avoid `workspace:*` in `dependencies` (use `devDependencies` or `peerDependencies` for `openclaw`).

### Skills (`skills/`)

54+ bundled AI skills (1password, github, coding-agent, canvas, etc.).

### Native Apps (`apps/`)

- **macOS** — SwiftUI menu bar app (`apps/macos/`)
- **iOS** — SwiftUI app, uses xcodegen (`apps/ios/`)
- **Android** — Gradle-based (`apps/android/`)
- **Shared** — OpenClawKit shared code (`apps/shared/`)

### Build Output

- `dist/` — Compiled JS (main, entry, plugin-sdk)
- `dist/control-ui/` — Built UI assets

## Coding Conventions

- Strict TypeScript; avoid `any`. ESM throughout.
- Formatting/linting enforced by Oxlint + Oxfmt; run `pnpm check` before commits.
- Keep files under ~700 LOC (guideline); split/refactor for clarity.
- Tests colocated as `*.test.ts`; e2e as `*.e2e.test.ts`.
- Naming: **OpenClaw** for product/docs; `openclaw` for CLI/binary/paths/config keys.
- CLI progress: use `src/cli/progress.ts` (osc-progress + @clack/prompts). Don't hand-roll spinners.
- Status tables: use `src/terminal/table.ts` for ANSI-safe wrapping.
- Color palette: use `src/terminal/palette.ts` (no hardcoded colors).
- Control UI uses Lit with **legacy decorators** (`@state()`, `@property()`). Do not switch to standard decorators without updating the UI build tooling.
- SwiftUI (iOS/macOS): prefer `Observation` framework (`@Observable`, `@Bindable`) over `ObservableObject`/`@StateObject`.

## Key Constraints

- Never update the Carbon dependency.
- Patched dependencies (`pnpm.patchedDependencies`) must use exact versions (no `^`/`~`).
- Patching/vendoring dependencies requires explicit approval.
- When refactoring shared channel logic (routing, allowlists, pairing, commands, onboarding), consider **all** built-in + extension channels.
- When adding channels/extensions/apps/docs, check `.github/labeler.yml` for label coverage.
- Tool schema guardrails: avoid `Type.Union` in tool input schemas (no `anyOf`/`oneOf`/`allOf`). Use `stringEnum`/`optionalStringEnum` for string lists. Avoid raw `format` as a property name.
- Never send streaming/partial replies to external messaging surfaces; only final replies.
- Do not change version numbers without explicit consent.

## Testing Guidelines

- Coverage thresholds: 70% lines/functions/statements, 55% branches.
- Do not set test workers above 16.
- Live tests require `OPENCLAW_LIVE_TEST=1` env var.
- Pure test additions generally don't need a changelog entry.

## Commit & PR Conventions

- Use `scripts/committer "<msg>" <file...>` for staging + committing.
- Concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).
- Keep PRs focused (one change per PR).
- Full gate before pushing: `pnpm build && pnpm check && pnpm test`.
- Changelog entry required unless test-only. Include PR # and thank contributors.
- PR merge preference: **rebase** for clean commits, **squash** for messy history.

## Docs (Mintlify)

- Hosted at docs.openclaw.ai.
- Internal links: root-relative, no `.md`/`.mdx` extension (e.g., `[Config](/configuration)`).
- Avoid em dashes and apostrophes in headings (break Mintlify anchors).
- `docs/zh-CN/` is auto-generated; do not edit unless explicitly asked.
- Docs content must be generic: no personal device names/hostnames/paths.

## Docker & Deployment

- `Dockerfile` — Main image (node:22-bookworm, non-root execution)
- `docker-compose.yml` — Gateway (port 18789 protocol, 18790 bridge) + CLI
- `fly.toml` — Fly.io production deployment
- Gateway binds to loopback (127.0.0.1) by default
