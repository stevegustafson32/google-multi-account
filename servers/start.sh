#!/bin/bash
# start.sh — Find node and launch the Google Multi-Account MCP server
#
# Why this exists: Claude Desktop / Cowork doesn't inherit shell profiles,
# so NVM/volta/fnm-managed node binaries aren't on PATH. This script
# sources common version managers before looking for node.
#
# The desktop config calls: /bin/bash ~/.google-multi-mcp/start.sh
# which always works because /bin/bash is a fixed system path.

set -euo pipefail

# ── Source Node Version Managers ──────────────────────────────────

# NVM (most common)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  source "$NVM_DIR/nvm.sh" 2>/dev/null
fi

# Volta
if [ -d "$HOME/.volta/bin" ]; then
  export PATH="$HOME/.volta/bin:$PATH"
fi

# fnm
if command -v fnm &>/dev/null; then
  eval "$(fnm env 2>/dev/null)" 2>/dev/null || true
elif [ -d "$HOME/.fnm" ]; then
  export PATH="$HOME/.fnm:$PATH"
  eval "$(fnm env 2>/dev/null)" 2>/dev/null || true
fi

# asdf
if [ -s "$HOME/.asdf/asdf.sh" ]; then
  source "$HOME/.asdf/asdf.sh" 2>/dev/null
fi

# Homebrew paths (macOS)
[ -d "/opt/homebrew/bin" ] && export PATH="/opt/homebrew/bin:$PATH"
[ -d "/usr/local/bin" ] && export PATH="/usr/local/bin:$PATH"

# ── Find Node ─────────────────────────────────────────────────────

NODE_BIN=$(command -v node 2>/dev/null || true)

if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found after sourcing NVM, volta, fnm, asdf, and homebrew." >&2
  echo "Install Node.js 18+ or set NVM_DIR to your NVM installation." >&2
  echo "Checked paths: $PATH" >&2
  # Don't exit — let the MCP framework see the error in stderr
  exit 1
fi

NODE_VERSION=$("$NODE_BIN" -v 2>/dev/null || echo "unknown")
MAJOR_VERSION=$(echo "$NODE_VERSION" | sed 's/v\([0-9]*\).*/\1/')

if [ "$MAJOR_VERSION" -lt 18 ] 2>/dev/null; then
  echo "WARNING: Node.js $NODE_VERSION detected. Version 18+ is required." >&2
fi

# ── Launch Server ─────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/server"

if [ ! -f "$SERVER_DIR/index.js" ]; then
  echo "ERROR: Server not found at $SERVER_DIR/index.js" >&2
  echo "Run the setup command in Claude to install the server." >&2
  exit 1
fi

if [ ! -d "$SERVER_DIR/node_modules" ]; then
  echo "ERROR: Dependencies not installed. Run: cd $SERVER_DIR && npm install" >&2
  exit 1
fi

exec "$NODE_BIN" "$SERVER_DIR/index.js"
