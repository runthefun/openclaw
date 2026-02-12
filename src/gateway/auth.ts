import type { IncomingMessage } from "node:http";
import { createPublicKey, timingSafeEqual, verify } from "node:crypto";
import type { GatewayAuthConfig, GatewayTailscaleMode } from "../config/config.js";
import { readTailscaleWhoisIdentity, type TailscaleWhoisIdentity } from "../infra/tailscale.js";
import {
  isLoopbackAddress,
  isTrustedProxyAddress,
  parseForwardedForClientIp,
  resolveGatewayClientIp,
} from "./net.js";
export type ResolvedGatewayAuthMode = "token" | "password";

const JWT_PUBLIC_KEY_ENV = "OPENCLAW_GATEWAY_JWT_PUBLIC_KEY";
const JWT_ISSUER_ENV = "OPENCLAW_GATEWAY_JWT_ISSUER";
const JWT_AUDIENCE_ENV = "OPENCLAW_GATEWAY_JWT_AUDIENCE";
const DEFAULT_JWT_ISSUER = "clawpilot-control-plane";
const MAX_IAT_FUTURE_SKEW_SECONDS = 60;

export type ResolvedGatewayAuth = {
  mode: ResolvedGatewayAuthMode;
  token?: string;
  password?: string;
  allowTailscale: boolean;
  jwtPublicKey?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
};

export type GatewayAuthResult = {
  ok: boolean;
  method?: "token" | "password" | "tailscale" | "device-token" | "jwt-token";
  user?: string;
  reason?: string;
};

type ConnectAuth = {
  token?: string;
  password?: string;
};

type TailscaleUser = {
  login: string;
  name: string;
  profilePic?: string;
};

type TailscaleWhoisLookup = (ip: string) => Promise<TailscaleWhoisIdentity | null>;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function getHostName(hostHeader?: string): string {
  const host = (hostHeader ?? "").trim().toLowerCase();
  if (!host) {
    return "";
  }
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end !== -1) {
      return host.slice(1, end);
    }
  }
  const [name] = host.split(":");
  return name ?? "";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function decodeBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64");
}

function parseJsonObject(value: Buffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function maybeDecodeBase64(value: string): string {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || normalized.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(normalized)) {
    return value;
  }

  try {
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    if (decoded.includes("BEGIN") && decoded.includes("PUBLIC KEY")) {
      return decoded;
    }
  } catch {
    // ignore decode errors and use raw value
  }

  return value;
}

function normalizePublicKey(rawValue: string): string {
  return maybeDecodeBase64(rawValue.trim()).replace(/\\n/g, "\n").trim();
}

function resolveJwtPublicKey(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env[JWT_PUBLIC_KEY_ENV]?.trim();
  if (!raw) {
    return undefined;
  }

  return normalizePublicKey(raw);
}

function resolveExpectedAudience(params: {
  configuredAudience?: string;
  req?: IncomingMessage;
}): string | undefined {
  const configured = params.configuredAudience?.trim();
  if (configured) {
    return configured;
  }

  const host = getHostName(headerValue(params.req?.headers?.host));
  return host || undefined;
}

function hasAudienceClaim(audClaim: unknown, expectedAudience?: string): boolean {
  if (!expectedAudience) {
    return true;
  }

  if (typeof audClaim === "string") {
    return audClaim === expectedAudience;
  }

  if (Array.isArray(audClaim)) {
    return audClaim.some((value) => typeof value === "string" && value === expectedAudience);
  }

  return false;
}

