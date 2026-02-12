# OpenClaw Architecture

Internal reference for developers working on the OpenClaw codebase.

## Overall Architecture

OpenClaw is a personal AI assistant that runs as a **gateway daemon** on the user's device. It connects to multiple messaging platforms (Telegram, Discord, Slack, WhatsApp, Signal, iMessage, etc.) and routes messages to AI agents that process them using LLM providers (Anthropic, OpenAI, Google, local models).

```
 Messaging Channels                Gateway (daemon)                    AI Providers
┌──────────────┐               ┌─────────────────────┐
│  Telegram     │──┐           │                     │           ┌──────────────┐
│  Discord      │──┤  inbound  │   Routing            │  API     │  Anthropic    │
│  Slack        │──┼──────────>│     ↓                │────────> │  OpenAI       │
│  WhatsApp     │──┤           │   Agent Loop         │<──────── │  Google       │
│  Signal       │──┤           │     ↓                │           │  Ollama       │
│  Web UI       │──┘  outbound │   Response Delivery  │           └──────────────┘
│  CLI          │<─────────────│                     │
│  iOS/Android  │              │   Memory / Sessions  │
└──────────────┘               └─────────────────────┘
```

The gateway runs on a single port (default `18789`) serving both the WebSocket protocol (for clients, nodes, and channels) and HTTP (for the control UI, OpenAI-compatible API, and webhooks).

## Key Concepts

### Agents

An **agent** is a configured AI persona. Each agent has its own:

- **Model** configuration (primary + fallback chain)
- **Workspace** directory (`~/.openclaw/workspace/` for the default agent, `~/.openclaw/workspace-<id>/` for others) containing personality files (`SOUL.md`, `IDENTITY.md`), user context (`USER.md`, `TOOLS.md`), and memory (`MEMORY.md`)
- **Agent directory** (`~/.openclaw/agents/<id>/`) containing session transcripts
- **Skills** (filtered subset of available skills)
- **Sandbox** settings

Agents are defined in `agents.list` in the config. If none are configured, a single implicit agent with id `"main"` is used. One agent is marked as the default and handles messages that don't match any routing binding.

### Sessions

A **session** is a conversation thread identified by a **session key** — a colon-delimited string encoding agent, channel, and peer information.

Session key formats:

- `agent:main:main` — the default/main session
- `agent:main:telegram:dm:12345` — a per-peer DM session
- `agent:main:discord:group:789` — a group chat session
- `agent:main:subagent:task-abc` — a spawned subagent session

What determines the session key for incoming messages:

1. **Routing** resolves which agent handles the message (via bindings or default)
2. **`session.dmScope`** config determines DM session granularity:
   - `"main"` (default) — all DMs from all channels share `agent:<id>:main`
   - `"per-peer"` — each contact gets `agent:<id>:dm:<peerId>`
   - `"per-channel-peer"` — per contact per channel
   - `"per-account-channel-peer"` — most granular
3. **Group/channel messages** always get their own session key with the group/channel ID
4. **Web UI and CLI** send `sessionKey: "main"` which resolves to `agent:<id>:main`

Each session persists:

- A JSONL transcript file (`~/.openclaw/agents/<id>/sessions/*.jsonl`)
- Metadata in a session store (model preferences, thinking level, token usage, compaction count)

### Channels

Channels are **I/O adapters** for messaging platforms. They translate between platform-specific message formats and OpenClaw's internal `MsgContext` format. A channel handles:

- Inbound message parsing (webhook/polling/socket)
- Outbound reply delivery (API calls to the platform)
- Media upload/download
- Platform features (threading, reactions, typing indicators)

Built-in channels live in `src/telegram/`, `src/discord/`, `src/slack/`, `src/signal/`, `src/imessage/`, `src/web/`, `src/line/`. Extension channels live in `extensions/` (matrix, msteams, googlechat, etc.).

### Routing & Bindings

When a message arrives from a channel, the routing system (`src/routing/resolve-route.ts`) determines which agent handles it. Bindings are checked in priority order:

1. Specific peer match (user/contact)
2. Thread parent peer match
3. Guild/server match
4. Team match
5. Account match
6. Channel wildcard
7. Default agent

### Skills

Skills are packaged tool bundles in `skills/`. Each skill has a `SKILL.md` describing its capabilities and usage. At agent boot, the system prompt lists available skills. When the agent determines a skill applies, it reads the skill's `SKILL.md` for instructions.

### Nodes

Nodes are devices (iOS, Android, macOS) that connect to the gateway with `role: "node"` and provide capabilities like camera, screen capture, canvas rendering, location, and voice. They go through a separate node pairing flow.

## Key Systems

### Gateway Server

**Location**: `src/gateway/`

The gateway is the central daemon. It runs an HTTP/WebSocket server on a single port:

