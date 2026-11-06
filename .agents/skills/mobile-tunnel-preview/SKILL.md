---
name: mobile-tunnel-preview
description: Authoritative guide for exposing local/WSL development services to the public internet for rapid mobile UX, touch ergonomics, and HTTP 206 audio streaming QA via Cloudflare Quick Tunnels and zero-install SSH reverse tunnels.
---

# Mobile Tunnel Preview Skill

## 1. Overview & Purpose
When testing mobile responsiveness, touch ergonomics, and audible bedtime audio streaming on real physical devices (iOS Safari, Android Chrome), local `localhost` or WSL loopback addresses are inaccessible without network bridging.

This skill defines the authoritative procedure for spinning up fast, ephemeral, zero-configuration public HTTPS tunnels to expose `localhost:8080` (or any service port) safely to external mobile devices.

---

## 2. Tunnel Providers: Priority & Mechanics

### Priority 1: Cloudflare Quick Tunnels (`cloudflared`) — Strongly Recommended
- **Why:** Full HTTP/2 and TLS termination over Cloudflare's global Anycast edge network. Does **not** disconnect on idle, has zero connection limits for testing, and reliably proxies HTTP `206 Partial Content` audio Range requests without dropping headers.
- **Account Requirement:** Zero. Runs anonymously via ephemeral `*.trycloudflare.com` domain.

#### Quick Launch (WSL / Linux)
```bash
# 1. Download standalone binary (if not already cached)
if [ ! -f /tmp/cloudflared ]; then
  curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /tmp/cloudflared
  chmod +x /tmp/cloudflared
fi

# 2. Launch background tunnel (port 8080)
/tmp/cloudflared tunnel --url http://127.0.0.1:8080 --no-autoupdate
```

#### Extracting the Public URL
The URL appears in stderr within 3–5 seconds:
```text
https://<random-words>.trycloudflare.com
```
Extract with:
```bash
grep -o 'https://[-a-z0-9]*\.trycloudflare\.com' <tunnel-log-file>
```

---

### Priority 2: Zero-Install SSH Reverse Tunnels — Fallback
When downloading external binaries like `cloudflared` is restricted or slow, native OpenSSH (`/usr/bin/ssh`) can establish reverse tunnels without installing anything.

#### Provider A: `localhost.run`
```bash
ssh -o StrictHostKeyChecking=no -R 80:localhost:8080 nokey@localhost.run
```
- Outputs: `https://<id>.lhr.life`
- *Caveat:* Free anonymous sessions drop if idle for several minutes.

#### Provider B: `pinggy.io`
```bash
ssh -p 443 -o StrictHostKeyChecking=no -R0:localhost:8080 a.pinggy.io
```
- Outputs: `https://<id>.a.pinggy.link`

---

## 3. Verification Protocol for Agent & Mobile QA

Before providing the public URL to the user, the agent **must** perform these automated checks:

1. **Verify HTTP 200 on Catalog:**
   ```bash
   curl -s -o /dev/null -w "%{http_code}" https://<tunnel-domain>/api/catalog
   # Must return 200
   ```

2. **Verify HTTP 206 Partial Content Streaming:**
   Mobile audio playback requires HTTP `Range` request support:
   ```bash
   curl -i -H "Range: bytes=0-100" https://<tunnel-domain>/api/stories/<story-id>/audios/<ver>.wav
   # Must return HTTP 206 with Content-Range: bytes 0-100/<total>
   ```

3. **Verify Dev Admin Sandbox Route:**
   Confirm `/admin` renders and authentication works via `DEV_ADMIN_BYPASS=true`:
   ```bash
   curl -s -c /tmp/cookie.txt -X POST -H "Content-Type: application/json" -d '{"devBypass": true}' https://<tunnel-domain>/api/admin/login
   # Must return {"ok": true, "email": "..."}
   ```

---

## 4. Lifecycle Management & Cleanup

1. **Daemon Execution:** In Antigravity, always run the tunnel process with `IsDaemon: true` or record its PID so it runs concurrently without blocking other commands.
2. **Teardown When QA Finishes:**
   - Identify active tunnel process: `pkill -f cloudflared` or `pkill -f localhost.run`
   - In Antigravity: `manage_task` with `Action: "kill"` on the tunnel task ID.
3. **Security Safeguards:**
   - Never expose production databases or secrets.
   - Only tunnel when running in `development` mode (`DEV_ADMIN_BYPASS=true` for local test sandboxing).
