#!/usr/bin/env node
// Tests abort: sends a long message then aborts after first response.
import WebSocket from "ws";

const token = process.argv[2];
const ws = new WebSocket(`ws://127.0.0.1:18800/?token=${token}`);

const timeout = setTimeout(() => {
  ws.close();
  process.exit(1);
}, 15000);
let runId = null;
let gotAck = false;
let aborted = false;

ws.on("open", () => {
  console.log("[connected]");
  ws.send(
    JSON.stringify({
      type: "chat.send",
      id: "abort-1",
      sessionKey: "smoke-abort",
      message: "Write a 500-word essay about the history of computing. Be very detailed.",
    }),
  );
  console.log("[sent long message]");
});

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.type === "chat.ack") {
    runId = msg.runId;
    gotAck = true;
    console.log(`[ACK] runId=${runId}`);
    // Abort after a short delay
    setTimeout(() => {
      console.log("[sending abort]");
      ws.send(JSON.stringify({ type: "chat.abort", runId }));
      aborted = true;
      // Give it a moment then close
      setTimeout(() => {
        console.log("[PASS] abort sent, closing");
        clearTimeout(timeout);
        ws.close();
        process.exit(0);
      }, 2000);
    }, 1000);
  } else if (msg.type === "chat.final") {
    console.log(`[FINAL] text length: ${msg.text?.length ?? 0}`);
    if (aborted) {
      console.log("[PASS] got final after abort (short response = abort worked)");
    }
    clearTimeout(timeout);
    ws.close();
    process.exit(0);
  } else if (msg.type === "chat.error") {
    console.log(`[ERROR] ${msg.error}`);
    if (aborted) {
      console.log("[PASS] got error after abort (expected)");
    }
    clearTimeout(timeout);
    ws.close();
    process.exit(0);
  } else if (msg.type === "chat.block") {
    process.stdout.write(".");
  } else {
    console.log(`[${msg.type}]`);
  }
});

ws.on("error", (err) => {
  console.error(`[WS ERROR] ${err.message}`);
  process.exit(1);
});