function verifyGatewayJwt(params: {
  token: string;
  publicKey: string;
  expectedIssuer: string;
  expectedAudience?: string;
}): { ok: true; email: string } | { ok: false; reason: string } {
  const { token, publicKey, expectedIssuer, expectedAudience } = params;
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "jwt_invalid_format" };
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    return { ok: false, reason: "jwt_invalid_format" };
  }

  const header = parseJsonObject(decodeBase64Url(encodedHeader));
  const payload = parseJsonObject(decodeBase64Url(encodedPayload));
  if (!header || !payload) {
    return { ok: false, reason: "jwt_invalid_format" };
  }

  if (header.alg !== "EdDSA") {
    return { ok: false, reason: "jwt_header_invalid" };
  }

  let publicKeyObject;
  try {
    publicKeyObject = createPublicKey(publicKey);
  } catch {
    return { ok: false, reason: "jwt_public_key_invalid" };
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = decodeBase64Url(encodedSignature);
  const signatureValid = verify(
    null,
    Buffer.from(signingInput, "utf8"),
    publicKeyObject,
    signature,
  );
  if (!signatureValid) {
    return { ok: false, reason: "jwt_signature_invalid" };
  }

  const issuer = typeof payload.iss === "string" ? payload.iss : "";
  if (!issuer || issuer !== expectedIssuer) {
    return { ok: false, reason: "jwt_issuer_mismatch" };
  }

  if (!hasAudienceClaim(payload.aud, expectedAudience)) {
    return { ok: false, reason: "jwt_audience_mismatch" };
  }

  const exp = typeof payload.exp === "number" ? payload.exp : NaN;
  if (!Number.isFinite(exp)) {
    return { ok: false, reason: "jwt_exp_invalid" };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (exp <= nowSeconds) {
    return { ok: false, reason: "jwt_expired" };
  }

  const iat = typeof payload.iat === "number" ? payload.iat : NaN;
  if (!Number.isFinite(iat) || iat > nowSeconds + MAX_IAT_FUTURE_SKEW_SECONDS) {
    return { ok: false, reason: "jwt_iat_invalid" };
  }

  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  const app = typeof payload.app === "string" ? payload.app.trim() : "";
  const jti = typeof payload.jti === "string" ? payload.jti.trim() : "";
  const email = typeof payload.email === "string" ? payload.email.trim() : "";

  if (!sub || !app || !jti) {
    return { ok: false, reason: "jwt_claims_invalid" };
  }
  if (!email) {
    return { ok: false, reason: "jwt_email_missing" };
  }

  return { ok: true, email };
}

function resolveTailscaleClientIp(req?: IncomingMessage): string | undefined {
  if (!req) {
    return undefined;
  }
  const forwardedFor = headerValue(req.headers?.["x-forwarded-for"]);
  return forwardedFor ? parseForwardedForClientIp(forwardedFor) : undefined;
}

function resolveRequestClientIp(
  req?: IncomingMessage,
  trustedProxies?: string[],
): string | undefined {
  if (!req) {
    return undefined;
  }
  return resolveGatewayClientIp({
    remoteAddr: req.socket?.remoteAddress ?? "",
    forwardedFor: headerValue(req.headers?.["x-forwarded-for"]),
    realIp: headerValue(req.headers?.["x-real-ip"]),
    trustedProxies,
  });
}

export function isLocalDirectRequest(req?: IncomingMessage, trustedProxies?: string[]): boolean {
  if (!req) {
    return false;
  }
  const clientIp = resolveRequestClientIp(req, trustedProxies) ?? "";
  if (!isLoopbackAddress(clientIp)) {
    return false;
  }

  const host = getHostName(req.headers?.host);
  const hostIsLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const hostIsTailscaleServe = host.endsWith(".ts.net");

  const hasForwarded = Boolean(
    req.headers?.["x-forwarded-for"] ||
    req.headers?.["x-real-ip"] ||
    req.headers?.["x-forwarded-host"],
  );

  const remoteIsTrustedProxy = isTrustedProxyAddress(req.socket?.remoteAddress, trustedProxies);
  return (hostIsLocal || hostIsTailscaleServe) && (!hasForwarded || remoteIsTrustedProxy);
}

function getTailscaleUser(req?: IncomingMessage): TailscaleUser | null {
  if (!req) {
    return null;
  }
  const login = req.headers["tailscale-user-login"];
  if (typeof login !== "string" || !login.trim()) {
    return null;
  }
  const nameRaw = req.headers["tailscale-user-name"];
  const profilePic = req.headers["tailscale-user-profile-pic"];
  const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : login.trim();
  return {
    login: login.trim(),
    name,
    profilePic: typeof profilePic === "string" && profilePic.trim() ? profilePic.trim() : undefined,
  };
}

function hasTailscaleProxyHeaders(req?: IncomingMessage): boolean {
  if (!req) {
    return false;
  }
  return Boolean(
    req.headers["x-forwarded-for"] &&
    req.headers["x-forwarded-proto"] &&
    req.headers["x-forwarded-host"],
  );
}

function isTailscaleProxyRequest(req?: IncomingMessage): boolean {
  if (!req) {
    return false;
  }
  return isLoopbackAddress(req.socket?.remoteAddress) && hasTailscaleProxyHeaders(req);
}

async function resolveVerifiedTailscaleUser(params: {
  req?: IncomingMessage;
  tailscaleWhois: TailscaleWhoisLookup;
}): Promise<{ ok: true; user: TailscaleUser } | { ok: false; reason: string }> {
  const { req, tailscaleWhois } = params;
  const tailscaleUser = getTailscaleUser(req);
  if (!tailscaleUser) {
    return { ok: false, reason: "tailscale_user_missing" };
  }
  if (!isTailscaleProxyRequest(req)) {
    return { ok: false, reason: "tailscale_proxy_missing" };
  }
  const clientIp = resolveTailscaleClientIp(req);
  if (!clientIp) {
    return { ok: false, reason: "tailscale_whois_failed" };
  }
  const whois = await tailscaleWhois(clientIp);
  if (!whois?.login) {
    return { ok: false, reason: "tailscale_whois_failed" };
  }
  if (normalizeLogin(whois.login) !== normalizeLogin(tailscaleUser.login)) {
    return { ok: false, reason: "tailscale_user_mismatch" };
  }
  return {
    ok: true,
    user: {
      login: whois.login,
      name: whois.name ?? tailscaleUser.name,
      profilePic: tailscaleUser.profilePic,
    },
  };
}

export function resolveGatewayAuth(params: {
  authConfig?: GatewayAuthConfig | null;
  env?: NodeJS.ProcessEnv;
  tailscaleMode?: GatewayTailscaleMode;
}): ResolvedGatewayAuth {
  const authConfig = params.authConfig ?? {};
  const env = params.env ?? process.env;
  const token =
    authConfig.token ?? env.OPENCLAW_GATEWAY_TOKEN ?? env.CLAWDBOT_GATEWAY_TOKEN ?? undefined;
  const password =
    authConfig.password ??
    env.OPENCLAW_GATEWAY_PASSWORD ??
    env.CLAWDBOT_GATEWAY_PASSWORD ??
    undefined;
  const mode: ResolvedGatewayAuth["mode"] = authConfig.mode ?? (password ? "password" : "token");
  const allowTailscale =
    authConfig.allowTailscale ?? (params.tailscaleMode === "serve" && mode !== "password");
  const jwtPublicKey = resolveJwtPublicKey(env);

  return {
    mode,
    token,
    password,
    allowTailscale,
    jwtPublicKey,
    jwtIssuer: env[JWT_ISSUER_ENV]?.trim() || DEFAULT_JWT_ISSUER,
    jwtAudience: env[JWT_AUDIENCE_ENV]?.trim() || undefined,
  };
}

export function assertGatewayAuthConfigured(auth: ResolvedGatewayAuth): void {
  if (auth.mode === "token" && !auth.token && !auth.jwtPublicKey) {
    if (auth.allowTailscale) {
      return;
    }
    throw new Error(
      "gateway auth mode is token, but no token/JWT key was configured (set gateway.auth.token, OPENCLAW_GATEWAY_TOKEN, or OPENCLAW_GATEWAY_JWT_PUBLIC_KEY)",
    );
  }
  if (auth.mode === "password" && !auth.password) {
    throw new Error("gateway auth mode is password, but no password was configured");
  }
}

export async function authorizeGatewayConnect(params: {
  auth: ResolvedGatewayAuth;
  connectAuth?: ConnectAuth | null;
  req?: IncomingMessage;
  trustedProxies?: string[];
  tailscaleWhois?: TailscaleWhoisLookup;
}): Promise<GatewayAuthResult> {
  const { auth, connectAuth, req, trustedProxies } = params;
  const tailscaleWhois = params.tailscaleWhois ?? readTailscaleWhoisIdentity;
  const localDirect = isLocalDirectRequest(req, trustedProxies);

  if (auth.allowTailscale && !localDirect) {
    const tailscaleCheck = await resolveVerifiedTailscaleUser({
      req,
      tailscaleWhois,
    });
    if (tailscaleCheck.ok) {
      return {
        ok: true,
        method: "tailscale",
        user: tailscaleCheck.user.login,
      };
    }
  }

  if (auth.mode === "token") {
    if (!auth.token && !auth.jwtPublicKey) {
      return { ok: false, reason: "token_missing_config" };
    }

    if (!connectAuth?.token) {
      return { ok: false, reason: "token_missing" };
    }

    if (auth.token && safeEqual(connectAuth.token, auth.token)) {
      return { ok: true, method: "token" };
    }

    if (auth.jwtPublicKey) {
      const jwtResult = verifyGatewayJwt({
        token: connectAuth.token,
        publicKey: auth.jwtPublicKey,
        expectedIssuer: auth.jwtIssuer ?? DEFAULT_JWT_ISSUER,
        expectedAudience: resolveExpectedAudience({
          configuredAudience: auth.jwtAudience,
          req,
        }),
      });
      if (jwtResult.ok) {
        return { ok: true, method: "jwt-token", user: jwtResult.email };
      }
      return { ok: false, reason: jwtResult.reason };
    }

    return { ok: false, reason: "token_mismatch" };
  }

  if (auth.mode === "password") {
    const password = connectAuth?.password;
    if (!auth.password) {
      return { ok: false, reason: "password_missing_config" };
    }
    if (!password) {
      return { ok: false, reason: "password_missing" };
    }
    if (!safeEqual(password, auth.password)) {
      return { ok: false, reason: "password_mismatch" };
    }
    return { ok: true, method: "password" };
  }

  return { ok: false, reason: "unauthorized" };
}
