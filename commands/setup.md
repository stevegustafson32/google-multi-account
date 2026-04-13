---
description: Set up Google Multi-Account MCP — connect your Google accounts
allowed-tools: Read, Bash
---

# Google Multi-Account MCP — Automated Setup

Guide the user through setting up the Google Multi-Account MCP plugin. This command handles
everything: copying server files, installing dependencies, registering with Claude Desktop,
and authenticating Google accounts.

## CRITICAL LESSONS (from real-world installation failures)

These are non-negotiable requirements learned from production debugging:

1. **Cowork IGNORES plugin `.mcp.json` files.** MCP servers MUST be registered in
   `~/Library/Application Support/Claude/claude_desktop_config.json` to connect.
2. **NVM/volta/fnm node is invisible to Cowork.** Never use bare `node` as the command.
   Use `/bin/bash` with the `start.sh` wrapper script that auto-discovers node.
3. **The MCP server must NEVER call `process.exit()` on config errors.** Cowork marks
   crashed servers as permanently dead and won't retry. The server starts with zero tools instead.
4. **Plugin zip extraction is unreliable.** Server files may not land in the plugin directory.
   Always copy server source to `~/.google-multi-mcp/server/` as the canonical location.
5. **Paths with spaces break things.** The plugin install path contains "Application Support"
   and deep UUID directories. Always use `~/.google-multi-mcp/` as the clean install target.

## Step 0: Health Check

Before doing anything, run diagnostics:

```bash
# Check if server files are already installed
ls ~/.google-multi-mcp/server/index.js 2>/dev/null && echo "SERVER: installed" || echo "SERVER: not installed"

# Check if node_modules exist
ls ~/.google-multi-mcp/server/node_modules/.package-lock.json 2>/dev/null && echo "DEPS: installed" || echo "DEPS: not installed"

# Check if config exists with accounts
cat ~/.google-multi-mcp/config.json 2>/dev/null || echo "CONFIG: not found"

# Check if registered in Claude Desktop config
cat ~/Library/Application\ Support/Claude/claude_desktop_config.json 2>/dev/null | grep -c "google-multi" && echo "REGISTERED: yes" || echo "REGISTERED: no"

# Check start.sh exists and is executable
ls -la ~/.google-multi-mcp/start.sh 2>/dev/null && echo "LAUNCHER: exists" || echo "LAUNCHER: not found"

# Check MCP logs for errors
tail -20 ~/Library/Logs/Claude/mcp*.log 2>/dev/null | grep -i "google-multi" || echo "LOGS: no google-multi entries"
```

Report the results to the user. If everything shows as installed/registered, ask if they want
to reconfigure or add accounts. If anything is missing, proceed with the relevant steps below.

## Step 1: Install Server Files

The server needs to live at `~/.google-multi-mcp/` — a clean path with no spaces.

Find the plugin's bundled server source. Check these locations in order:
1. `${CLAUDE_PLUGIN_ROOT}/servers/` (plugin directory)
2. If that's empty or doesn't exist, the server files need to be manually placed.

Generate and give the user this single command block:

```bash
# Create install directory
mkdir -p ~/.google-multi-mcp/server/scripts

# Copy server files from plugin (adjust source path if needed)
PLUGIN_SERVERS="${CLAUDE_PLUGIN_ROOT}/servers"

# If plugin source is available, copy from there
if [ -d "$PLUGIN_SERVERS" ] && [ -f "$PLUGIN_SERVERS/index.js" ]; then
  cp "$PLUGIN_SERVERS/index.js" ~/.google-multi-mcp/server/
  cp "$PLUGIN_SERVERS/auth.js" ~/.google-multi-mcp/server/
  cp "$PLUGIN_SERVERS/config.js" ~/.google-multi-mcp/server/
  cp "$PLUGIN_SERVERS/gmail.js" ~/.google-multi-mcp/server/
  cp "$PLUGIN_SERVERS/calendar.js" ~/.google-multi-mcp/server/
  cp "$PLUGIN_SERVERS/package.json" ~/.google-multi-mcp/server/
  cp "$PLUGIN_SERVERS/package-lock.json" ~/.google-multi-mcp/server/ 2>/dev/null
  cp "$PLUGIN_SERVERS/scripts/setup-tokens.js" ~/.google-multi-mcp/server/scripts/
fi

# Copy start.sh launcher
if [ -f "$PLUGIN_SERVERS/start.sh" ]; then
  cp "$PLUGIN_SERVERS/start.sh" ~/.google-multi-mcp/start.sh
  chmod +x ~/.google-multi-mcp/start.sh
fi

echo "Files installed to ~/.google-multi-mcp/"
ls -la ~/.google-multi-mcp/
ls -la ~/.google-multi-mcp/server/
```

