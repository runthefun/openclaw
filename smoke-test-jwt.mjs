#!/usr/bin/env node
// Generates an Ed25519 key pair and a signed JWT for smoke testing.
// Usage: node smoke-test-jwt.mjs

import crypto from "node:crypto";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

const pubPem = publicKey.export({ type: "spki", format: "pem" });
const privKey = privateKey;

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

const header = base64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
const payload = base64url(
  JSON.stringify({
    sub: "smoke-tester",
    name: "Smoke Test User",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
  }),
);

const signature = crypto.sign(undefined, Buffer.from(`${header}.${payload}`), privKey);
const token = `${header}.${payload}.${base64url(signature)}`;

console.log("=== Public Key (set as SIMPLE_CHAT_JWT_PUBLIC_KEY) ===\n");
console.log(pubPem);
console.log("=== JWT Token (use in WS client) ===\n");
console.log(token);
console.log("\n=== Quick start ===\n");
console.log(`OPENCLAW_CONFIG_PATH=./smoke-test-config.json \\`);
console.log(`OPENROUTER_API_KEY=<your-key> \\`);
console.log(`SIMPLE_CHAT_JWT_PUBLIC_KEY='${pubPem.trimEnd()}' \\`);
console.log(`node dist/simple-chat/server.js`);
console.log(`\n=== wscat test ===\n`);
console.log(`wscat -c "ws://127.0.0.1:18800/?token=${token}"`);
console.log(`> {"type":"chat.send","id":"1","sessionKey":"smoke","message":"Say hi in 5 words"}`);
