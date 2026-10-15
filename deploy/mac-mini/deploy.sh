#!/bin/sh
# Ship the current commit to the Mac mini and (re)deploy it there — run on
# your own computer, from the repo. No GitHub in between: the commit is
# pushed straight to a repo on the mini over SSH, then setup.sh runs there.
#
#   deploy/mac-mini/deploy.sh                       # antaresyuan@antaresmac-mini
#   PUBLIC_URL=https://landed.example.com deploy/mac-mini/deploy.sh
#   deploy/mac-mini/deploy.sh other-user@other-host
#
# Needs: SSH key access (ssh-copy-id <host> once), a clean working tree.
set -eu
HOST="${1:-${LANDED_DEPLOY_HOST:-antaresyuan@antaresmac-mini}}"
DIR="${LANDED_REMOTE_DIR:-landed}"
cd "$(git rev-parse --show-toplevel)"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ -n "$(git status --porcelain)" ]; then
  echo "Commit your changes first — a deploy ships a commit, not the working tree." >&2
  exit 1
fi

# Safari Web Extensions require full Xcode. Build the downloadable Mac app on
# this development Mac when available; the headless mini can still rebuild and
# restart the web/server pieces with Command Line Tools alone.
LOCAL_MAC_ZIP=""
if [ "$(uname -s)" = "Darwin" ] && [ -x /Applications/Xcode.app/Contents/Developer/usr/bin/safari-web-extension-converter ]; then
  echo "→ building the full Landed for Mac download (including Safari)"
  pnpm --filter @landed/daemon build:mac
  LOCAL_MAC_ZIP="$PWD/apps/daemon/dist/Landed-mac.zip"
fi

echo "→ $HOST:~/$DIR ($BRANCH @ $(git rev-parse --short HEAD))"
# A plain repo on the mini whose checked-out branch accepts pushes.
ssh "$HOST" "mkdir -p '$DIR' && cd '$DIR' && { git rev-parse --git-dir >/dev/null 2>&1 || git init -q; } && git config receive.denyCurrentBranch updateInstead"
git push --force "$HOST:$DIR" "HEAD:refs/heads/$BRANCH"
ssh "$HOST" "cd '$DIR' && git checkout -q '$BRANCH' && git reset -q --hard '$BRANCH' && PUBLIC_URL='${PUBLIC_URL:-}' /bin/bash deploy/mac-mini/setup.sh"
if [ -n "$LOCAL_MAC_ZIP" ]; then
  scp "$LOCAL_MAC_ZIP" "$HOST:$DIR/apps/daemon/dist/Landed-mac.zip"
  echo "→ uploaded the Safari-capable Landed for Mac download"
  # The signed update manifest goes last, so installed apps (src/updater.ts)
  # never see it before the zip it describes.
  if [ -f "${LOCAL_MAC_ZIP%.zip}.json" ]; then
    scp "${LOCAL_MAC_ZIP%.zip}.json" "$HOST:$DIR/apps/daemon/dist/Landed-mac.json"
    echo "→ published it as an update; installed apps pick it up within 6 hours"
  fi
fi
