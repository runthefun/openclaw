import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { MsgContext } from "../auto-reply/templating.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { loadConfig } from "../config/config.js";
import { parseMessageWithAttachments, type ChatAttachment } from "../gateway/chat-attachments.js";
import {
  injectTimestamp,
  timestampOptsFromConfig,
} from "../gateway/server-methods/agent-timestamp.js";
import { type JwtVerifyOptions, verifyJwt } from "./jwt.js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const PORT = Number(process.env.SIMPLE_CHAT_PORT ?? 18800);
const HOST = process.env.SIMPLE_CHAT_HOST ?? "127.0.0.1";
const HEARTBEAT_INTERVAL_MS = parseDurationMs(
  process.env.SIMPLE_CHAT_HEARTBEAT_INTERVAL_MS,
  30_000,
);
const HEARTBEAT_TIMEOUT_MS = parseDurationMs(process.env.SIMPLE_CHAT_HEARTBEAT_TIMEOUT_MS, 10_000);

const JWT_PUBLIC_KEY = process.env.SIMPLE_CHAT_JWT_PUBLIC_KEY?.replace(/\\n/g, "\n");
const JWT_ALGORITHM = (process.env.SIMPLE_CHAT_JWT_ALGORITHM ?? "EdDSA") as "EdDSA" | "RS256";
const JWT_ISSUER = process.env.SIMPLE_CHAT_JWT_ISSUER;
const JWT_AUDIENCE = process.env.SIMPLE_CHAT_JWT_AUDIENCE;

if (!JWT_PUBLIC_KEY) {
  console.error("SIMPLE_CHAT_JWT_PUBLIC_KEY is required");
  process.exit(1);
}

const jwtOpts: JwtVerifyOptions = {
  publicKey: JWT_PUBLIC_KEY,
  algorithm: JWT_ALGORITHM,
  issuer: JWT_ISSUER,
  audience: JWT_AUDIENCE,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChatSendMessage = {
  type: "chat.send";
  id: string;
  sessionKey: string;
  message: string;
  attachments?: ChatAttachment[];
};

type ChatAbortMessage = {
  type: "chat.abort";
  runId: string;
};

type InboundMessage = ChatSendMessage | ChatAbortMessage;

type ActiveRun = {
  controller: AbortController;
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer((_req, res) => {
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const token = extractToken(req);
  if (!token) {
    console.warn(`Auth failed: no token found (url=${req.url})`);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const result = verifyJwt(token, jwtOpts);
  if (!result.ok) {
    console.warn(`JWT rejected: ${result.error}`);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, result.payload);
  });
});

wss.on(
  "connection",
  (ws: WebSocket, _req: http.IncomingMessage, jwtPayload: Record<string, unknown>) => {
    const activeRuns = new Map<string, ActiveRun>();
    let waitingForPong = false;
    let pongDeadline = 0;

    const heartbeatTimer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) {
        return;
      }
      if (waitingForPong) {
        if (Date.now() >= pongDeadline) {
          console.warn("Heartbeat timeout: terminating websocket");
          ws.terminate();
        }
        return;
      }
      waitingForPong = true;
      pongDeadline = Date.now() + HEARTBEAT_TIMEOUT_MS;
      ws.ping();
    }, HEARTBEAT_INTERVAL_MS);

    ws.on("pong", () => {
      waitingForPong = false;
      pongDeadline = 0;
    });

    ws.on("message", (raw) => {
      let msg: InboundMessage;
      try {
        msg = JSON.parse(
          typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8"),
        ) as InboundMessage;
      } catch {
        sendJson(ws, { type: "chat.error", error: "Invalid JSON" });
        return;
      }

      if (msg.type === "chat.send") {
        void handleChatSend(ws, msg, jwtPayload, activeRuns);
      } else if (msg.type === "chat.abort") {
        handleChatAbort(msg, activeRuns);
      } else {
        sendJson(ws, {
          type: "chat.error",
          error: `Unknown message type: ${(msg as { type: string }).type}`,
        });
      }
    });

    ws.on("close", () => {
      clearInterval(heartbeatTimer);
      for (const run of activeRuns.values()) {
        run.controller.abort();
      }
      activeRuns.clear();
    });
  },
);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleChatSend(
  ws: WebSocket,
  msg: ChatSendMessage,
  jwtPayload: Record<string, unknown>,
  activeRuns: Map<string, ActiveRun>,
): Promise<void> {
  const runId = crypto.randomUUID();
  const abortController = new AbortController();
  activeRuns.set(runId, { controller: abortController });

  sendJson(ws, { type: "chat.ack", id: msg.id, runId });

  try {
    const cfg = loadConfig();

    // Parse attachments
    let parsedMessage = msg.message;
    let images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    if (msg.attachments && msg.attachments.length > 0) {
      const parsed = await parseMessageWithAttachments(msg.message, msg.attachments, {
        maxBytes: 5_000_000,
      });
      parsedMessage = parsed.message;
      images = parsed.images;
    }

    const stampedMessage = injectTimestamp(parsedMessage, timestampOptsFromConfig(cfg));

    const ctx: MsgContext = {
      Body: parsedMessage,
      BodyForAgent: stampedMessage,
      BodyForCommands: parsedMessage,
      RawBody: parsedMessage,
      CommandBody: parsedMessage,
      SessionKey: msg.sessionKey,
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "webchat",
      ChatType: "direct",
      CommandAuthorized: true,
      MessageSid: runId,
      SenderId: typeof jwtPayload.sub === "string" ? jwtPayload.sub : undefined,
      SenderName:
        typeof jwtPayload.name === "string"
          ? jwtPayload.name
          : typeof jwtPayload.email === "string"
            ? jwtPayload.email
            : undefined,
    };

    const finalized = finalizeInboundContext(ctx);

    const result = await getReplyFromConfig(
      finalized,
      {
        runId,
        abortSignal: abortController.signal,
        images: images.length > 0 ? images : undefined,
        onBlockReply: (p) => {
          if (p.text) {
            sendJson(ws, { type: "chat.block", runId, text: p.text });
          }
        },
        onToolResult: (p) => {
          if (p.text) {
            sendJson(ws, { type: "chat.tool", runId, text: p.text });
          }
        },
        onModelSelected: (c) => {
          sendJson(ws, { type: "chat.model", runId, provider: c.provider, model: c.model });
        },
      },
      cfg,
    );

    // Extract final text from result
    const finalText = extractFinalText(result);
    sendJson(ws, { type: "chat.final", runId, text: finalText });
  } catch (err) {
    if (!abortController.signal.aborted) {
      sendJson(ws, { type: "chat.error", runId, error: String(err) });
    }
  } finally {
    activeRuns.delete(runId);
  }
}

function handleChatAbort(msg: ChatAbortMessage, activeRuns: Map<string, ActiveRun>): void {
  const run = activeRuns.get(msg.runId);
  if (run) {
    run.controller.abort();
    activeRuns.delete(msg.runId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractToken(req: http.IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  return url.searchParams.get("token") ?? undefined;
}

function extractFinalText(result: Awaited<ReturnType<typeof getReplyFromConfig>>): string | null {
  if (!result) {
    return null;
  }
  if (Array.isArray(result)) {
    const texts = result.map((r) => r.text?.trim()).filter(Boolean);
    return texts.length > 0 ? texts.join("\n\n") : null;
  }
  return result.text?.trim() || null;
}

function sendJson(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function parseDurationMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, HOST, () => {
  console.log(`simple-chat server listening on ${HOST}:${PORT}`);
});
