#!/bin/bash
# Give Landed on this Mac a public https address — run on the Mac mini,
# after setup.sh. Either:
#
#   tunnel.sh cloudflare landed.example.com
#       Cloudflare Tunnel on your own domain (the domain's DNS must be on
#       Cloudflare). The first time, `cloudflared tunnel login` prints a link:
#       open it in any browser, pick the domain, approve.
#   tunnel.sh funnel
#       Tailscale Funnel: https://<this-mac>.<tailnet>.ts.net, no domain
#       needed. The first time, Tailscale may print a link to allow Funnel
#       for your tailnet.
#
# Then set PUBLIC_URL to that address (deploy.sh does it on the next deploy:
# PUBLIC_URL=https://… deploy/mac-mini/deploy.sh).
set -euo pipefail
for brew in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "$brew" ] && eval "$("$brew" shellenv)" && break
done
MODE="${1:-}"
LOGS="$HOME/Library/Logs/Landed"
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$LOGS" "$AGENTS"

case "$MODE" in
  cloudflare)
    HOSTNAME="${2:?usage: tunnel.sh cloudflare <hostname>}"
    brew list --formula cloudflared >/dev/null 2>&1 || brew install cloudflared
    [ -f "$HOME/.cloudflared/cert.pem" ] || cloudflared tunnel login
    cloudflared tunnel info landed >/dev/null 2>&1 || cloudflared tunnel create landed
    ID="$(cloudflared tunnel list --name landed --output json | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')"
    cloudflared tunnel route dns --overwrite-dns landed "$HOSTNAME"
    cat > "$HOME/.cloudflared/landed.yml" <<CONF
tunnel: $ID
credentials-file: $HOME/.cloudflared/$ID.json
ingress:
  - hostname: $HOSTNAME
    service: http://127.0.0.1:8787
  - service: http_status:404
CONF
    cat > "$AGENTS/dev.landed.tunnel.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.landed.tunnel</string>
  <key>ProgramArguments</key><array>
    <string>$(brew --prefix)/bin/cloudflared</string><string>tunnel</string><string>--no-autoupdate</string>
    <string>--config</string><string>$HOME/.cloudflared/landed.yml</string><string>run</string><string>landed</string>
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/dev.landed.tunnel.log</string>
  <key>StandardErrorPath</key><string>$LOGS/dev.landed.tunnel.log</string>
</dict>
</plist>
PLIST
    launchctl bootout "gui/$(id -u)/dev.landed.tunnel" 2>/dev/null || true
    sleep 1
    launchctl bootstrap "gui/$(id -u)" "$AGENTS/dev.landed.tunnel.plist"
    echo "Tunnel up: https://$HOSTNAME → http://127.0.0.1:8787 (logs: $LOGS/dev.landed.tunnel.log)"
    ;;
  funnel)
    TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
    "$TS" funnel --bg 8787
    "$TS" funnel status
    ;;
  *)
    echo "usage: tunnel.sh cloudflare <hostname> | tunnel.sh funnel" >&2
    exit 1
    ;;
esac
