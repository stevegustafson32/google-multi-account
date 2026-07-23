---
description: Set up Google Multi-Account MCP — connect your Google accounts
allowed-tools: Read, Bash
---

# Google Multi-Account MCP — Automated Setup

Guide the user through setting up the Google Multi-Account MCP plugin. This command handles
everything: copying server files, installing dependencies, registering with Claude Desktop,
and authenticating Google accounts.

## CRITICAL: Pre-baked OAuth Credentials

This plugin ships with pre-baked OAuth credentials. Users do NOT need to create a GCP project,
enable APIs, or generate their own OAuth client. The setup-tokens.js script uses shared
credentials automatically.

**NEVER walk users through GCP project setup unless they explicitly ask to use their own credentials.**

## CRITICAL LESSONS (from real-world installation failures)

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

## Step 0: Detect the platform FIRST

Every path in this document differs by OS. Determine which one you're on before running
anything, and use only that column.

```bash
uname -s 2>/dev/null || echo "Windows"
```

| | macOS | Windows |
|---|---|---|
| Install dir | `~/.google-multi-mcp/` | `%USERPROFILE%\.google-multi-mcp\` |
| Launcher | `start.sh` | `start.cmd` |
| Desktop config | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` |
| MCP `command` | `/bin/bash` | `cmd` |
| MCP `args` | `["/Users/<you>/.google-multi-mcp/start.sh"]` | `["/c", "C:\\Users\\<you>\\.google-multi-mcp\\start.cmd"]` |

The plugin ships both launchers. There is no separate Windows build — an earlier
"windows" package existed and drifted three versions behind because it was a fork that
differed only in `.mcp.json`. Do not create one again.

## Step 0.5: Health Check

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

**Windows equivalent (PowerShell):**

```powershell
Test-Path $env:USERPROFILE\.google-multi-mcp\server\index.js
Test-Path $env:USERPROFILE\.google-multi-mcp\server\node_modules\@modelcontextprotocol
Get-Content $env:USERPROFILE\.google-multi-mcp\config.json -ErrorAction SilentlyContinue
Select-String -Path $env:APPDATA\Claude\claude_desktop_config.json -Pattern "google-multi"
Test-Path $env:USERPROFILE\.google-multi-mcp\start.cmd
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
  # Copy EVERY module — never enumerate filenames here. An earlier version of
  # this command listed files one by one and silently stopped copying new ones
  # (sanitize.js, drive.js, mime.js, scopes.js), producing an install that
  # crashed on import with "server disconnected".
  cp "$PLUGIN_SERVERS"/*.js ~/.google-multi-mcp/server/
  cp "$PLUGIN_SERVERS/package.json" ~/.google-multi-mcp/server/
  cp "$PLUGIN_SERVERS/package-lock.json" ~/.google-multi-mcp/server/ 2>/dev/null
  cp "$PLUGIN_SERVERS/scripts/"*.js ~/.google-multi-mcp/server/scripts/
fi

# Copy start.sh launcher
if [ -f "$PLUGIN_SERVERS/start.sh" ]; then
  cp "$PLUGIN_SERVERS/start.sh" ~/.google-multi-mcp/start.sh
  chmod +x ~/.google-multi-mcp/start.sh
fi

echo "Files installed to ~/.google-multi-mcp/"
ls -la ~/.google-multi-mcp/
ls -la ~/.google-multi-mcp/server/

# Every module index.js imports must be present or the server dies on startup.
for m in index auth config gmail calendar drive mime scopes sanitize; do
  [ -f ~/.google-multi-mcp/server/$m.js ] && echo "  ok   $m.js" || echo "  MISSING $m.js"
done
```

**Windows equivalent (PowerShell):**

