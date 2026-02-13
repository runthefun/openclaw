# OpenClaw Gateway Webchat Agentic Flow Breakdown

This document tracks how an inbound webchat `chat.send` message is transformed and routed through OpenClaw’s agentic pipeline.

## 1) High-level architecture layers

### 1.1 Transport / protocol ingress

- Webchat connects to gateway over HTTP(S) websocket.
- Upgrade handler and websocket message handler validate protocol envelopes (`req`, `id`, `type`, etc.).
- `chat.send` is sent as a request frame.

Key files:

- `src/gateway/server-http.ts`
- `src/gateway/server/ws-connection.ts`
- `src/gateway/server/ws-connection/message-handler.ts`
- `src/gateway/protocol/index.ts`

### 1.2 Request validation and RPC dispatch

- JSON schema validation for chat methods and params.
- `handleGatewayRequest` selects a method handler based on incoming method name.
- `chat.send` has method-level policy checks and authorization/cap checks.

Key files:

- `src/gateway/server-methods.ts`
- `src/gateway/server-methods-list.ts`
- `src/gateway/server-methods/chat.ts`

### 1.3 Chat orchestration + agent dispatch

- `chat.send` prepares runtime context, idempotency, run state, and dispatch hooks.
- Builds `MsgContext` and calls `dispatchInboundMessage(...)`.
- `dispatchInboundMessage` finalizes context and pushes through config-aware reply dispatch.

Key files:

- `src/gateway/server-methods/chat.ts`
- `src/auto-reply/dispatch.ts`
- `src/auto-reply/reply/dispatch-from-config.ts`
- `src/auto-reply/reply/inbound-context.ts`

### 1.4 Reply composition, model selection, queueing

- `getReplyFromConfig` and `runPreparedReply` assemble session state, directive parsing, prompts, tool config, and model/run metadata.
- `runReplyAgent` handles queue modes, memory flush, model fallback orchestration, typing signals, and final payload assembly.

Key files:

- `src/auto-reply/reply/get-reply.ts`
- `src/auto-reply/reply/get-reply-directives.ts`
- `src/auto-reply/reply/get-reply-inline-actions.ts`
- `src/auto-reply/reply/get-reply-run.ts`
- `src/auto-reply/reply/agent-runner.ts`
- `src/auto-reply/reply/agent-runner-execution.ts`

### 1.5 Model execution layer

- `runWithModelFallback` picks candidate provider/model tuple and retries on eligible failures.
- Provider execution goes through CLI path or embedded Pi path.
- `runEmbeddedPiAgent` + `runEmbeddedAttempt` call into the model session runtime (`activeSession.prompt(...)`).

Key files:

- `src/agents/model-fallback.ts`
- `src/agents/cli-runner.ts`
- `src/agents/pi-embedded.ts`
- `src/agents/pi-embedded-runner/run.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`

### 1.6 Outbound event delivery

- Normalized reply payloads are merged with threading tags and filtered/normalized.
- Gateway broadcasts `chat` event frames back to webchat websocket.

Key files:

- `src/auto-reply/reply/agent-runner-payloads.ts`
- `src/auto-reply/reply/agent-runner.ts`
- `src/gateway/server-broadcast.ts`
- `src/gateway/server-broadcast.ts`
- `src/gateway/server-methods/chat.ts`

---

## 2) End-to-end `webchat chat.send` workflow (detailed)

## Stage A — Request ingress and validation

### Step A1: Frame arrives in websocket handler

- The webchat client sends `{ type: 'req', method: 'chat.send', id: X, params: {...} }`.
- Gateway transport and protocol stack validates request shape and routeability.

### Step A2: Handler chooses `chat.send`

- `handleGatewayRequest` resolves handler from method registry (`server-methods.ts` / `server-methods-list.ts`).
- `chat.send` is entered in `chat.ts`.

### Step A3: Params schema + auth/policy checks

- `ChatSendParamsSchema` enforces required fields and constraints (`sessionKey`, `message`, `idempotencyKey`, etc.).
- Checks send policy via `resolveSendPolicy` and optional stop-command logic.
- Checks idempotency cache and inflight run map.

