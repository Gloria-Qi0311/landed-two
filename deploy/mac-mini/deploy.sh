#!/bin/sh
# Ship main to the Mac mini and (re)deploy it there — run on your own
# computer, from a clean checkout of main that matches GitHub's. The commit
# is pushed straight to a repo on the mini over SSH, then setup.sh runs there.
#
#   deploy/mac-mini/deploy.sh                       # antaresyuan@antaresmac-mini
#   PUBLIC_URL=https://landed.example.com deploy/mac-mini/deploy.sh
#   deploy/mac-mini/deploy.sh other-user@other-host
#   deploy/mac-mini/deploy.sh --any-branch          # the current branch instead of main
#
# The push only fast-forwards: when the mini runs a commit this checkout
# doesn't contain, the deploy stops instead of overwriting it.
#
# Needs: SSH key access (ssh-copy-id <host> once), a clean working tree.
set -eu
ANY_BRANCH=""
if [ "${1:-}" = "--any-branch" ]; then
  ANY_BRANCH=1
  shift
fi
HOST="${1:-${LANDED_DEPLOY_HOST:-antaresyuan@antaresmac-mini}}"
DIR="${LANDED_REMOTE_DIR:-landed}"
cd "$(git rev-parse --show-toplevel)"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ -n "$(git status --porcelain)" ]; then
  echo "Commit your changes first — a deploy ships a commit, not the working tree." >&2
  exit 1
fi
if [ -z "$ANY_BRANCH" ]; then
  if [ "$BRANCH" != "main" ]; then
    echo "Deploys ship main, and this is $BRANCH. Merge it first, or pass --any-branch to deploy it anyway." >&2
    exit 1
  fi
  git fetch -q origin main
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    echo "This main isn't GitHub's main: pull to catch up, and get local commits in through a pull request." >&2
    exit 1
  fi
fi

# What the mini runs now must be part of this commit, so the push below is a
# fast-forward. A commit only the mini has means someone deployed something
# this checkout lacks: stop rather than drop it.
REMOTE_HEAD=$(ssh "$HOST" "cd '$DIR' 2>/dev/null && git rev-parse -q --verify 'refs/heads/$BRANCH^{commit}' || true")
if [ -n "$REMOTE_HEAD" ] && ! { git cat-file -e "$REMOTE_HEAD^{commit}" 2>/dev/null && git merge-base --is-ancestor "$REMOTE_HEAD" HEAD; }; then
  echo "The mini's $BRANCH is at $REMOTE_HEAD, which this checkout doesn't contain. Get that commit into $BRANCH first; the deploy won't overwrite it." >&2
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
git push "$HOST:$DIR" "HEAD:refs/heads/$BRANCH"
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
