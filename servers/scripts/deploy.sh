#!/bin/bash
# deploy.sh — push this repo's server code to the local runtime at
# ~/.google-multi-mcp/server without disturbing what only lives there.
#
# Never --delete: the runtime has its own node_modules, lockfile and extra
# folders (chief-of-staff-agent/). start.sh/start.cmd live one level up.
# After deploying, quit and reopen the Claude clients — killing the server
# process makes Cowork treat it as permanently dead.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$HOME/.google-multi-mcp/server"
VERSION=$(node -p "require('$SRC/package.json').version")
BACKUP="$HOME/.google-multi-mcp/server-backup-pre-v${VERSION}-$(date +%Y-%m-%d)"

[ -d "$DEST" ] || { echo "No runtime at $DEST. Run /setup first." >&2; exit 1; }
[ -e "$BACKUP" ] || cp -R "$DEST" "$BACKUP"

rsync -a \
  --exclude node_modules --exclude package-lock.json --exclude test \
  --exclude start.sh --exclude start.cmd --exclude '*.tmp.mjs' \
  "$SRC/" "$DEST/"

(cd "$DEST" && node -e 'import("./gmail-tools.js").then(() => console.log("imports ok"))')
echo "Deployed v${VERSION} to $DEST (backup: $BACKUP). Restart Claude to load it."
