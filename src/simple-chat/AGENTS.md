# Context

We use an external web chat client that connects to the OpenClaw gateway via WebSocket. The gateway has many features we don't need (channel routing, TTS, complex protocol, typing indicators, cross-channel dispatch, etc.). We recently patched the gateway for JWT auth (commit 4d51876), but want to minimize fork divergence with upstream.

Goal: Build a standalone WS server that bypasses all gateway orchestration and calls directly into getReplyFromConfig() — the function where all agent value lives (session management, directive parsing, model selection/fallback, tool execution, streaming). Zero modifications to existing files (except build config).

Architecture
│ │
│ External Chat Client │
│ │ │
│ ▼ │
│ [simple-chat/server.ts] ◄── NEW: thin WS server with JWT auth │
│ │ │
│ │ builds MsgContext + calls directly │
│ ▼ │
│ getReplyFromConfig() ◄── EXISTING: unchanged │
│ │ │
│ ├── session init, directives, model selection │
│ ├── runPreparedReply → runReplyAgent → runAgentTurnWithFallback │
│ └── runEmbeddedPiAgent → activeSession.prompt(...) │

# simple-chat

A thin WebSocket server that exposes the OpenClaw agent over a minimal JSON protocol. It bypasses the full gateway (routing, TTS, typing indicators, send policies, etc.) and calls directly into `getReplyFromConfig()` -- the function that handles session management, directive parsing, model selection/fallback, tool execution, and streaming.

## Why this exists

The main gateway has many features designed for multi-channel routing and the control UI. External chat clients that only need to talk to the agent don't need any of that. This server provides a direct path with JWT authentication, flat JSON messages, and nothing else.

## Architecture

```
WS Client  -->  [simple-chat/server.ts]  -->  getReplyFromConfig()
                   JWT auth on upgrade         (sessions, directives, models,
                   flat JSON protocol            tools, streaming -- all intact)
```

## Running

```bash
pnpm build

OPENCLAW_CONFIG_PATH=/path/to/openclaw.json \
SIMPLE_CHAT_JWT_PUBLIC_KEY='-----BEGIN PUBLIC KEY-----
...
-----END PUBLIC KEY-----' \
node dist/simple-chat/server.js
```

The server loads config via `loadConfig()`, which respects `OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR`. Agent auth credentials (API keys) must exist in `~/.openclaw/agents/main/agent/auth-profiles.json` (or wherever your state dir points).

## Environment variables

| Variable                     | Default     | Purpose                                 |
| ---------------------------- | ----------- | --------------------------------------- |
| `SIMPLE_CHAT_PORT`           | `18800`     | Server listen port                      |
| `SIMPLE_CHAT_HOST`           | `127.0.0.1` | Bind address                            |
| `SIMPLE_CHAT_JWT_PUBLIC_KEY` | (required)  | PEM public key for JWT verification     |
| `SIMPLE_CHAT_JWT_ALGORITHM`  | `EdDSA`     | JWT algorithm: `EdDSA` or `RS256`       |
| `SIMPLE_CHAT_JWT_ISSUER`     | (none)      | Expected `iss` claim (skipped if unset) |
| `SIMPLE_CHAT_JWT_AUDIENCE`   | (none)      | Expected `aud` claim (skipped if unset) |

## Authentication

JWT is verified on the WebSocket upgrade request. Provide the token via either:

- **Header:** `Authorization: Bearer <token>`
- **Query param:** `ws://host:port/?token=<token>`

The JWT payload's `sub` is used as `SenderId` and `name` (or `email`) as `SenderName` in the agent context.

If verification fails, the upgrade is rejected with HTTP 401.

## Protocol

All messages are flat JSON objects with a `type` field. No envelope framing or protocol negotiation.

### Client to server

**Send a message:**

```json
{
  "type": "chat.send",
  "id": "unique-client-id",
  "sessionKey": "user-123",
  "message": "hello"
}
```

`sessionKey` maps to an OpenClaw session. Same key = same conversation history.

**With image attachments:**

```json
{
  "type": "chat.send",
  "id": "2",
  "sessionKey": "user-123",
  "message": "What is in this image?",
  "attachments": [{ "type": "image", "mimeType": "image/jpeg", "content": "<base64-data>" }]
}
```

**Abort a running request:**

```json
{
  "type": "chat.abort",
  "runId": "<runId from chat.ack>"
}
```