- **WebSocket protocol** — typed request/response + server-push events for all clients (CLI, web UI, mobile apps, nodes). Handshake requires `connect` as the first frame with auth credentials and optional device identity.
- **HTTP endpoints** — serves the control UI (static files with config injection), OpenAI-compatible chat completions API (`/v1/chat/completions`), OpenResponses API (`/v1/responses`), tool invocation API, webhooks, and channel callbacks.
- **Protocol methods** — 40+ methods including `chat.send`, `chat.history`, `chat.abort`, `sessions.list`, `config.get`, `models.list`, `node.pair.*`, `device.pair.*`.

### Agent Loop

**Location**: `src/agents/pi-embedded-runner/`

The agent loop is powered by the **Pi framework** (`@mariozechner/pi-coding-agent`). OpenClaw wraps Pi and adds streaming, failover, persistence, and tool management.

The loop:

```
1. Build system prompt (tool list, skills, workspace files, runtime info)
2. Load/validate conversation history from session transcript
3. Send context + user message to LLM
4. Stream response:
   - Text chunks → emitted as block replies
   - Tool call requests → execute tool, feed result back, loop to step 3
   - End turn → exit loop
5. Persist transcript + update session metadata
```

**Error recovery** wraps the loop with retries:

- Auth failure → rotate API key/profile
- Rate limit → cooldown + try next profile
- Context overflow → auto-compact conversation, then truncate tool results
- Thinking unsupported → downgrade thinking level

**Event subscription** (`src/agents/pi-embedded-subscribe.ts`) listens to Pi framework events and translates them into streaming replies, tool progress updates, and client events.

### Tools

**Location**: `src/agents/bash-tools.ts`, `src/agents/tools/`

Tools are functions the AI model can invoke during the agent loop. Built-in tools:

- **File ops**: `read`, `write`, `edit`, `apply_patch`, `grep`, `find`, `ls`
- **Execution**: `exec` (shell commands), `process` (background sessions)
- **Web**: `web_search`, `web_fetch`, `browser`
- **Messaging**: `message` (send to channels), `sessions_send`, `sessions_spawn`
- **Memory**: `memory_search`, `memory_get`
- **System**: `canvas`, `nodes`, `cron`, `gateway`, `session_status`, `image`

Custom tools come from skills and plugins.

### Memory System

**Location**: `src/memory/`, `src/agents/tools/memory-tool.ts`

Two layers:

**1. Bootstrap injection (system prompt)**

`MEMORY.md` from the agent's workspace is loaded as a bootstrap file and injected into the system prompt's `# Project Context` section on every agent run. This happens for all sessions except subagent sessions. Capped at 20k chars.

**2. Searchable index (tool-driven)**

Daily memory files (`memory/*.md`) and optionally session transcripts are indexed into a SQLite database with embeddings for semantic search:

- **Indexing**: files are chunked (~400 tokens, 80-token overlap), embedded via an embedding provider (OpenAI `text-embedding-3-small` by default), and stored in `~/.openclaw/memory/<agentId>.sqlite`
- **Search**: hybrid retrieval combining vector cosine similarity (70%) and FTS5 keyword search (30%)
- **Access**: via `memory_search` and `memory_get` tools that the agent calls when the system prompt instructs it to recall prior context
- **Sync triggers**: file changes (chokidar), session transcript growth, on-demand when search finds a dirty index

**Memory creation**:

- **Session-memory hook**: on `/new` command, saves recent conversation to `memory/YYYY-MM-DD-<slug>.md`
- **Memory flush**: before context compaction, the agent is prompted to write durable facts to daily files
- **Agent writes**: the agent can write to `MEMORY.md` or `memory/*.md` at any time using file tools

### Session & Context Management

**Location**: `src/config/sessions.ts`, `src/auto-reply/reply/`

- **Session store**: JSON file mapping session keys to metadata (session ID, model, thinking level, token count, compaction count, last activity)
- **Transcript files**: JSONL with one line per conversation turn (messages, tool calls, usage stats)
- **Context window guard**: before sending to the LLM, checks if the transcript fits. If not, auto-compacts (summarizes old messages) or truncates oversized tool results
- **Queue modes**: controls how concurrent messages are handled per session:
  - `immediate` — run now
  - `followup` — queue behind current run
  - `collect` — batch messages, run once
  - `interrupt` — abort current, start fresh

### Bootstrap Files (Workspace)

**Location**: `src/agents/workspace.ts`

On each agent run, workspace files are loaded and injected into the system prompt:

| File           | Purpose                       | Subagent sessions |
| -------------- | ----------------------------- | ----------------- |
| `AGENTS.md`    | Agent instructions/guidelines | Included          |
| `TOOLS.md`     | Tool usage guidance           | Included          |
| `SOUL.md`      | Persona and tone              | Excluded          |
| `IDENTITY.md`  | Agent identity                | Excluded          |
| `USER.md`      | User context                  | Excluded          |
| `HEARTBEAT.md` | Heartbeat behavior            | Excluded          |
| `BOOTSTRAP.md` | Onboarding notes              | Excluded          |
| `MEMORY.md`    | Persistent memory             | Excluded          |

