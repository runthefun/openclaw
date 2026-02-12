# OpenClaw Platform — Architecture Document

## 1. Overview

A multi-tenant SaaS platform that provisions and manages personal OpenClaw AI assistant instances for non-technical users. Each user gets a fully isolated OpenClaw gateway running on Fly.io (1 app = 1 machine = 1 volume per user). Users interact through a custom web frontend served by our control plane. API keys are platform-provided; billing is subscription-based.

### Key Design Principles

- **Isolation**: Each user runs in a separate Fly app with their own machine and volume. No cross-user communication.
- **Simplicity**: No auto-stop/start, no fly-replay, no machine cloning. Machines stay running.
- **Idempotency**: All provisioning operations use DB-level locking as the serialization point, not Fly API state.
- **Security**: Users never see API keys or gateway tokens. Short-lived JWTs for frontend-to-machine auth.

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                       User's Browser                         │
│                   (Custom Chat Frontend)                      │
└────────┬──────────────────────────────────┬──────────────────┘
         │ HTTPS (auth, config, UI)         │ WSS (chat, agent protocol)
         ▼                                  ▼
┌─────────────────────────┐    ┌──────────────────────────────┐
│     Control Plane        │    │   User's Fly App              │
│  (Node/TS, Fly app)      │    │   (openclaw-<hash>.fly.dev)   │
│                          │    │                              │
│  ├─ Gmail OAuth          │    │   1 machine (shared-cpu-2x)  │
│  ├─ User DB (Postgres)   │    │   ├─ OpenClaw gateway        │
│  ├─ Fly API client       │    │   ├─ JWT auth (no pairing)   │
│  ├─ JWT signing          │    │   ├─ /data volume (1GB)      │
│  ├─ Billing (Stripe)     │    │   │  ├─ openclaw.json        │
│  └─ Serves frontend      │    │   │  ├─ SOUL.md, IDENTITY.md │
│                          │    │   │  └─ sessions/, memory/    │
└───────────┬──────────────┘    │   └─ Env vars:               │
            │                   │      ├─ OPENCLAW_GATEWAY_TOKEN│
            │ Fly Machines API  │      ├─ JWT_PUBLIC_KEY        │
            ▼                   │      └─ LITELLM_API_KEY       │
┌─────────────────────────┐    └──────────────┬───────────────┘
│       Fly API            │                   │
│  (apps, volumes,         │                   │ LLM requests
│   machines, secrets)     │                   ▼
└──────────────────────────┘    ┌──────────────────────────────┐
                                │     LiteLLM Proxy             │
                                │  (Fly app, shared instance)   │
                                │                              │
                                │  ├─ Virtual key per user      │
                                │  ├─ Per-user RPM/TPM caps     │
                                │  ├─ Per-user budget tracking   │
                                │  ├─ Global platform budget cap │
                                │  └─ Postgres (usage data)     │
                                └──────────────┬───────────────┘
                                               │
                                               ▼
                                ┌──────────────────────────────┐
                                │      Anthropic API            │
                                │   (Single org, Tier 4+)       │
                                │   4,000 RPM / 2M ITPM pool    │
                                └──────────────────────────────┘
