---
name: google-setup
description: >
  This skill provides guidance for setting up the Google Multi-Account MCP plugin.
  Use when the user says "set up google accounts", "connect my gmail", "add a google account",
  "configure email", "google MCP setup", "connect my calendar", or asks about
  authenticating Google accounts with the plugin. Also trigger when the user encounters
  OAuth errors, token issues, or GCP configuration problems.
version: 0.2.0
---

# Google Multi-Account MCP — Setup & Troubleshooting

This plugin connects any number of Google accounts (Gmail + Calendar) to Claude via MCP.

## Architecture (v0.2.0)

All files live in `~/.google-multi-mcp/`:

```
~/.google-multi-mcp/
├── config.json          # Account config + OAuth tokens
├── start.sh             # Node auto-discovery launcher (called by Claude Desktop)
└── server/              # MCP server code
    ├── index.js          # Main server — registers tools dynamically
    ├── auth.js           # OAuth2 client manager
    ├── config.js         # Config file reader/writer
    ├── gmail.js          # Gmail API operations
    ├── calendar.js       # Calendar API operations
    ├── package.json
    ├── node_modules/
    └── scripts/
        └── setup-tokens.js  # Interactive OAuth setup
```

Claude Desktop config at `~/Library/Application Support/Claude/claude_desktop_config.json`
points to `/bin/bash ~/.google-multi-mcp/start.sh` which finds node and launches the server.

## Quick Setup

Run `/setup` for the fully guided experience. Or manually:

```bash
# 1. Copy files (if not already installed)
mkdir -p ~/.google-multi-mcp/server/scripts
# ... copy server files to ~/.google-multi-mcp/server/

# 2. Install dependencies
cd ~/.google-multi-mcp/server && npm install

# 3. Run OAuth setup
cd ~/.google-multi-mcp/server && node scripts/setup-tokens.js

# 4. Register in Claude Desktop config (see setup command for exact JSON)

# 5. Restart Claude (Cmd+Q → reopen)
```

## How It Works

- Each account gets a custom label (e.g., "personal", "work", "client-acme")
- Credentials and tokens stored in `~/.google-multi-mcp/config.json`
- The MCP server dynamically builds Zod enum schemas from configured account labels
- Use `"all"` as the account parameter to search/list across every account
- `start.sh` sources NVM/volta/fnm/asdf before finding node — solves PATH issues

## Health Check

Run these to diagnose issues:

```bash
# 1. Can node start the server?
cd ~/.google-multi-mcp/server && node -e "console.log('node OK')"

# 2. Does the server start?
cd ~/.google-multi-mcp/server && timeout 3 node index.js 2>&1; echo "exit: $?"

# 3. Does start.sh find node?
bash ~/.google-multi-mcp/start.sh 2>&1 & sleep 2; kill %1 2>/dev/null

# 4. Is it registered in desktop config?
cat ~/Library/Application\ Support/Claude/claude_desktop_config.json | grep google-multi

# 5. What do the MCP logs say?
grep -i "google-multi" ~/Library/Logs/Claude/mcp*.log | tail -20
```

## Common Issues

### Server disconnected / tools don't appear

**Cause 1: Node not found.** Cowork doesn't inherit NVM/shell profiles.
**Fix:** Ensure `start.sh` is at `~/.google-multi-mcp/start.sh` and the desktop config uses
`/bin/bash` as the command with the absolute path to start.sh as the arg.

**Cause 2: Missing node_modules.**
**Fix:** `cd ~/.google-multi-mcp/server && npm install`

**Cause 3: Server crashes on startup.**
**Fix:** Check `~/Library/Logs/Claude/mcp*.log`. The v0.2.0 server should never crash on
missing config — it starts with zero tools instead. If it IS crashing, update index.js.

**Cause 4: Desktop config not updated.**
**Fix:** Ensure `~/Library/Application Support/Claude/claude_desktop_config.json` has
the `mcpServers.google-multi` entry.

### "This app isn't verified" in browser

Expected for GCP projects in testing mode. Click Advanced → Go to [app name] (unsafe).

### Token Refresh Failures / Auth Errors

Re-run the setup script and re-authenticate the failing account:
```bash
cd ~/.google-multi-mcp/server && node scripts/setup-tokens.js
```

### Tools appear but API calls fail

Check that the GCP project has both Gmail API and Calendar API enabled.
Check that the account email is listed as a test user in the OAuth consent screen.

## Platform Notes

- **macOS only** for now (Claude Desktop config paths are macOS-specific)
- Requires Node.js 18+
- OAuth tokens are offline refresh tokens — they persist until revoked
- The server registers 11 tools when accounts are configured, 0 when unconfigured

## Reference

See `references/gcp-walkthrough.md` for detailed GCP console instructions.
