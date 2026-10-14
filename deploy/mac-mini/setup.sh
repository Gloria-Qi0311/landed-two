#!/bin/bash
# Install or update Landed on this Mac (the Mac mini that serves it). Safe to
# run again: it only adds what's missing, rebuilds, and restarts.
#
#   1. Postgres 17, Node and pnpm from Homebrew; database "landed"
#   2. apps/server/.env (created once: a fresh SECRETS_KEY, Secure cookies,
#      sign-up for the first account only); PUBLIC_URL=… updates it
#   3. dependencies + builds: the web app, Landed for Mac (the download)
#   4. launchd: the API server (starts at login, restarts if it stops) and a
#      nightly database backup (~/Landed-backups, 14 days kept)
#   5. a health check
#
# LaunchAgents run while this user is logged in: turn on automatic login and
# turn off sleep on the Mac mini. The public address (Cloudflare Tunnel or
# Tailscale Funnel) is set up separately: deploy/mac-mini/tunnel.sh.
set -euo pipefail
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ENV_HINTS=1
cd "$(dirname "$0")/../.."
ROOT="$PWD"
LOGS="$HOME/Library/Logs/Landed"
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$LOGS" "$AGENTS"

# Non-interactive SSH sessions don't load the shell profile.
for brew in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "$brew" ] && eval "$("$brew" shellenv)" && break
done
command -v brew >/dev/null || { echo "Homebrew is missing — install it from https://brew.sh first." >&2; exit 1; }

step() { printf '\n== %s\n' "$1"; }

step "packages"
brew list --formula postgresql@17 >/dev/null 2>&1 || brew install postgresql@17
# Node and pnpm may already be here some other way (e.g. pnpm through npm).
command -v node >/dev/null || brew install node
command -v pnpm >/dev/null || brew install pnpm
PG="$(brew --prefix postgresql@17)/bin"
export PATH="$PG:$PATH"
brew services list | grep -q '^postgresql@17 *started' || brew services start postgresql@17
for _ in $(seq 1 30); do pg_isready -q && break; sleep 1; done
psql -lqt | cut -d'|' -f1 | grep -qw landed || createdb landed

step "config"
ENV="apps/server/.env"
if [ ! -f "$ENV" ]; then
  umask 077
  cat > "$ENV" <<CONF
DATABASE_URL=postgres://localhost:5432/landed
SECRETS_KEY=$(openssl rand -base64 32)
HOST=127.0.0.1
PORT=8787
COOKIE_SECURE=true
SIGNUP=first-only
CONF
  echo "created $ENV"
fi
chmod 600 "$ENV"
if [ -n "${PUBLIC_URL:-}" ]; then
  grep -v '^PUBLIC_URL=' "$ENV" > "$ENV.tmp" && echo "PUBLIC_URL=$PUBLIC_URL" >> "$ENV.tmp" && mv "$ENV.tmp" "$ENV" && chmod 600 "$ENV"
  echo "PUBLIC_URL=$PUBLIC_URL"
fi

step "build"
pnpm install --frozen-lockfile
pnpm --filter @landed/web build
pnpm --filter @landed/daemon build:mac

step "services"
NODE="$(brew --prefix)/bin/node"
SERVICE_PATH="$(brew --prefix)/bin:$PG:/usr/bin:/bin:/usr/sbin:/sbin"
write_agent() { # label, program arguments (xml), extra keys (xml)
  cat > "$AGENTS/$1.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>$2</array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$SERVICE_PATH</string></dict>
  <key>StandardOutPath</key><string>$LOGS/$1.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$1.log</string>
  $3
</dict>
</plist>
PLIST
}
reload() {
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  for _ in $(seq 1 30); do launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1 || break; sleep 0.2; done
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$1.plist"
}
write_agent dev.landed.server \
  "<string>$NODE</string><string>--env-file=$ROOT/apps/server/.env</string><string>$ROOT/apps/server/src/index.ts</string>" \
  "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>"
write_agent dev.landed.backup \
  "<string>/bin/bash</string><string>$ROOT/deploy/mac-mini/backup.sh</string>" \
  "<key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>"
reload dev.landed.server
reload dev.landed.backup

step "health"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
    echo "Landed is up on http://127.0.0.1:8787 (logs: $LOGS/dev.landed.server.log)"
    exit 0
  fi
  sleep 1
done
echo "The server didn't come up — see $LOGS/dev.landed.server.log" >&2
tail -20 "$LOGS/dev.landed.server.log" >&2 || true
exit 1
