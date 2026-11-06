#!/usr/bin/env bash
set -euo pipefail

# Storyteller Studio - Quick Mobile HTTPS Tunnel Helper
# Exposes local port 8080 over Cloudflare Quick Tunnels for mobile QA.

PORT="${PORT:-8080}"
BIN="/tmp/cloudflared"

if [ ! -f "$BIN" ]; then
  echo "==> Downloading cloudflared standalone binary..."
  curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o "$BIN"
  chmod +x "$BIN"
fi

echo "==> Starting Cloudflare Tunnel for http://127.0.0.1:${PORT}..."
echo "==> Look for your temporary https://*.trycloudflare.com URL below:"
echo "----------------------------------------------------------------"

exec "$BIN" tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate
