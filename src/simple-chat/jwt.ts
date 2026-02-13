import crypto from "node:crypto";

export type JwtVerifyOptions = {
  publicKey: string;
  algorithm: "EdDSA" | "RS256";
  issuer?: string;
  audience?: string;
};

export type JwtResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string };

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function algToNodeParams(alg: string): {
  algorithm: string;
  key: (pem: string) => crypto.KeyObject;
} {
  switch (alg) {
    case "EdDSA":
      return {
        algorithm: undefined as unknown as string,
        key: (pem) => crypto.createPublicKey(pem),
      };
    case "RS256":
      return {
        algorithm: "RSA-SHA256",
        key: (pem) => crypto.createPublicKey(pem),
      };
    default:
      throw new Error(`Unsupported JWT algorithm: ${alg}`);
  }
}

export function verifyJwt(token: string, opts: JwtVerifyOptions): JwtResult {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, error: "Malformed JWT: expected 3 parts" };
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString("utf8"));
    payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, error: "Malformed JWT: invalid base64url encoding" };
  }

  if (header.alg !== opts.algorithm) {
    return {
      ok: false,
      error: `Algorithm mismatch: token uses ${String(header.alg)}, expected ${opts.algorithm}`,
    };
  }

  const signature = base64urlDecode(signatureB64);
  const signedData = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");

  try {
    const { algorithm, key } = algToNodeParams(opts.algorithm);
    const keyObject = key(opts.publicKey);
    const valid =
      opts.algorithm === "EdDSA"
        ? crypto.verify(undefined, signedData, keyObject, signature)
        : crypto.verify(algorithm, signedData, keyObject, signature);
    if (!valid) {
      return { ok: false, error: "Invalid signature" };
    }
  } catch (err) {
    return { ok: false, error: `Signature verification failed: ${String(err)}` };
  }

  if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: "Token expired" };
  }

  if (opts.issuer && payload.iss !== opts.issuer) {
    return {
      ok: false,
      error: `Issuer mismatch: expected ${opts.issuer}, got ${String(payload.iss)}`,
    };
  }

  if (opts.audience) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(opts.audience)) {
      return { ok: false, error: `Audience mismatch: expected ${opts.audience}` };
    }
  }

  return { ok: true, payload };
}