### Server to client

| Type         | Fields                       | When                                                                      |
| ------------ | ---------------------------- | ------------------------------------------------------------------------- |
| `chat.ack`   | `id`, `runId`                | Immediately after receiving `chat.send`                                   |
| `chat.model` | `runId`, `provider`, `model` | Model selected for this run                                               |
| `chat.block` | `runId`, `text`              | Streaming text chunk                                                      |
| `chat.tool`  | `runId`, `text`              | Tool result                                                               |
| `chat.final` | `runId`, `text`              | Run complete. `text` is the full reply (or `null` if streamed via blocks) |
| `chat.error` | `runId` (optional), `error`  | Error message                                                             |

## Writing a WS client

### Minimal JavaScript/TypeScript

```js
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:18800/?token=YOUR_JWT");

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "chat.send",
      id: "1",
      sessionKey: "my-session",
      message: "Hello!",
    }),
  );
});

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw));

  switch (msg.type) {
    case "chat.ack":
      // msg.runId is now available for abort
      break;
    case "chat.block":
      process.stdout.write(msg.text); // streaming chunk
      break;
    case "chat.tool":
      console.log("[tool]", msg.text);
      break;
    case "chat.model":
      console.log(`Using ${msg.provider}/${msg.model}`);
      break;
    case "chat.final":
      console.log("\n[done]", msg.text);
      ws.close();
      break;
    case "chat.error":
      console.error("[error]", msg.error);
      ws.close();
      break;
  }
});
```

### Browser

```js
const ws = new WebSocket("ws://127.0.0.1:18800/?token=YOUR_JWT");

ws.onopen = () => {
  ws.send(
    JSON.stringify({
      type: "chat.send",
      id: crypto.randomUUID(),
      sessionKey: "browser-session",
      message: "Hello from the browser!",
    }),
  );
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "chat.block") {
    document.getElementById("output").textContent += msg.text;
  } else if (msg.type === "chat.final") {
    // reply complete
  } else if (msg.type === "chat.error") {
    console.error(msg.error);
  }
};
```

### Abort pattern

```js
let currentRunId = null;

// On ack, store the runId
// msg.type === "chat.ack" -> currentRunId = msg.runId

// To abort:
ws.send(JSON.stringify({ type: "chat.abort", runId: currentRunId }));
```

### Python

```python
import json
import websocket

ws = websocket.create_connection(
    "ws://127.0.0.1:18800/?token=YOUR_JWT"
)
ws.send(json.dumps({
    "type": "chat.send",
    "id": "1",
    "sessionKey": "py-session",
    "message": "Hello from Python!",
}))

while True:
    msg = json.loads(ws.recv())
    if msg["type"] == "chat.block":
        print(msg["text"], end="", flush=True)
    elif msg["type"] == "chat.final":
        if msg.get("text"):
            print(msg["text"])
        break
    elif msg["type"] == "chat.error":
        print("Error:", msg["error"])
        break

ws.close()
```

## Docker

Build and run with Docker:

```bash
docker build -f src/simple-chat/Dockerfile -t simple-chat .

docker run --rm \
  -p 18800:18800 \
  -v ~/.openclaw:/home/node/.openclaw \
  -e SIMPLE_CHAT_JWT_PUBLIC_KEY="$(cat key.pub)" \
  -e OPENROUTER_API_KEY="sk-or-..." \
  -e OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
  simple-chat
```

Or use the compose file:

```bash
cd src/simple-chat

# Create a .env with your values
cat > .env << 'EOF'
SIMPLE_CHAT_JWT_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\nMCow...\n-----END PUBLIC KEY-----
OPENROUTER_API_KEY=sk-or-...
OPENCLAW_CONFIG_DIR=~/.openclaw
EOF

docker compose up
```

The container binds to `0.0.0.0` inside Docker (overriding the default `127.0.0.1`) so port mapping works. The `.openclaw` volume provides the config file and agent auth profiles.

### Image stats

| Metric       | Value              |
| ------------ | ------------------ |
| Image size   | ~2.5 GB            |
| Startup time | ~1.3s to listening |

Size breakdown:

| Component                            | Size    | Notes                                          |
| ------------------------------------ | ------- | ---------------------------------------------- |
| `node_modules/`                      | ~812 MB | Full monorepo deps -- main bloat source        |
| Base image (`node:22-bookworm-slim`) | ~1.7 GB | Node runtime                                   |
| `dist/simple-chat/`                  | 3.4 MB  | Bundled server (tsdown inlines all TS imports) |
| `skills/`                            | 680 KB  | Bundled skills                                 |
| `docs/reference/templates/`          | 68 KB   | Workspace templates                            |

The bundled `server.js` is self-contained (tsdown bundles all TypeScript
imports into `dist/simple-chat/`). The `node_modules/` copy is only needed
for native/binary packages that cannot be inlined. A future improvement
would be to prune unused packages from the runtime `node_modules` to shrink
the image.

### Docker pitfalls

**Config silently rejected by plugin validation.** If your config omits
`plugins.slots.memory`, the validator auto-defaults it to `"memory-core"`.
That plugin is not installed in the slim Docker image, so validation fails
and `loadConfig()` silently returns `{}` -- discarding your entire config
(model, auth, everything) and falling back to hardcoded defaults
(`anthropic/claude-opus-4-6`). To avoid this, add to your config:

```json
"plugins": {
  "enabled": false,
  "slots": { "memory": "none" }
}
```

**Missing workspace templates.** The agent constructs its system prompt from
Markdown templates in `docs/reference/templates/` (AGENTS.md, IDENTITY.md,
SOUL.md, etc.). The Dockerfile copies these into the runtime image. If you
see `Missing workspace template: AGENTS.md`, the templates directory is
missing -- rebuild the image.

**Missing skills directory.** The Dockerfile also copies `skills/` into the
runtime image. Without it, bundled skills (coding-agent, github, etc.) are
unavailable. The agent still works, but skill-dependent features will be
missing.

### Custom templates and skills

You can mount your own templates and skills into the container to customize
the agent's personality and capabilities:

```bash
docker run --rm \
  -p 18800:18800 \
  -v ~/.openclaw:/home/node/.openclaw \
  -v /path/to/my-templates:/app/docs/reference/templates \
  -v /path/to/my-skills:/app/skills \
  -e SIMPLE_CHAT_JWT_PUBLIC_KEY="$(cat key.pub)" \
  -e OPENROUTER_API_KEY="sk-or-..." \
  -e OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
  simple-chat
```

The template files control the agent's system prompt sections:

| Template      | Purpose                             |
| ------------- | ----------------------------------- |
| `IDENTITY.md` | Agent name, personality, tone       |
| `SOUL.md`     | Core behavior rules and constraints |
| `AGENTS.md`   | Agent workspace instructions        |
| `TOOLS.md`    | Tool-use guidelines                 |
| `USER.md`     | Per-user context                    |
| `BOOT.md`     | Startup instructions                |

Skills are loaded from `skills/`. Each skill is either a single `.md` file
or a directory containing a `SKILL.md`. Mount a custom skills directory to
add or replace bundled skills.

### Minimal working config (smoke-test-config.json)

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "openrouter/anthropic/claude-sonnet-4.5"
      }
    }
  },
  "auth": {
    "profiles": {
      "openrouter:default": {
        "provider": "openrouter",
        "mode": "api_key"
      }
    },
    "order": {
      "openrouter": ["openrouter:default"]
    }
  },
  "plugins": {
    "enabled": false,
    "slots": { "memory": "none" }
  }
}
```

The API key is read from the `OPENROUTER_API_KEY` environment variable --
it does not go in the config file.

## What the agent handles (via getReplyFromConfig)

- Session init, reset, and persistence
- Directive parsing (`/think`, `/model`, `/new`, etc.)
- Model selection with provider fallback
- Agent workspace and tool execution
- Streaming block replies and tool results
- Media/link understanding
- Skill loading and system prompt injection
- Auto-compaction and context overflow recovery

## What is skipped (gateway layers)

- Gateway WS protocol and envelope framing
- Idempotency/dedup cache
- Send policy checks
- Cross-channel message routing
- TTS pipeline
- Typing indicators
- Heartbeat management
- Reply dispatcher queue

## Files

| File                 | Purpose                                                         |
| -------------------- | --------------------------------------------------------------- |
| `server.ts`          | HTTP server, WS upgrade with JWT, message handling, agent calls |
| `jwt.ts`             | JWT decode + signature verification (EdDSA, RS256)              |
| `Dockerfile`         | Multi-stage build: full build then slim runtime image           |
| `docker-compose.yml` | Compose config with volume mounts and env vars                  |