```powershell
$install = "$env:USERPROFILE\.google-multi-mcp"
New-Item -ItemType Directory -Force -Path "$install\server\scripts" | Out-Null

$pluginServers = "$env:CLAUDE_PLUGIN_ROOT\servers"
if (Test-Path "$pluginServers\index.js") {
  # Copy every module — never enumerate filenames (see the note above).
  Copy-Item "$pluginServers\*.js" "$install\server\" -Force
  Copy-Item "$pluginServers\package.json" "$install\server\" -Force
  Copy-Item "$pluginServers\package-lock.json" "$install\server\" -Force -ErrorAction SilentlyContinue
  Copy-Item "$pluginServers\scripts\*.js" "$install\server\scripts\" -Force
  Copy-Item "$pluginServers\start.cmd" "$install\" -Force
}

foreach ($m in "index","auth","config","gmail","calendar","drive","mime","scopes","sanitize") {
  if (Test-Path "$install\server\$m.js") { "  ok   $m.js" } else { "  MISSING $m.js" }
}
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

**On Windows**, the equivalent entry is:
```json
{
  "mcpServers": {
    "google-multi": {
      "command": "cmd",
      "args": ["/c", "C:\\Users\\USERNAME\\.google-multi-mcp\\start.cmd"]
    }
  }
}
```
Backslashes must be escaped in JSON, and the path must be absolute — `%USERPROFILE%` is
not expanded by Claude Desktop. Get the real path with `echo $env:USERPROFILE`.

Registering `"command": "node"` directly works ONLY if node came from the official MSI and
is on the system PATH. With nvm-windows, volta, or fnm it fails exactly the way NVM does on
macOS — which is what `start.cmd` exists to solve.

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

## Step 4: Authenticate Accounts

**The plugin includes pre-baked OAuth credentials. Users do NOT need a GCP project.**

Tell the user to run:
```bash
cd ~/.google-multi-mcp/server && node scripts/setup-tokens.js
```

Or if node isn't on PATH:
```bash
source ~/.nvm/nvm.sh && cd ~/.google-multi-mcp/server && node scripts/setup-tokens.js
```

### Warn them about the two screens BEFORE the browser opens

This is where non-technical users abandon setup. Say this up front:

**Screen 1 — "Google hasn't verified this app."** Red triangle, prominent **Back to safety**
button that does not complete setup.

> Expected. The OAuth client hasn't been through Google's formal verification review, which
> is normal for a self-published plugin requesting Gmail and Drive access.
> Click **Advanced** at the bottom left, then **Go to google-multi-account (unsafe)**.

**Screen 2 — permissions, one checkbox per scope.**

> **Check every box** (or **Select all**). An unchecked box silently omits that permission
> from the token; the usual symptom is Drive connecting fine and then failing every call
> with `Insufficient Permission`.

This interactive script will:
- Use the built-in shared OAuth credentials automatically (no Client ID/Secret needed)
- Let them add accounts with custom labels (e.g., "personal", "work")
- Open browser for OAuth consent per account
- Store everything in `~/.google-multi-mcp/config.json`

**Expected browser flow:**
1. Google sign-in page opens
2. User signs in with their Gmail
3. "This app isn't verified" warning appears — click **Advanced → Go to app (unsafe)**
4. Grant permissions → success page appears → close the tab

Print which credentials are in use. If the script says "Using default shared credentials",
everything is working as expected.

**Only if the user explicitly asks to use their own GCP project**, point them to:
`~/.google-multi-mcp/server/scripts/setup-tokens.js --help` or the README for self-hosted
credential instructions.

## Step 5: Restart Claude

Tell the user:
> Fully quit Claude (Cmd+Q) and reopen it. The MCP server will connect automatically.

After restart, verify by asking Claude to list calendar events or search emails.

## Step 6: Post-Setup Verification

After the user restarts and comes back, verify the tools loaded:
- Try to use `search_emails` or `list_calendar_events` with `account: "all"`
- If tools aren't available, check `~/Library/Logs/Claude/mcp*.log`

Common post-setup issues:
- **"Server disconnected"**: Check logs. Usually a path issue or missing node_modules.
- **No tools showing**: Server started but config was empty. Verify config.json has accounts.
- **Auth errors on API calls**: Token expired. Re-run setup-tokens.js for that account.
