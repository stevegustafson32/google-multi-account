---
description: Add another Google account to the Multi-Account MCP
allowed-tools: Read, Bash
---

# Add Another Google Account

Help the user add another Google account to their existing setup.

## Pre-flight

Check current config:
```bash
cat ~/.google-multi-mcp/config.json 2>/dev/null
```

Show the currently configured accounts and their labels.

## Important Reminders

- The new account's email MUST be added as a test user in the GCP OAuth consent screen
  before authenticating. Remind the user to do this at https://console.cloud.google.com
  (Google Auth Platform → Audience → Add test user).
- Each account needs a unique label (e.g., "client-acme", "side-project").

## Add the Account

Tell the user to run:
```bash
cd ~/.google-multi-mcp/server && node scripts/setup-tokens.js
```

Or if node isn't on PATH:
```bash
source ~/.nvm/nvm.sh && cd ~/.google-multi-mcp/server && node scripts/setup-tokens.js
```

The script detects existing accounts and offers to add more.

## After Adding

The user MUST fully restart Claude (Cmd+Q and reopen) for the new account to appear
in the tool schemas. The MCP server builds its tool definitions at startup from the config file.
