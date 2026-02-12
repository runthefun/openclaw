# OpenClaw on Fly.io — Complete Manual Deployment Process

## Prerequisites

- `flyctl` CLI installed and authenticated (`fly auth login`)
- Anthropic API key (optionally OpenAI/Google keys)
- Channel credentials if needed (Discord bot token, Telegram bot token, etc.)

## Step 1: Clone & Create App

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
fly apps create my-openclaw
fly volumes create openclaw_data --size 1 --region iad
```

Pick a region near you (`iad` = Virginia, `lhr` = London, `sjc` = San Jose).

## Step 2: Configure `fly.toml`

The repo ships a working `fly.toml`. Key settings to customize:

```toml
app = "my-openclaw"          # your app name
primary_region = "iad"        # your region

[env]
OPENCLAW_STATE_DIR = "/data"  # persistent state on volume
NODE_OPTIONS = "--max-old-space-size=1536"

[processes]
app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"

[http_service]
internal_port = 3000          # must match --port above
auto_stop_machines = "off"    # keep alive for persistent connections
min_machines_running = 1

[[vm]]
memory = "2048mb"             # minimum 2GB (Signal needs Java → more RAM)

[mounts]
source = "openclaw_data"      # matches volume name from step 1
destination = "/data"
```

**CAVEAT 1 — `--bind lan` not `--bind 0.0.0.0`**: The gateway rejects raw IP addresses. `--bind lan` is the symbolic flag that internally resolves to `0.0.0.0` inside the Fly VM. Using `--bind 0.0.0.0` directly produces an invalid bind error.

**CAVEAT 2 — `internal_port` must match `--port`**: Health checks hit this port. A mismatch means the app appears unhealthy and gets killed.

## Step 3: Set Secrets

```bash
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
# Optional:
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set DISCORD_BOT_TOKEN=MTQ...
```

**CAVEAT 3 — Gateway token is mandatory when binding non-loopback**: Since `--bind lan` exposes the gateway beyond localhost, the token is required for security. Without it, connections are unauthenticated and rejected.

Save the generated `OPENCLAW_GATEWAY_TOKEN` value — you'll need it later for device pairing and local CLI connection.

## Step 4: Deploy

```bash
fly deploy
```

**CAVEAT 4 — First deploy is slow**: The Docker build (Node 22 + pnpm install + full build + UI build) takes several minutes. After the machine starts, the gateway needs **60-90 seconds** to fully initialize. Don't assume failure during this window.

Verify:

```bash
fly status          # machine should be "started"
fly logs            # look for "Gateway listening on ws://0.0.0.0:3000"
```

## Step 5: Configure Trusted Proxies (CRITICAL — Undocumented)

**This is the #1 cause of failed deployments.** Fly.io routes all traffic through internal proxy infrastructure (`172.16.x.x` range). Without configuring `trustedProxies`, every connection fails with:

> "Proxy headers detected from untrusted address"

**Steps:**

1. Check logs for the rejected proxy IP:

   ```bash
   fly logs   # look for "untrusted address 172.16.x.x" or similar
   ```

2. SSH in and create the config:

   ```bash
   fly ssh console
   ```

3. Create/edit `/data/openclaw.json`:

   ```json
   {
     "gateway": {
       "trustedProxies": ["172.16.0.0/12", "10.0.0.0/8"]
     }
   }
   ```

   **CAVEAT 5 — Proxy IPs are region-specific**: The CIDR ranges above cover most Fly regions, but the exact proxy IP can vary. If you still see rejections after setting these ranges, extract the specific IP from the logs and add it explicitly to the array.

4. Restart the machine:

   ```bash
   fly machine list               # get machine ID
   fly machine restart <machine-id>
   ```

## Step 6: Device Pairing (Undocumented for Remote Deployments)

When you first access `https://my-openclaw.fly.dev/`, the web UI connects and triggers a pairing request. On a remote Fly deployment, **there is no interactive approval flow** — you must approve manually.

**Option A — Via CLI over SSH:**

```bash
fly ssh console
# Inside the VM:
node dist/index.js devices approve <requestId>
```

**Option B — Manual file manipulation:**

```bash
fly ssh console
cat /data/devices/pending.json     # find the pending device entry
# Move/copy the entry from pending.json to paired.json
vi /data/devices/paired.json       # or use node to manipulate JSON
```

**CAVEAT 6 — Pairing requests expire in 5 minutes**: If you miss the window, refresh the web UI to trigger a new pairing request, then approve it quickly.

After approving, refresh the browser — the connection should establish.

## Step 7: Channel Configuration (Optional)

If running Discord, Telegram, etc., add channel config to `/data/openclaw.json`:

```bash
fly ssh console
vi /data/openclaw.json
```

Example with Discord:

```json
{
  "gateway": {
    "trustedProxies": ["172.16.0.0/12", "10.0.0.0/8"]
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "model": "claude-sonnet-4-5-20250929"
      }
    ]
  },
  "discord": {
    "enabled": true
  }
}
```

Then restart: `fly machine restart <machine-id>`

## Step 8: Verify Everything

1. `fly logs` — no proxy warnings, gateway listening
2. `https://my-openclaw.fly.dev/` — web UI loads and connects
3. Send a test message — get a response
4. Channel bots respond (if configured)

## Updating

```bash
git pull
fly deploy
fly status && fly logs
```

Note: Config in `/data/openclaw.json` persists across deploys (it's on the volume). But machine command overrides may reset.

## Private / Hardened Deployment

For hiding the deployment from internet scanners:

- Release public IPs and allocate private-only IPv6
- Access via:
  - **Fly proxy**: `fly proxy 3000:3000`
  - **WireGuard VPN**
  - **SSH only**
- For webhooks without public exposure, use **ngrok tunnels** or **Tailscale Funnel**

## Troubleshooting

| Problem                                         | Solution                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| "App not listening on expected address"         | Add `--bind lan` to the process command in `fly.toml`            |
| Health checks failing                           | Verify `internal_port` matches the gateway `--port`              |
| Memory issues                                   | Increase `memory` to `2048mb` in `fly.toml`                      |
| Gateway lock errors                             | SSH in and `rm -f /data/gateway.*.lock`                          |
| "Proxy headers detected from untrusted address" | Configure `trustedProxies` in `/data/openclaw.json` (see Step 5) |
| "pairing required"                              | Approve device pairing via SSH (see Step 6)                      |
| Config not reading                              | Verify `/data/openclaw.json` exists via SSH                      |
| State not persisting                            | Confirm `OPENCLAW_STATE_DIR=/data` is set and volume is mounted  |

## Summary of All Caveats

| #   | Caveat                                       | Impact if Missed                              |
| --- | -------------------------------------------- | --------------------------------------------- |
| 1   | Use `--bind lan`, never `--bind 0.0.0.0`     | Invalid bind error, gateway won't start       |
| 2   | `internal_port` must match `--port`          | Health checks fail, machine killed            |
| 3   | Gateway token required for non-loopback bind | Connections rejected as unauthenticated       |
| 4   | First startup takes 60-90s                   | Premature assumption of deployment failure    |
| 5   | **Trusted proxies are mandatory**            | ALL connections fail with "untrusted address" |
| 6   | Device pairing is manual on remote deploys   | Can't use web UI without SSH approval         |
| 7   | Persistent volume is essential               | All config/pairings/history lost on redeploy  |

## Estimated Costs

The recommended configuration (`shared-cpu-2x`, 2048 MB RAM, 1 GB volume) costs approximately **$10-15/month** depending on usage, with some free tier allowance.