**IMPORTANT:** If `${CLAUDE_PLUGIN_ROOT}` doesn't resolve or files aren't there (this is a known
Cowork issue), you need to find the actual plugin path first:

```bash
find ~/Library -type d -name "google-multi-account-inline" 2>/dev/null
```

Then substitute that path for `$PLUGIN_SERVERS` in the copy commands above.

**FALLBACK:** If the plugin directory is completely empty (known extraction bug), tell the user
they can get the server files from the GitHub repo or ask them to share the plugin source location.

## Step 2: Install Dependencies

```bash
cd ~/.google-multi-mcp/server && npm install
```

If `npm` is not found, the user likely uses NVM. Tell them to run:
```bash
source ~/.nvm/nvm.sh && cd ~/.google-multi-mcp/server && npm install
```

Verify:
```bash
ls ~/.google-multi-mcp/server/node_modules/@modelcontextprotocol 2>/dev/null && echo "OK" || echo "FAILED"
```

## Step 3: Register MCP Server in Claude Desktop Config

Read the current config:
```bash
cat ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

Parse the existing JSON. ADD the `mcpServers` key if it doesn't exist, or add `google-multi`
to it if other servers are already there. **Never overwrite existing mcpServers entries.**

The registration MUST use this exact pattern:
```json
{
  "mcpServers": {
    "google-multi": {
      "command": "/bin/bash",
      "args": ["/Users/USERNAME/.google-multi-mcp/start.sh"]
    }
  }
}
```

Key points:
- **command is `/bin/bash`** — NOT `node`, NOT a relative path. `/bin/bash` is a fixed system
  path that always exists on macOS. The `start.sh` script handles finding node.
- **args uses the absolute expanded home path** — NOT `~/.google-multi-mcp/start.sh`.
  Expand `~` to `/Users/USERNAME/` because Cowork doesn't expand tildes.

To get the username:
```bash
whoami
```

Generate the complete updated config JSON and give the user a single command to write it.
Use `cat > ... << 'EOF'` heredoc pattern.

## Step 4: Google Cloud Project Setup

Ask if the user already has a GCP project with Gmail and Calendar APIs enabled.

If NO, walk them through:
1. Go to https://console.cloud.google.com
2. Create a new project (e.g., "Claude Google MCP")
3. Enable Gmail API: APIs & Services → Library → search "Gmail API" → Enable
4. Enable Calendar API: APIs & Services → Library → search "Google Calendar API" → Enable
5. Configure OAuth consent screen:
   - Google Auth Platform → Branding (or APIs & Services → OAuth consent screen)
   - User Type: External
   - Fill in app name and email
   - Add scopes: `gmail.modify`, `gmail.compose`, `gmail.readonly`, `calendar`, `calendar.events`
   - Add test user emails (each Google account they want to connect)
6. Create OAuth client:
   - Google Auth Platform → Clients (or APIs & Services → Credentials)
   - Create OAuth client ID → Web application
   - Authorized redirect URI: `http://localhost:3847/oauth/callback`
   - Copy Client ID and Client Secret

Wait for the user to complete each sub-step before proceeding.

## Step 5: Authenticate Accounts

Tell the user to run:
```bash
cd ~/.google-multi-mcp/server && node scripts/setup-tokens.js
```

Or if node isn't on PATH:
```bash
source ~/.nvm/nvm.sh && cd ~/.google-multi-mcp/server && node scripts/setup-tokens.js
```

This interactive script will:
- Ask for Client ID and Client Secret
- Let them add accounts with custom labels (e.g., "personal", "work")
- Open browser for OAuth consent per account
- Store everything in `~/.google-multi-mcp/config.json`

## Step 6: Restart Claude

Tell the user:
> Fully quit Claude (Cmd+Q) and reopen it. The MCP server will connect automatically.

After restart, verify by asking Claude to list calendar events or search emails.

## Step 7: Post-Setup Verification

After the user restarts and comes back, verify the tools loaded:
- Try to use `search_emails` or `list_calendar_events` with `account: "all"`
- If tools aren't available, check `~/Library/Logs/Claude/mcp*.log`

Common post-setup issues:
- **"Server disconnected"**: Check logs. Usually a path issue or missing node_modules.
- **No tools showing**: Server started but config was empty. Verify config.json has accounts.
- **Auth errors on API calls**: Token expired. Re-run setup-tokens.js for that account.
