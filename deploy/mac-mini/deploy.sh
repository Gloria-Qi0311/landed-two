#!/bin/sh
# Ship the current commit to the Mac mini and (re)deploy it there — run on
# your own computer, from the repo. No GitHub in between: the commit is
# pushed straight to a repo on the mini over SSH, then setup.sh runs there.
#
#   deploy/mac-mini/deploy.sh                       # yuanchenjie@antaresmac-mini
#   PUBLIC_URL=https://landed.example.com deploy/mac-mini/deploy.sh
#   deploy/mac-mini/deploy.sh other-user@other-host
#
# Needs: SSH key access (ssh-copy-id <host> once), a clean working tree.
set -eu
HOST="${1:-${LANDED_DEPLOY_HOST:-yuanchenjie@antaresmac-mini}}"
DIR="${LANDED_REMOTE_DIR:-landed}"
cd "$(git rev-parse --show-toplevel)"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ -n "$(git status --porcelain)" ]; then
  echo "Commit your changes first — a deploy ships a commit, not the working tree." >&2
  exit 1
fi

echo "→ $HOST:~/$DIR ($BRANCH @ $(git rev-parse --short HEAD))"
# A plain repo on the mini whose checked-out branch accepts pushes.
ssh "$HOST" "mkdir -p '$DIR' && cd '$DIR' && { git rev-parse --git-dir >/dev/null 2>&1 || git init -q; } && git config receive.denyCurrentBranch updateInstead"
git push --force "$HOST:$DIR" "HEAD:refs/heads/$BRANCH"
ssh "$HOST" "cd '$DIR' && git checkout -q '$BRANCH' && git reset -q --hard '$BRANCH' && PUBLIC_URL='${PUBLIC_URL:-}' /bin/bash deploy/mac-mini/setup.sh"