```

## 3. Components

### 3.1 Control Plane

**Stack**: Node.js / TypeScript, Express or Fastify, Managed Postgres
**Deployment**: Separate Fly app (single instance for now)
**Responsibilities**:

- **Authentication**: Gmail OAuth (Google Sign-In). Issues session tokens.
- **User management**: CRUD on user records, provisioning state, billing status.
- **Provisioning**: Calls Fly Machines API to create/destroy user apps, volumes, machines.
- **JWT signing**: Signs short-lived JWTs (5-min TTL) that the frontend uses to authenticate with the user's OpenClaw machine.
- **Frontend serving**: Serves the custom chat UI (static assets + config endpoint).
- **Billing**: Stripe integration for subscriptions. Webhooks for payment events.
- **Janitor**: Scheduled jobs for orphan cleanup, stuck provisioning recovery, billing lifecycle transitions.

### 3.2 User Instances (Fly Apps)

**Image**: Pre-built OpenClaw fork image from `registry.fly.io/openclaw-base:<version>`
**Specs**: `shared-cpu-2x`, 2048 MB RAM, 1 GB persistent volume
**Naming**: `openclaw-<random-hash>` (globally unique, opaque)

Each instance runs the OpenClaw gateway with:

- Device pairing disabled (`dangerouslyDisableDeviceAuth: true`)
- JWT auth enabled (fork modification)
- LLM calls routed through LiteLLM proxy (via `ANTHROPIC_API_BASE_URL` env var)
- Trusted proxies configured for Fly's internal network
- Allowed origins set to our platform domain
- No messaging channels — web UI protocol only

### 3.3 LiteLLM Proxy

**Deployment**: Separate Fly app (single instance + Postgres)
**Purpose**: Per-user API usage tracking, rate limiting, and budget enforcement

- One virtual key per user, created at provisioning time
- Per-user limits: RPM, TPM, monthly budget cap
- Global platform budget cap (safety net)
- All user machines point to this proxy instead of Anthropic directly
- The real Anthropic API key lives only on the LiteLLM instance

### 3.4 CI/CD Pipeline

On each release of the OpenClaw fork:

```bash
docker build -t registry.fly.io/openclaw-base:<version> -f Dockerfile .
fly auth docker
docker push registry.fly.io/openclaw-base:<version>
docker tag registry.fly.io/openclaw-base:<version> registry.fly.io/openclaw-base:latest
docker push registry.fly.io/openclaw-base:latest
```

Image is built once, shared across all user apps via Fly's org-scoped registry.

## 4. Data Model (Postgres)

### 4.1 Users Table

```sql
CREATE TABLE users (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email                TEXT UNIQUE NOT NULL,
    name                 TEXT,
    google_id            TEXT UNIQUE NOT NULL,
    avatar_url           TEXT,

    -- Fly resources
    fly_app_name         TEXT UNIQUE,
    fly_machine_id       TEXT,
    fly_volume_id        TEXT,
    fly_region           TEXT DEFAULT 'iad',
    gateway_token        TEXT,          -- per-user, generated at provisioning

    -- LiteLLM
    litellm_key_id       TEXT,          -- virtual key ID in LiteLLM
    litellm_api_key      TEXT,          -- virtual key value

    -- Provisioning state machine
    provisioning_status  TEXT NOT NULL DEFAULT 'pending',
        -- pending | creating_app | creating_volume | setting_secrets
        -- | creating_machine | bootstrapping | ready | failed
    provisioning_error   TEXT,
    provisioning_step_at TIMESTAMPTZ,   -- when current step started

    -- Billing
    billing_status       TEXT NOT NULL DEFAULT 'active',
        -- active | past_due | grace_period | suspended | terminated
    billing_status_at    TIMESTAMPTZ,   -- when billing status last changed
    stripe_customer_id   TEXT,
    stripe_subscription_id TEXT,

    -- Account lifecycle
    status               TEXT NOT NULL DEFAULT 'active',
        -- active | deletion_requested | deleted
    deletion_requested_at TIMESTAMPTZ,

    -- Image tracking
    image_version        TEXT,          -- currently deployed image version

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_provisioning ON users (provisioning_status)
    WHERE provisioning_status NOT IN ('ready', 'failed');
CREATE INDEX idx_users_billing ON users (billing_status)
    WHERE billing_status != 'active';
CREATE INDEX idx_users_deletion ON users (status)
    WHERE status = 'deletion_requested';
```

### 4.2 Provisioning Log (Audit Trail)

```sql
CREATE TABLE provisioning_log (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id),
    step        TEXT NOT NULL,
    status      TEXT NOT NULL,     -- started | succeeded | failed
    detail      JSONB,             -- API responses, error info
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_prov_log_user ON provisioning_log (user_id, created_at DESC);
```

## 5. Provisioning Flow

### 5.1 State Machine

```
pending
  → creating_app
    → creating_volume
      → setting_secrets
        → creating_machine
          → bootstrapping     (wait for health check)
            → ready

Any step can → failed (with provisioning_error set)
```

### 5.2 Idempotent Execution

All provisioning is serialized per-user via Postgres row locks. No reliance on Fly API state for concurrency control.

```
Request arrives (signup, retry, janitor)
  │
  ▼
BEGIN TRANSACTION
  SELECT * FROM users WHERE id = $1 FOR UPDATE
  │
  ├─ status is 'ready'         → COMMIT, return (no-op)
  ├─ status is 'creating_*'
  │   └─ step_at > 10 min ago  → safe to retry (previous attempt likely dead)
  │   └─ step_at < 10 min ago  → COMMIT, return (in progress)
  ├─ status is 'pending' or 'failed' → proceed
  │
  ▼
  Set provisioning_status = next step, provisioning_step_at = now()
COMMIT
  │
  ▼
Call Fly API (outside transaction, no lock held)
  │
  ├─ Success → BEGIN TX → lock row → advance state, store resource ID → COMMIT
  │            Continue to next step
  │
  └─ Failure → BEGIN TX → lock row → set 'failed' + error message → COMMIT
               (or leave at current step for automatic retry)
```

### 5.3 Step Details

**Step 1 — Create App**:

```
POST https://api.machines.dev/v1/apps
{ "app_name": "openclaw-<hash>", "org_slug": "<our-org>" }
```

On 409 (already exists): verify it's ours (name matches DB), proceed.
Store: `fly_app_name`

**Step 2 — Create Volume**:

```
POST https://api.machines.dev/v1/apps/{app}/volumes
{ "name": "openclaw_data", "region": "iad", "size_gb": 1 }
```

On existing volume: list volumes, verify ours exists, proceed.
Store: `fly_volume_id`

**Step 3 — Set Secrets**:
Env vars are passed directly in the machine config (step 4), not as Fly secrets.
This step generates and stores the gateway token and LiteLLM virtual key:

- Generate `gateway_token` via `crypto.randomBytes(32).toString('hex')`
- Create LiteLLM virtual key via LiteLLM admin API
- Store both in DB

**Step 4 — Create Machine**:

```
POST https://api.machines.dev/v1/apps/{app}/machines
{
  "region": "iad",
  "config": {
    "image": "registry.fly.io/openclaw-base:<version>",
    "env": {
      "NODE_ENV": "production",
      "OPENCLAW_STATE_DIR": "/data",
      "NODE_OPTIONS": "--max-old-space-size=1536",
      "OPENCLAW_GATEWAY_TOKEN": "<per-user-token>",
      "JWT_PUBLIC_KEY": "<platform-jwt-public-key>",
      "ANTHROPIC_API_BASE_URL": "https://litellm-proxy.fly.dev",
      "LITELLM_API_KEY": "<per-user-virtual-key>",
      "OPENCLAW_ALLOWED_ORIGINS": "https://our-platform.com"
    },
    "guest": { "cpu_kind": "shared", "cpus": 2, "memory_mb": 2048 },
    "services": [{
      "protocol": "tcp",
      "internal_port": 3000,
      "ports": [
        { "port": 443, "handlers": ["tls", "http"] },
        { "port": 80, "handlers": ["http"] }
      ]
    }],
    "mounts": [{ "volume": "openclaw_data", "path": "/data" }],
    "init": {
      "cmd": ["/app/entrypoint.sh"]
    }
  }
}
```

Store: `fly_machine_id`, `image_version`

**Step 5 — Bootstrap (Health Check)**:

```
GET https://api.machines.dev/v1/apps/{app}/machines/{id}/wait?state=started&timeout=120
```

Then verify the gateway is responding (HTTP health endpoint).
On success: set `provisioning_status = 'ready'`

### 5.4 First-Boot Entrypoint

Custom `entrypoint.sh` in the fork that writes default config on first boot:

```bash
#!/bin/bash
set -e

CONFIG_FILE="${OPENCLAW_STATE_DIR:-/data}/openclaw.json"

if [ ! -f "$CONFIG_FILE" ]; then
  cat > "$CONFIG_FILE" <<EOF
{
  "gateway": {
    "trustedProxies": ["172.16.0.0/12", "10.0.0.0/8"],
    "controlUi": {
      "allowedOrigins": ["${OPENCLAW_ALLOWED_ORIGINS:-https://our-platform.com}"],
      "dangerouslyDisableDeviceAuth": true,
      "allowInsecureAuth": true
    }
  }
}
EOF
fi

exec node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan
```

## 6. Authentication

### 6.1 User → Control Plane (Gmail OAuth)

```
Browser → Google Sign-In → authorization code → Control Plane
Control Plane → Google token exchange → id_token (email, name, picture)
Control Plane → upsert user in DB → issue session cookie (httpOnly, secure)
```

Standard OAuth 2.0 / OpenID Connect flow with Google.

### 6.2 Frontend → User Machine (Short-Lived JWT)

OpenClaw's gateway does not natively support JWT. **Fork modification required.**

**JWT flow**:

1. Frontend calls `GET /api/connect-token` on the control plane (with session cookie)
2. Control plane verifies session, looks up user's `fly_app_name`
3. Control plane signs a JWT:
   ```json
   {
     "sub": "<user-id>",
     "app": "openclaw-<hash>",
     "iat": 1700000000,
     "exp": 1700000300
   }
   ```
   Signed with platform's Ed25519 private key. TTL: 5 minutes.
4. Frontend receives `{ jwt, appUrl }` → opens WebSocket to `wss://openclaw-<hash>.fly.dev`
5. Frontend sends `connect` frame with `auth.jwt = "<token>"`
6. Gateway verifies JWT signature using `JWT_PUBLIC_KEY` env var, checks expiry
7. On success: connection established. On expiry: frontend requests new JWT from control plane.

**Fork changes required** (see Section 12).

### 6.3 Control Plane → Fly API

Org-scoped deploy token:

```bash
fly tokens create org  # long-lived, stored as control plane secret
```

Used for all Fly Machines API calls (create/destroy apps, volumes, machines).

### 6.4 User Machine → LiteLLM Proxy

Each machine has a `LITELLM_API_KEY` env var containing the user's virtual key. OpenClaw sends LLM requests to `ANTHROPIC_API_BASE_URL` (the LiteLLM proxy) with this key in the `Authorization` header.

## 7. Connection Flow (End-to-End)

```
1. User opens https://our-platform.com
       │
2. Not logged in? → Gmail OAuth → session cookie set
       │
3. Frontend loads → calls GET /api/connect-token
       │                    │
       │        Control plane checks:
       │          - Session valid?
       │          - User provisioned? (status = 'ready')
       │          - Billing active?
       │        Signs JWT, returns { jwt, appUrl }
       │
4. Frontend opens WSS to wss://openclaw-<hash>.fly.dev
       │
5. Gateway sends connect.challenge { nonce }
       │
6. Frontend sends connect { auth: { jwt: "<token>" } }
       │
7. Gateway verifies JWT (signature + expiry) → hello-ok
       │
8. Frontend sends chat.send { message: "Hello" }
       │
9. Gateway runs agent loop:
       │  - Builds system prompt (SOUL.md, IDENTITY.md, tools, memory)
       │  - Calls LiteLLM proxy → Anthropic API
       │  - Streams response blocks back via WebSocket
       │
10. Frontend renders streamed response
```

## 8. Fair Usage & Rate Limiting

### 8.1 Architecture

Rate limits are enforced at three levels:

```
Per-user soft limits (LiteLLM virtual key)
  └─ Prevents any single user from hogging capacity
       │
Global platform limit (LiteLLM global config)
  └─ Safety net: caps total platform spend / request rate
       │
Anthropic org limit (Tier 4: 4,000 RPM, 2M ITPM)
  └─ Hard ceiling from the provider
```

### 8.2 Per-User Limits (LiteLLM)

Created at provisioning time via LiteLLM admin API:

```json
POST /key/generate
{
  "user_id": "<user-id>",
  "key_alias": "openclaw-<hash>",
  "max_budget": 50.0,
  "budget_duration": "30d",
  "tpm_limit": 100000,
  "rpm_limit": 30,
  "models": ["claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"]
}
```

| Limit          | Value   | Rationale                              |
| -------------- | ------- | -------------------------------------- |
| RPM            | 30      | Typical user sends ~1-5 messages/min   |
| TPM            | 100,000 | Allows long conversations with context |
| Monthly budget | $50     | Hard cap per user per billing cycle    |

When exceeded: LiteLLM returns 429. OpenClaw surfaces the error to the user.

### 8.3 Global Platform Limits

```yaml
# LiteLLM config
general_settings:
  max_budget: 10000 # $10k/month platform-wide safety net
  budget_duration: "30d"
```

### 8.4 Per-User Limit Tuning

Initial limits are conservative estimates. Adjust based on real usage data:

- Monitor via LiteLLM dashboard and Anthropic Admin API
- If 10% concurrency assumption holds (N users, ~10% active at any time), per-user RPM can be higher
- Can introduce tiers later (basic: 20 RPM, pro: 60 RPM)

## 9. Billing Lifecycle

### 9.1 Integration: Stripe

- User subscribes via Stripe Checkout (linked from our platform)
- Stripe webhooks notify control plane of payment events
- Control plane maps `stripe_customer_id` → user record

### 9.2 Status Transitions

```
active ──[payment fails]──→ past_due ──[3 days]──→ grace_period
                                                       │
                                              [payment received]
                                                       │
                                                       ▼
                                                    active

grace_period ──[14 days]──→ suspended ──[30 days]──→ terminated
                                │
                        [payment received]
                                │
                                ▼
                             active
```

### 9.3 Actions at Each Transition

| Transition                 | Trigger                                 | Actions                                                                                                              |
| -------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `active → past_due`        | Stripe `invoice.payment_failed` webhook | Send warning email. No infra changes.                                                                                |
| `past_due → grace_period`  | Janitor (3 days after `past_due`)       | Stop machine via Fly API (`POST .../machines/{id}/stop`). Revoke LiteLLM key. User sees "subscription expired" page. |
| `grace_period → suspended` | Janitor (14 days after `grace_period`)  | Send final warning email. Machine already stopped.                                                                   |
| `suspended → terminated`   | Janitor (30 days after `suspended`)     | Destroy Fly app (machine + volume). Delete LiteLLM key. Anonymize user data in DB. Send "account terminated" email.  |
| `any → active`             | Stripe `invoice.paid` webhook           | If machine stopped: start machine, recreate LiteLLM key. If terminated: full re-provisioning.                        |

### 9.4 User Experience During Grace Period

Frontend checks billing status via control plane API before connecting:

- `active` / `past_due`: Normal operation (with banner warning for `past_due`)
- `grace_period` / `suspended`: Show "subscription expired" page with reactivation link
- `terminated`: Show "account terminated" page

## 10. Account Deletion

### 10.1 Flow

```
User clicks "Delete my account"
  │
  ▼
Control plane sets:
  status = 'deletion_requested'
  deletion_requested_at = now()
  │
  ├─ Stop machine immediately (prevent further API usage)
  ├─ Revoke LiteLLM virtual key
  ├─ Send confirmation email with cancel link
  │
  ▼
7-day cooling period
  │
  ├─ User clicks cancel → restart machine, restore LiteLLM key, status = 'active'
  │
  ▼
Janitor executes permanent deletion:
  │
  ├─ 1. Destroy Fly app (destroys machine)
  ├─ 2. Destroy Fly volume (destroys user data: sessions, memory, personality)
  ├─ 3. Delete LiteLLM usage history (or anonymize)
  ├─ 4. Anonymize user record in DB:
  │      email = 'deleted-<hash>@redacted'
  │      name = NULL, google_id = 'deleted-<hash>', avatar_url = NULL
  │      (keep: id, created_at, stripe_customer_id for billing records)
  ├─ 5. Revoke Google OAuth tokens
  └─ 6. Send "account deleted" confirmation email (to original email, before anonymization)
  │
  ▼
  status = 'deleted'
```

### 10.2 Idempotency

Each deletion sub-step is tracked. If the janitor crashes mid-deletion:

- Steps already completed are skipped (e.g., Fly app already gone → 404 → skip)
- Resumes from the next incomplete step

## 11. Janitor (Scheduled Jobs)

A set of periodic tasks running on the control plane. Implementation: `pg-boss` (Postgres-backed job queue) or simple `setInterval` with distributed lock.

### 11.1 Job Schedule

| Job                   | Frequency    | Description                                                       |
| --------------------- | ------------ | ----------------------------------------------------------------- |
| `orphan-scan`         | Daily        | Find Fly apps matching `openclaw-*` not in DB → destroy           |
| `stuck-provisioning`  | Every 15 min | Users in intermediate provisioning state > 10 min → retry or fail |
| `billing-lifecycle`   | Daily        | Transition billing statuses based on timestamps                   |
| `deletion-executor`   | Daily        | Execute pending deletions past 7-day cooling period               |
| `health-check`        | Every 30 min | Verify `ready` users have a running machine. Restart if crashed.  |
| `image-version-check` | On deploy    | Flag users running old image versions for rolling update          |

### 11.2 Orphan Scan Detail

```
1. List all Fly apps in our org matching naming pattern
     via: GET https://api.machines.dev/v1/apps?org_slug=<org>
2. Query DB for all known fly_app_name values
3. Diff: apps in Fly but not in DB = orphans
4. For each orphan:
     - Log warning with app details
     - If app age > 1 hour (not mid-provisioning): destroy
     - Destroy sequence: delete machines → delete volumes → delete app
```

## 12. OpenClaw Fork Changes

Minimal modifications to the OpenClaw codebase:

### 12.1 JWT Authentication (New)

**Files to modify**:

- `package.json` — add `jose` dependency
- `src/gateway/protocol/schema/frames.ts` — add `jwt` field to connect auth schema
- `src/config/types.gateway.ts` — add `jwtPublicKey` to gateway auth config
- `src/gateway/auth.ts` — add JWT verification function
- `src/gateway/server/ws-connection/message-handler.ts` — handle JWT in connect flow

**Behavior**:

- If `auth.jwt` is present in the connect frame, verify using `JWT_PUBLIC_KEY` env var
- Check signature (Ed25519), expiration, and required claims (`sub`, `app`)
- On success: authorize connection (same as token auth success)
- On failure: reject with `"jwt-invalid"` or `"jwt-expired"` error code

### 12.2 Custom Entrypoint (New)

Add `entrypoint.sh` to the Docker image. Writes default `/data/openclaw.json` on first boot from env vars, then exec's the gateway.

### 12.3 Env-Driven Config (New, Optional)

Allow `OPENCLAW_ALLOWED_ORIGINS`, `OPENCLAW_TRUSTED_PROXIES` env vars to be read at startup and merged into config. Reduces reliance on config file for platform-managed settings.

### 12.4 No Other Changes

- No changes to the agent loop, memory, sessions, or WebSocket protocol
- No changes to the Control UI (we serve our own frontend)
- No changes to channels (not used)
- Personality config uses existing `agents.files.*` protocol methods

## 13. Custom Frontend

### 13.1 Responsibilities

- Login / signup (Gmail OAuth)
- Chat interface (send messages, render streamed responses)
- Personality editor (SOUL.md, IDENTITY.md via `agents.files.*` protocol)
- Account settings (billing, deletion)
- Connection management (JWT refresh, reconnection)

### 13.2 OpenClaw WebSocket Protocol (Subset Used)

| Method                    | Direction       | Purpose                     |
| ------------------------- | --------------- | --------------------------- |
| `connect`                 | Client → Server | Authenticate with JWT       |
| `chat.send`               | Client → Server | Send a message              |
| `chat.abort`              | Client → Server | Cancel in-progress response |
| `chat.history`            | Client → Server | Load conversation history   |
| `sessions.list`           | Client → Server | List user's sessions        |
| `agents.files.list`       | Client → Server | List personality files      |
| `agents.files.get`        | Client → Server | Read a personality file     |
| `agents.files.set`        | Client → Server | Save a personality file     |
| `event:chat.reply.*`      | Server → Client | Streamed response blocks    |
| `event:connect.challenge` | Server → Client | Auth handshake nonce        |
| `hello-ok`                | Server → Client | Connection established      |

### 13.3 JWT Refresh

```
Frontend keeps track of JWT expiry time
  │
  ├─ JWT expires in < 60s → preemptively request new JWT from control plane
  │   POST /api/connect-token → new JWT
  │   (connection stays open; new JWT used on reconnect)
  │
  └─ WebSocket drops → request new JWT → reconnect with fresh token
```

## 14. Rolling Image Updates

When a new OpenClaw version is released:

### 14.1 Process

```
1. CI builds new image → push to registry.fly.io/openclaw-base:v2.0.0
2. Control plane triggered (webhook, manual, or cron)
3. Query DB: SELECT id, fly_app_name, fly_machine_id FROM users
     WHERE provisioning_status = 'ready'
       AND billing_status IN ('active', 'past_due')
       AND image_version != 'v2.0.0'
4. For each user (batched, 5 at a time, with rate limiting):
     a. GET machine config from Fly API
     b. Update config.image to new version
     c. POST updated config → Fly restarts machine with new image
     d. Wait for machine started state
     e. UPDATE users SET image_version = 'v2.0.0' WHERE id = $1
5. Log results. Alert on failures.
```

### 14.2 Considerations

- Batch size limited by Fly API rate limits (1 req/s per action, burst 3)
- Failed updates leave user on old version; janitor retries later
- Rollback: re-run with previous image version
- User's `/data` volume is preserved across updates (config, personality, sessions intact)
- First boot after update is a cold start (no suspend snapshot for new image)

## 15. Infrastructure Summary

| Component       | Fly App                         | Instances              | Postgres                   | Notes                          |
| --------------- | ------------------------------- | ---------------------- | -------------------------- | ------------------------------ |
| Control Plane   | `openclaw-control`              | 1 machine              | Managed Postgres (shared)  | Serves frontend, manages users |
| LiteLLM Proxy   | `openclaw-litellm`              | 1 machine              | Same Postgres or dedicated | Per-user usage tracking        |
| User Instance   | `openclaw-<hash>`               | 1 machine + 1 vol each | None                       | One per user                   |
| Docker Registry | `registry.fly.io/openclaw-base` | —                      | —                          | Shared image store             |

### 15.1 Region Strategy

All resources in a single region (`iad`) for v1. Multi-region later if user base demands it.

### 15.2 Estimated Costs (Per User)

| Resource                                | Monthly Cost        |
| --------------------------------------- | ------------------- |
| Machine (shared-cpu-2x, 2GB, always on) | ~$10-12             |
| Volume (1 GB)                           | ~$0.15              |
| Bandwidth                               | ~$0-2               |
| LLM API usage (varies)                  | Tracked via LiteLLM |
| **Total infra per user**                | **~$12-15**         |

Platform overhead (control plane, LiteLLM, Postgres): ~$30-50/month fixed.

## 16. Security Considerations

| Concern                  | Mitigation                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------- |
| User never sees API keys | Keys live only on LiteLLM. User machines get virtual keys.                          |
| Gateway token exposure   | Token in env var (not in volume). JWT used for frontend auth.                       |
| Cross-user access        | Separate Fly apps. No internal networking between user machines.                    |
| JWT compromise           | 5-minute TTL. Ed25519 signatures. Refresh via authenticated control plane endpoint. |
| Data at rest             | Fly volumes are encrypted at rest (Fly infrastructure).                             |
| CORS                     | `allowedOrigins` locked to our platform domain.                                     |
| Admin access             | Fly org access restricted. Control plane behind auth.                               |
| Billing abuse            | LiteLLM budget caps per user. Global platform safety net.                           |

## 17. Future Considerations (Out of Scope for v1)

- **Auto-suspend/resume**: Use `auto_stop_machines = "suspend"` for cost savings (~100-500ms wake-up)
- **Multi-region**: Let users choose region at signup. Requires region-aware provisioning.
- **Machine tiers**: Different specs for different subscription tiers.
- **Custom admin panel**: Platform-wide dashboard for monitoring, user management.
- **Weighted fair scheduling**: Custom middleware for proportional rate limit distribution under contention.
- **Backup/restore**: Periodic volume snapshots to object storage for disaster recovery.
- **Messaging channels**: Enable Telegram, Discord, etc. per user (requires additional config and secrets management).
