# Docker Setup: Non-Obvious Learnings

Practical issues discovered while running OpenClaw locally via Docker.

## Token Mismatch Between `.env` and Config

`docker-setup.sh` auto-generates `OPENCLAW_GATEWAY_TOKEN` in `.env`, but the interactive onboarding writes a **different** token to `~/.openclaw/openclaw.json` under `gateway.auth.token`. The gateway uses the config file token. This causes `gateway token mismatch` errors on web UI and CLI connections.

**Fix:** After onboarding, check the actual token in `~/.openclaw/openclaw.json` (`gateway.auth.token`) and use that, not the `.env` value.

## Device Pairing Chicken-and-Egg

The web UI and CLI both require **device pairing** approval before they can connect. But the CLI itself needs to be paired to run `devices approve`. This is a deadlock when bootstrapping from scratch.

**Workaround:** Directly edit the JSON files on disk:

1. Read `~/.openclaw/devices/pending.json` to get the pending request(s)
2. Move entries into `~/.openclaw/devices/paired.json` with the `PairedDevice` structure (see `src/infra/device-pairing.ts` for the schema — needs `tokens` with a random hex UUID, `createdAtMs`, `approvedAtMs`)
3. Clear `pending.json` to `{}`
4. Restart the gateway

## `pairing` vs `devices` CLI Commands

- **`openclaw pairing`** — Channel-level pairing (WhatsApp, Telegram, etc.). Requires `--channel`.
- **`openclaw devices`** — Device-level pairing (web UI, CLI instances). This is what the web Control UI needs.

The web UI rejection message says "pairing required" but the fix is via `devices`, not `pairing`.

## CLI Container Cannot Reach Gateway at 127.0.0.1

`docker compose run openclaw-cli` starts a **separate container**. It cannot reach the gateway at `127.0.0.1:18789` because they have different network namespaces. Use `docker compose exec openclaw-gateway` to run CLI commands inside the gateway container instead. Even then, the CLI process needs the correct token (see token mismatch above).

## `gateway.remote.token` Config Key

The CLI reads `gateway.remote.token` from `openclaw.json` to authenticate its WebSocket connection to the gateway. If this key is missing, set it to match `gateway.auth.token`:

```json
{
  "gateway": {
    "auth": { "token": "..." },
    "remote": { "token": "..." }
  }
}
```

## Onboarding Requires Interactive Terminal

The `docker-setup.sh` onboarding step (`openclaw onboard`) uses TUI prompts (select menus, yes/no). It cannot run from a non-interactive context. Run onboarding manually in your terminal:

```bash
docker compose -f docker-compose.yml run --rm openclaw-cli onboard --no-install-daemon
```
