#!/usr/bin/env node
// Smoke test client for simple-chat server.
// Usage: node smoke-test-client.mjs <token> [message]

import WebSocket from "ws";

const token = process.argv[2];
if (!token) {
  console.error("Usage: node smoke-test-client.mjs <token> [message]");
  process.exit(1);
}
const message = process.argv[3] || "Say hi in exactly 5 words";

const ws = new WebSocket(`ws://127.0.0.1:18800/?token=${token}`);

let done = false;
const timeout = setTimeout(() => {
  if (!done) {
    console.error("\n[TIMEOUT] No final response after 30s");
    ws.close();
    process.exit(1);
  }
}, 30000);

ws.on("open", () => {
  console.log("[connected]");
  const payload = JSON.stringify({
    type: "chat.send",
    id: "smoke-1",
    sessionKey: "smoke-test",
    message,
  });
  console.log(`[send] ${payload}\n`);
  ws.send(payload);
});

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw));
  const tag = msg.type.replace("chat.", "").toUpperCase();
  if (msg.type === "chat.block") {
    process.stdout.write(msg.text || "");
  } else if (msg.type === "chat.final") {
    if (msg.text) {
      console.log(`\n[FINAL] ${msg.text}`);
    } else {
      console.log("\n[FINAL] (streamed above)");
    }
    done = true;
    clearTimeout(timeout);
    ws.close();
  } else if (msg.type === "chat.error") {
    console.error(`\n[ERROR] ${msg.error}`);
    done = true;
    clearTimeout(timeout);
    ws.close();
    process.exit(1);
  } else {
    console.log(`[${tag}] ${JSON.stringify(msg)}`);
  }
});

ws.on("error", (err) => {
  console.error(`[WS ERROR] ${err.message}`);
  process.exit(1);
});

ws.on("close", () => {
  if (!done) {
    console.log("[disconnected]");
  }
  process.exit(0);
});
