# Google Multi-Account MCP (v0.3.0)

Connect any number of Google accounts (Gmail + Calendar + Drive) to Claude. Search, send, draft, and manage emails with attachments; manage calendar events; upload, download, search, and share Drive files — all with an `account` parameter that routes to the right identity.

The `account` parameter is the whole point. Claude's built-in Google connectors bind to a single identity, so a folder in a personal Drive is invisible to a work login and a file lands in whichever Drive the connector happens to hold. Here you name the account per call.

## What It Does

- **Email**: Search, read threads, send, draft, label — across one or all accounts
- **Attachments**: Send files with any email or draft; list and download attachments off received mail
- **Drive**: Search, list folders, upload, download, create folders, inspect, share — per account
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
    ├── scopes.js          # Single source of truth for OAuth scopes
    ├── gmail.js           # Gmail API operations (incl. attachments)
    ├── mime.js            # RFC 5322 message builder for send/draft
    ├── calendar.js        # Calendar API operations
    ├── drive.js           # Drive API operations
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
| `send_email` | Send from any connected account, with attachments |
| `create_email_draft` | Create a draft (doesn't send), with attachments |
| `list_attachments` | List files attached to a message |
| `download_attachment` | Save an attachment to disk |
| `list_email_labels` | List Gmail labels/folders |
| `label_email` | Add/remove labels from messages |
| `list_calendar_events` | List events from one or all calendars |
| `create_calendar_event` | Create events with optional Google Meet |
| `update_calendar_event` | Update existing events |
| `delete_calendar_event` | Delete events |
| `find_free_time` | Find free slots across ALL calendars |
| `drive_search` | Search one account's Drive by name, full text, folder, or raw query |
| `drive_list_folder` | List everything in a Drive folder |
| `drive_upload` | Upload a local file, optionally converting to Docs/Sheets/Slides |
| `drive_download` | Download a file; Google-native types export to .docx/.xlsx/.pptx |
| `drive_create_folder` | Create a folder |
| `drive_file_info` | Metadata and current sharing permissions |
| `drive_share` | Grant access to a person or make a link-accessible file |

Every Drive tool takes an ID **or a pasted Drive URL** — a folder link copied from the browser works as-is.

### Attachments

```
send_email     account="personal" to="…" subject="…" body="…"
               attachments=["~/Downloads/report.pdf", "/tmp/data.csv"]
```

Paths are local and may use `~`. Content types are detected from the extension.
Total payload is capped at 20MB — past that, `drive_upload` the file and send the link.

Reading works the other way: `get_email_thread` now reports an `attachments` array per
message, and `download_attachment` takes either the `attachmentId` from that list or just
the `filename`.

## Configuration

All config is stored in `~/.google-multi-mcp/config.json`:

```json
{
  "clientId": "your-client-id.apps.googleusercontent.com",
  "clientSecret": "GOCSPX-...",
  "accounts": [
    { "label": "personal", "email": "you@gmail.com", "refreshToken": "...", "scopeVersion": 2 },
    { "label": "work", "email": "you@company.com", "refreshToken": "...", "scopeVersion": 2 }
  ],
  "driveScope": "full"
}
```

`scopeVersion` records which scope set each token was consented under, so the server can
warn when a token predates Drive instead of failing with a bare `Insufficient Permission`.

`driveScope` is optional and defaults to `full`:

| Value | Scope | Trade-off |
|-------|-------|-----------|
| `full` (default) | `auth/drive` | Read/write the whole Drive. Required to write into a folder you created by hand or to search existing files. A Google *restricted* scope — fine for personal use and Testing-mode apps; a published app carries annual security review. |
| `file` | `auth/drive.file` | No verification burden, but the plugin only sees files it created itself. Search across an existing Drive won't work. |

Changing it requires fresh consent: `npm run setup -- --reauth`.

Add more accounts anytime by running `/add-account` or re-running the setup script.

## Commands

| Command | Description |
|---------|-------------|
| `/setup` | Guided first-time setup (handles everything) |
| `/add-account` | Add another Google account |

## Upgrading to v0.3.0

Drive needs a scope your existing tokens were never consented for. Re-authorize once:

```bash
cd ~/.google-multi-mcp/server && npm run setup -- --reauth
```

That walks every configured account through Google's consent screen again — approve the
Drive permission on each. Then restart Claude (Cmd+Q → reopen). Gmail and Calendar keep
working throughout; only the Drive tools fail (`Insufficient Permission`) until you do this.

The GCP project also needs the **Google Drive API** enabled. If re-auth succeeds but Drive
calls return `has not been used in project … or it is disabled`, enable it in the console
for the project that owns your OAuth client, then retry.

## v0.3.0 Changelog

- **Drive tools** — search, list, upload, download, create folder, file info, share. Per account.
- **Email attachments both ways** — send/draft with local files (multipart MIME, 20MB cap);
  `get_email_thread` surfaces an `attachments` array; `list_attachments` / `download_attachment`
  pull files off received mail.
- **URL-or-ID everywhere** — Drive file and folder parameters accept a pasted browser URL.
- **Scopes centralized** — `scopes.js` is the single source; `auth.js` and the setup script
  both import it. They used to be duplicated, so a scope added in one place was never consented
  in the other.
- **`--reauth` flag** — re-consents every configured account in one pass after a scope change.
- **Stale-token warning** — the server logs which accounts predate the Drive scope at startup.
- **RFC 2047 subject encoding** — accented and non-Latin subject lines no longer mangle.
- **Shared drive support** — Drive calls set `supportsAllDrives`, so Workspace shared drives resolve.

## v0.2.0 Changelog

Hardened based on 6 rounds of real-world Cowork debugging:

- **`start.sh` wrapper** — Auto-discovers node from NVM/volta/fnm/asdf/homebrew. Eliminates the #1 failure mode (Cowork can't find node via version managers).
- **Graceful startup** — Server never crashes on missing config. Starts with zero tools instead of `process.exit(1)`, which Cowork treats as permanently dead.
- **Clean install path** — `~/.google-multi-mcp/` instead of relying on plugin directory extraction (unreliable in Cowork).
- **Desktop config registration** — Setup command writes to `claude_desktop_config.json` directly. Cowork ignores plugin `.mcp.json` files.
- **Health checks** — Setup command runs full diagnostics before and after installation.
- **Battle-tested setup flow** — Every step validated through production debugging.

## Security

- Tokens are per-account and stored locally; no credential ever passes through Claude's context
- `drive_share` changes who can see your data and is never called implicitly — confirm before granting access
- Tokens stored locally in `~/.google-multi-mcp/config.json` (mode 0600)
- The plugin never phones home or shares data

## License

MIT