File: `src/gateway/server-methods/chat.ts`

## Stage B — Message construction

### Step B1: Attachments + text normalization

- Attachments are normalized and base64-validated by `parseMessageWithAttachments`.
- Webchat attachments are converted into `ChatImageContent[]`.
- If neither message body nor attachment exists, request fails.

Files:

- `src/gateway/server-methods/chat.ts`
- `src/gateway/chat-attachments.ts`

### Step B2: Build `MsgContext`

- `INTERNAL_MESSAGE_CHANNEL = 'webchat'` is set on:
  - `Provider`
  - `Surface`
  - `OriginatingChannel`
- `Body`, `BodyForAgent`, `BodyForCommands`, `MessageSid` (run id), and sender/client fields are set.
- Timestamp injection can be applied to `BodyForAgent` for agent-facing context.

File: `src/utils/message-channel.ts`

- `src/gateway/agent-timestamp.ts`
- `src/gateway/server-methods/chat.ts`

### Step B3: Reply dispatcher created

- `createReplyDispatcher` created with callbacks to capture final text chunks and track run start/tool events.
- `onModelSelected` callback is wired so response-prefix context can include actual provider/model after selection.

File: `src/auto-reply/reply/reply-dispatcher.ts`

- `src/channels/reply-prefix.ts`
- `src/gateway/server-methods/chat.ts`

### Step B4: Dispatch started

- `dispatchInboundMessage` is invoked with context + dispatcher + options.

File: `src/auto-reply/dispatch.ts`

## Stage C — Reply dispatch and config resolution

### Step C1: Inbound context finalization

- `finalizeInboundContext` normalizes textual fields, `BodyForAgent`, `BodyForCommands`, `CommandAuthorized`, and conversation label.

File: `src/auto-reply/reply/inbound-context.ts`

### Step C2: Duplicate checks and hooks

- `dispatch-from-config.ts` runs duplicate message checks, message_received hooks, route-to-origin checks, and `routeReply` decisions when originating channel differs.
- Fast-abort commands are intercepted there when applicable.

File: `src/auto-reply/reply/dispatch-from-config.ts`

### Step C3: Directive parsing and command handling

- `resolveReplyDirectives` parses inline directives and command tokens.
- Inline actions (tool commands, inline status, etc.) are processed.
- Rewrites body/prompt when directives require it.

Files:

- `src/auto-reply/reply/get-reply-directives.ts`
- `src/auto-reply/reply/get-reply-inline-actions.ts`

### Step C4: Session initialization + history state

- `initSessionState` resolves session freshness, reset triggers, model/provider persistence, delivery context, and group/session keys.

File:

- `src/auto-reply/reply/session.ts`

### Step C5: Build final model run object

- `runPreparedReply` builds prompt variants (`body`, queue body, media hints), run config, model metadata, tool and timeout settings, and follow-up metadata.
- Returns prepared `ReplyPayload | ReplyPayload[] | undefined` through run orchestration.

File: `src/auto-reply/reply/get-reply-run.ts`

---

## Stage D — Execute agent turn with fallback and queue semantics

### Step D1: Run orchestration and queueing

- `runReplyAgent` handles message queue modes (`interrupt`, `followup`, `steer`) and queue skip behavior.
- Executes `runAgentTurnWithFallback` for active run processing.

File: `src/auto-reply/reply/agent-runner.ts`

### Step D2: Model/provider fallback execution

- `runAgentTurnWithFallback` wraps model attempts in `runWithModelFallback`.
- On each attempt it can call:
  - `runCliAgent(...)` (CLI provider path), or
  - `runEmbeddedPiAgent(...)` (embedded model path).
- On certain failures, it can switch provider/model or rotate auth/profile; some errors return graceful final fallback payloads.

Files:

- `src/auto-reply/reply/agent-runner-execution.ts`
- `src/agents/model-fallback.ts`
- `src/agents/cli-runner.ts`
- `src/agents/pi-embedded.ts`

### Step D3: Tool output handling and final payload normalization

