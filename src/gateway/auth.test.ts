import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeGatewayConnect } from "./auth.js";

function encodeBase64Url(value: Buffer | string): string {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function mintTestJwt(input: {
  privateKeyPem: string;
  issuer?: string;
  audience?: string;
  subject?: string;
  email?: string;
  app?: string;
  exp?: number;
  iat?: number;
  jti?: string;
}): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = {
    alg: "EdDSA",
    typ: "JWT",
  };
  const payload = {
    iss: input.issuer ?? "clawpilot-control-plane",
    aud: input.audience ?? "clawpilot-test.fly.dev",
    sub: input.subject ?? "user_1",
    email: input.email ?? "user@example.com",
    app: input.app ?? "clawpilot-test",
    role: "operator",
    scopes: ["operator.admin"],
    iat: input.iat ?? nowSeconds,
    exp: input.exp ?? nowSeconds + 300,
    jti: input.jti ?? "jti-1",
  };

  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign(null, Buffer.from(signingInput, "utf8"), input.privateKeyPem);
  return `${signingInput}.${encodeBase64Url(signature)}`;
}

describe("gateway auth", () => {
  it("does not throw when req is missing socket", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "secret" },
      // Regression: avoid crashing on req.socket.remoteAddress when callers pass a non-IncomingMessage.
      req: {} as never,
    });
    expect(res.ok).toBe(true);
  });

  it("reports missing and mismatched token reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("token_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("token_mismatch");
  });

  it("reports missing token config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", allowTailscale: false },
      connectAuth: { token: "anything" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_missing_config");
  });

  it("accepts valid short-lived JWT in token mode", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const token = mintTestJwt({ privateKeyPem, audience: "clawpilot-test.fly.dev" });

    const res = await authorizeGatewayConnect({
      auth: {
        mode: "token",
        allowTailscale: false,
        jwtPublicKey: publicKeyPem,
      },
      connectAuth: { token },
      req: {
        headers: {
          host: "clawpilot-test.fly.dev",
        },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("jwt-token");
    expect(res.user).toBe("user@example.com");
  });

  it("returns jwt_expired when token is expired", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = mintTestJwt({
      privateKeyPem,
      exp: nowSeconds - 1,
      iat: nowSeconds - 60,
    });

    const res = await authorizeGatewayConnect({
      auth: {
        mode: "token",
        allowTailscale: false,
        jwtPublicKey: publicKeyPem,
      },
      connectAuth: { token },
      req: {
        headers: {
          host: "clawpilot-test.fly.dev",
        },
      } as never,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("jwt_expired");
  });

  it("returns jwt_audience_mismatch when audience does not match", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const token = mintTestJwt({ privateKeyPem, audience: "clawpilot-test.fly.dev" });

    const res = await authorizeGatewayConnect({
      auth: {
        mode: "token",
        allowTailscale: false,
        jwtPublicKey: publicKeyPem,
      },
      connectAuth: { token },
      req: {
        headers: {
          host: "another-host.fly.dev",
        },
      } as never,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("jwt_audience_mismatch");
  });

  it("reports missing and mismatched password reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("password_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: { password: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("password_mismatch");
  });

  it("reports missing password config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "password", allowTailscale: false },
      connectAuth: { password: "secret" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("password_missing_config");
  });

  it("treats local tailscale serve hostnames as direct", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: { token: "secret" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "gateway.tailnet-1234.ts.net:443" },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("token");
  });

  it("allows tailscale identity to satisfy token mode auth", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: async () => ({ login: "peter", name: "Peter" }),
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-for": "100.64.0.1",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "ai-hub.bone-egret.ts.net",
          "tailscale-user-login": "peter",
          "tailscale-user-name": "Peter",
        },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("tailscale");
    expect(res.user).toBe("peter");
  });
});
