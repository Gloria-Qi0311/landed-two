#!/bin/bash
# Nightly (launchd dev.landed.backup): dump the database, keep 14 days.
# Restore: pg_restore --clean --if-exists -d landed <file>
set -euo pipefail
for brew in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "$brew" ] && eval "$("$brew" shellenv)" && break
done
export PATH="$(brew --prefix postgresql@17)/bin:$PATH"
DIR="$HOME/Landed-backups"
mkdir -p "$DIR" && chmod 700 "$DIR"
FILE="$DIR/landed-$(date +%Y%m%d-%H%M).dump"
pg_dump -Fc landed > "$FILE"
chmod 600 "$FILE"
find "$DIR" -name 'landed-*.dump' -mtime +14 -delete
echo "$(date) backed up to $FILE ($(du -h "$FILE" | cut -f1))"