- Streamed tool/block/final payloads are collected via reply dispatcher + pipelines.
- `buildReplyPayloads` applies directive parsing, heartbeat filtering, threading tags, dedupe, and final render filtering.

File: `src/auto-reply/reply/agent-runner-payloads.ts`

---

## Stage E — Actual model handoff (key boundary)

### Step E1: Embedded run preparation

- `runEmbeddedPiAgent` resolves provider/model, auth profile order, context-window validation, and then calls `runEmbeddedAttempt`.

File: `src/agents/pi-embedded-runner/run.ts`

### Step E2: Runtime session build and prompt call

- In `runEmbeddedAttempt`:
  - system prompt is assembled,
  - tool sets prepared,
  - session manager + settings initialized,
  - hooks and media injection run,
  - then the concrete call is made:
    - `activeSession.prompt(effectivePrompt, { images })` (if images exist)
    - otherwise `activeSession.prompt(effectivePrompt)`.
- This is the explicit runtime boundary where the normalized chat content is sent into AI execution.

File: `src/agents/pi-embedded-runner/run/attempt.ts`

### Step E3: Result extraction

- `runEmbeddedAttempt` returns structured payloads + usage and metadata, including message-level details and errors.

File: `src/agents/pi-embedded-runner/run/attempt.ts`

---

## 3) Return path back to webchat

- `runReplyAgent` converts run result to final payloads and schedules follow-up drain.
- `chat.send` catches final result and does:
  - accumulate final text chunks when dispatcher emitted only inline/final events,
  - broadcasts `chat` state `final` event with `runId/sessionKey/seq`.
- Error path uses `broadcastChatError`.

File:

- `src/auto-reply/reply/agent-runner.ts`
- `src/gateway/server-methods/chat.ts`

Webchat-side handling exists in:

- `ui/src/ui/gateway.ts`
- `ui/src/ui/controllers/chat.ts`
- `ui/src/ui/app-gateway.ts`

---

## 4) Relevant state transitions

## `chat.send` run lifecycle

- `started` ack (immediate response to request)
- Optional streaming tool/block events via dispatcher
- `final` event once run resolves
- `error` event on exceptions
- `aborted` events on stop path / explicit abort

## Data structures touched

- `idempotency`: `context.dedupe` (`chat:${clientRunId}`)
- Active run control: `chatAbortControllers`, `chatRunBuffers`, `chatDeltaSentAt`
- Run sequencing: `agentRunSeq` for outbound event ordering

Key files:

- `src/gateway/server-methods/types.ts`
- `src/gateway/server-methods/chat.ts`
- `src/gateway/chat-abort.ts`

---

## 5) Notes specific to webchat

- Webchat messages are tagged with internal surface/channel to force webchat-aware routing and formatting behavior.
- `INTERNAL_MESSAGE_CHANNEL = "webchat"` in `/Users/yelouafi/cod/repos/openclaw/src/utils/message-channel.ts`.
- `deliver` behavior in dispatcher currently keeps final replies in-memory for fallback fallback and then emits to broadcaster if no agent-side final event was produced.
- Response prefixing can include dynamic `provider/model` context via `onModelSelected`.

---

## 6) Quick file pointer index

- `/Users/yelouafi/cod/repos/openclaw/src/gateway/server-methods/chat.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/auto-reply/dispatch.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/auto-reply/reply/dispatch-from-config.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/auto-reply/reply/get-reply.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/auto-reply/reply/get-reply-inline-actions.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/auto-reply/reply/get-reply-run.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/auto-reply/reply/agent-runner.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/auto-reply/reply/agent-runner-execution.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/auto-reply/reply/agent-runner-payloads.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/agents/model-fallback.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/agents/pi-embedded.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/agents/pi-embedded-runner/run.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/gateway/chat-attachments.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/gateway/server-broadcast.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/channels/reply-prefix.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/auto-reply/reply/session.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/gateway/server-methods/types.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/auto-reply/reply/inbound-context.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/ui/src/ui/gateway.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/ui/src/ui/controllers/chat.ts`
- `/Users/yelouafi/cod/repos/openclaw/src/ui/src/ui/app-gateway.ts`
