# Google Multi-Account MCP (v0.2.0)

Connect any number of Google accounts (Gmail + Calendar) to Claude. Search, send, draft, and manage emails plus calendar events — all with an `account` parameter that routes to the right inbox or calendar.

## What It Does

- **Email**: Search, read threads, send, draft, label — across one or all accounts
- **Calendar**: List events, create/update/delete events, find free time across all calendars
- **Multi-account**: Configure as many Google accounts as you need, each with a custom label
- **Cross-account search**: Use `account: "all"` to search email or calendar across every connected account
- **Free time finder**: Merges all calendars to show when you're truly available

## Setup

### Prerequisites

- macOS (Claude Desktop / Cowork)
- Node.js 18+ (NVM, volta, homebrew, or system install all work)
- A Google Cloud Platform project with Gmail API + Calendar API enabled

### Quick Start

1. Install the plugin in Claude
2. Run `/setup` for the fully guided experience — it handles everything:
   - Copies server files to `~/.google-multi-mcp/`
   - Installs npm dependencies
   - Walks through GCP project setup
   - Runs OAuth authentication for each account
   - Registers MCP server in Claude Desktop config
3. Restart Claude (Cmd+Q → reopen)

### Architecture

```
~/.google-multi-mcp/
├── config.json          # Your accounts + OAuth credentials (local only)
├── start.sh             # Node auto-discovery launcher
└── server/
    ├── index.js          # MCP server — dynamically registers tools from config
    ├── auth.js           # OAuth2 client manager (one per account)
    ├── config.js         # Config file reader/writer
    ├── gmail.js          # Gmail API operations
    ├── calendar.js       # Calendar API operations
    ├── package.json
    └── scripts/
        └── setup-tokens.js  # Interactive OAuth setup script
```

The Claude Desktop config calls `/bin/bash ~/.google-multi-mcp/start.sh` which auto-discovers node (NVM, volta, fnm, asdf, homebrew) and launches the server.

### GCP Project Setup

You'll need a GCP project with:
- Gmail API and Google Calendar API enabled
- OAuth 2.0 client (Web application type)
- Redirect URI: `http://localhost:3847/oauth/callback`
- Test users added for each Google account you want to connect

See the `/setup` command or `skills/google-setup/references/gcp-walkthrough.md` for detailed instructions.

## Tools

| Tool | Description |
|------|-------------|
| `search_emails` | Search emails across one or all accounts |
| `get_email_thread` | Read a full email thread |
| `send_email` | Send from any connected account |
| `create_email_draft` | Create a draft (doesn't send) |
| `list_email_labels` | List Gmail labels/folders |
| `label_email` | Add/remove labels from messages |
| `list_calendar_events` | List events from one or all calendars |
| `create_calendar_event` | Create events with optional Google Meet |
| `update_calendar_event` | Update existing events |
| `delete_calendar_event` | Delete events |
| `find_free_time` | Find free slots across ALL calendars |

## Configuration

All config is stored in `~/.google-multi-mcp/config.json`:

```json
{
  "clientId": "your-client-id.apps.googleusercontent.com",
  "clientSecret": "GOCSPX-...",
  "accounts": [
    { "label": "personal", "email": "you@gmail.com", "refreshToken": "..." },
    { "label": "work", "email": "you@company.com", "refreshToken": "..." }
  ]
}
```

Add more accounts anytime by running `/add-account` or re-running the setup script.

## Commands

| Command | Description |
|---------|-------------|
| `/setup` | Guided first-time setup (handles everything) |
| `/add-account` | Add another Google account |

## v0.2.0 Changelog

Hardened based on 6 rounds of real-world Cowork debugging:

- **`start.sh` wrapper** — Auto-discovers node from NVM/volta/fnm/asdf/homebrew. Eliminates the #1 failure mode (Cowork can't find node via version managers).
- **Graceful startup** — Server never crashes on missing config. Starts with zero tools instead of `process.exit(1)`, which Cowork treats as permanently dead.
- **Clean install path** — `~/.google-multi-mcp/` instead of relying on plugin directory extraction (unreliable in Cowork).
- **Desktop config registration** — Setup command writes to `claude_desktop_config.json` directly. Cowork ignores plugin `.mcp.json` files.
- **Health checks** — Setup command runs full diagnostics before and after installation.
- **Battle-tested setup flow** — Every step validated through production debugging.

## Security

- No credentials ship with the plugin — each user creates their own GCP project
- Tokens stored locally in `~/.google-multi-mcp/config.json` (mode 0600)
- The plugin never phones home or shares data

## License

MIT