Subagent sessions (spawned child tasks) only receive `AGENTS.md` and `TOOLS.md` to keep their prompts lean. All other session types (main, per-peer DM, group, channel, cron) receive the full set.

Files are capped at 20k chars each (configurable via `agents.defaults.bootstrapMaxChars`). A bootstrap hook (`agent:bootstrap`) allows plugins to modify the file list before injection.

### Device Pairing & Auth

**Location**: `src/infra/device-pairing.ts`, `src/gateway/device-auth.ts`

Two auth layers for WebSocket connections:

1. **Gateway auth** (shared secret): token or password checked first
2. **Device pairing** (per-device): Ed25519 challenge-response
   - Client generates keypair, signs a challenge nonce from the server
   - New devices require operator approval (`openclaw devices approve`)
   - Approved devices receive a device token for future connections
   - Local clients (loopback) are auto-approved

### Extensions & Plugins

**Location**: `extensions/`, plugin SDK at `src/plugin-sdk/`

Extensions are pnpm workspace packages that implement the plugin SDK. Each has its own `package.json`. Plugin deps stay in the extension package, not root. Extensions provide:

- Additional messaging channels (Matrix, MS Teams, Google Chat, etc.)
- Memory backends (LanceDB)
- Auth providers
- Device capabilities
- Diagnostics

## Key Workflows

### Message Processing (inbound → response)

```
1. Message arrives (channel webhook, WebSocket chat.send, CLI)
      ↓
2. Channel adapter parses into MsgContext (unified format)
      ↓
3. Routing resolves {agentId, sessionKey} via bindings
      ↓
4. Gateway ACKs immediately, processing continues async
      ↓
5. Session state loaded (or created), model resolved
      ↓
6. Message enriched (media understanding, link extraction,
   conversation history, timestamps)
      ↓
7. Queue decision (immediate / followup / collect / interrupt)
      ↓
8. Agent loop runs (Pi framework):
   - System prompt built (tools, skills, bootstrap files, runtime info)
   - LLM called with context + message
   - Model generates text and/or tool calls
   - Tools execute, results fed back, loop repeats
   - Replies streamed to client (block → block → final)
      ↓
9. Response routed back to originating channel
      ↓
10. Transcript persisted, session metadata updated,
    memory index marked dirty
```

### Session Lifecycle

```
1. First message to a session key → session entry created
   in store with new transcript file
      ↓
2. Messages accumulate in JSONL transcript
      ↓
3. Context approaches window limit:
   a. Memory flush fires (agent writes durable facts to memory/*.md)
   b. Auto-compaction summarizes old messages
      ↓
4. User runs /new → session-memory hook saves conversation
   summary to memory/*.md, session resets with fresh transcript
```

### Memory Recall

```
1. User asks about prior work/decisions/preferences
      ↓
2. System prompt instructs agent: "run memory_search first"
      ↓
3. Agent calls memory_search(query)
      ↓
4. Manager embeds query, runs hybrid search:
   - Vector: cosine similarity in sqlite-vec
   - Keyword: BM25 in FTS5
   - Merge: 70% vector + 30% keyword score
      ↓
5. Top snippets returned (path, line range, score, text)
      ↓
6. Agent optionally calls memory_get(path, from, lines)
   to read full sections
      ↓
7. Agent uses recalled context to answer
```

### Device Pairing (new client)

```
1. Client generates Ed25519 keypair
      ↓
2. Connects via WebSocket, receives connect.challenge with nonce
      ↓
3. Signs payload (deviceId, clientId, mode, role, nonce, timestamp)
      ↓
4. Sends connect request with auth token + device identity
      ↓
5. Gateway checks:
   a. Gateway auth (token/password) → reject if invalid
   b. Device known? → issue stored device token, proceed
   c. Device unknown + local? → auto-approve, issue token
   d. Device unknown + remote? → create pairing request (5min TTL)
      ↓
6. Operator approves: openclaw devices approve <requestId>
      ↓
7. Device token issued, client stores for future connections
```

### Subagent Spawning

```
1. Agent decides task is complex or long-running
      ↓
2. Calls sessions_spawn(agentId, message)
      ↓
3. Gateway creates child session: agent:<id>:subagent:<childId>
      ↓
4. Child gets minimal bootstrap (AGENTS.md + TOOLS.md only),
   promptMode: "minimal" (no MEMORY.md, SOUL.md, etc.)
      ↓
5. Child runs independently, parent can:
   - sessions_history(childKey) to check progress
   - sessions_send(childKey, message) to steer
      ↓
6. Child finishes, parent notified
```
