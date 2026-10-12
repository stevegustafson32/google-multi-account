# Google Multi-Account MCP (v0.7.0)

Connect any number of Google accounts (Gmail + Calendar + Drive) to Claude. Search, send, draft, and manage emails with attachments; manage calendar events; upload, download, search, and share Drive files — all with an `account` parameter that routes to the right identity.

The `account` parameter is the whole point. Claude's built-in Google connectors bind to a single identity, so a folder in a personal Drive is invisible to a work login and a file lands in whichever Drive the connector happens to hold. Here you name the account per call.

## What It Does

- **Email**: Search, read threads, send, draft, label — across one or all accounts
- **Attachments**: Send files with any email or draft; list and download attachments off received mail
- **Drive**: Search, list folders, upload, download, create folders, inspect, share — per account
- **Calendar**: List events, create/update/delete events, find free time across all calendars
- **Injection-hardened**: Email content is sanitized before it reaches the model; email headers are CRLF-guarded
- **Multi-account**: Configure as many Google accounts as you need, each with a custom label
- **Cross-account search**: Use `account: "all"` to search email or calendar across every connected account
- **Free time finder**: Merges all calendars to show when you're truly available

## Setup

### Prerequisites

- macOS or Windows (Claude Desktop / Cowork)
- Node.js 18+ (NVM/nvm-windows, volta, fnm, homebrew, or a system install all work)

You provide your own Google OAuth client (a 5-minute, one-time GCP setup — `/setup` walks you
through it). Nothing is pre-baked; your credentials live only in your local, gitignored config.
See [Security](SECURITY.md) for why.

### The consent screen — read this before you start

Two screens trip people up, in this order:

**1. "Google hasn't verified this app."** Red warning triangle and a **Back to safety**
button. This is expected: the OAuth client hasn't been through Google's formal verification
review, which is normal for a self-published plugin asking for Gmail and Drive access.
Click **Advanced** (bottom left) → **Go to google-multi-account (unsafe)**.

**2. The permissions list, with a checkbox per scope.** **Check every box**, or hit
**Select all**. An unchecked box is silently omitted from the token, and the usual symptom
is Drive connecting and then failing every call with `Insufficient Permission`.

Both screens repeat for each account you connect.

### Windows

One package covers both platforms — there is no separate Windows build. `start.cmd` ships
alongside `start.sh` and discovers node from PATH, volta, nvm-windows, fnm, or Program Files.

| | macOS | Windows |
|---|---|---|
| Install dir | `~/.google-multi-mcp/` | `%USERPROFILE%\.google-multi-mcp\` |
| Launcher | `start.sh` | `start.cmd` |
| Desktop config | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` |
| MCP entry | `"command": "/bin/bash"` | `"command": "cmd", "args": ["/c", "…\\start.cmd"]` |

Registering `"command": "node"` works on Windows only if node came from the official MSI
installer. With nvm-windows, volta, or fnm it fails the same way bare `node` fails under
NVM on macOS — which is the whole reason both launchers exist.

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
- OAuth 2.0 client, **Desktop app** type (no redirect URI to register; the setup
  script listens on `http://127.0.0.1:3847/oauth/callback`, loopback only, with PKCE)
- Consent screen published to **Production** (Testing mode expires refresh tokens every 7 days)
- Test users added for each Google account you want to connect

See the `/setup` command or `skills/google-setup/references/gcp-walkthrough.md` for detailed instructions.

## Tools

| Tool | Description |
|------|-------------|
| `search_emails` | Search emails across one or all accounts |
| `get_email_thread` | Read a thread (newest 10 messages by default, bodies capped) |
| `reply_to_email` | Reply inline in the thread: recipients, Re: subject, threading and quote filled in; drafts unless `send:true` |
| `send_email` | Send from any connected account, with attachments |
| `create_email_draft` | Create a draft of a NEW email (doesn't send), with attachments |
| `list_drafts` | List drafts with recipients, attachments, and whether each is threaded |
| `update_draft` | Revise a draft in place; carries over anything not passed, incl. attachments |
| `send_draft` | Send an existing draft exactly as built |
| `list_attachments` | List files attached to a message |
| `download_attachment` | Save one attachment to disk by `partId` (never overwrites) |
| `download_all_attachments` | Save every attachment on a message in one call |
| `get_attachment` | Return an attachment as base64 |
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
  "clientSecret": "GOCSPX-your-client-secret",
  "accounts": [
    { "label": "personal", "email": "you@gmail.com", "tokenStore": "keychain", "scopeVersion": 3 },
    { "label": "work", "email": "you@company.com", "tokenStore": "keychain", "scopeVersion": 3 }
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
| `/setup` | Guided first-time setup (handles everything, both platforms) |
| `/add-account` | Add another Google account |
| `/reauth` | Re-consent every account after a scope change or expired token |

Rotating a leaked/old client secret? Update it without re-consenting accounts:
`cd ~/.google-multi-mcp/server && npm run setup -- --credentials` (see [SECURITY.md](SECURITY.md)).

## Upgrading to v0.5.0

Drive needs a scope existing tokens were never consented for, and v0.4.0 added two
dependencies. Upgrade with:

```bash
cd ~/.google-multi-mcp/server && npm install
```

Then re-authorize once:

```bash
cd ~/.google-multi-mcp/server && npm run setup -- --reauth
```

That walks every configured account through Google's consent screen again — approve the
Drive permission on each. Then restart Claude (Cmd+Q → reopen). Gmail and Calendar keep
working throughout; only the Drive tools fail (`Insufficient Permission`) until you do this.

The GCP project also needs the **Google Drive API** enabled. If re-auth succeeds but Drive
calls return `has not been used in project … or it is disabled`, enable it in the console
for the project that owns your OAuth client, then retry.

## v0.7.0 Changelog — security

- **Removed the hard-coded OAuth client secret** (`servers/scripts/setup-tokens.js`). Google's
  scanner flagged it; see [SECURITY.md](SECURITY.md) for the incident and rotation runbook.
- **Bring-your-own credentials.** `/setup` prompts for a Client ID + Secret and stores them
  only in the local gitignored config. No credentials ship in the repo or package.
- **`npm run setup -- --credentials`** — replace credentials without re-consenting accounts
  (refresh tokens survive a secret rotation).
- Removed all "pre-baked OAuth / no GCP setup needed" claims from README, manifest, and `/setup`.

## v0.6.0 Changelog

- **Windows support that actually works.** `start.cmd` discovers node from PATH, volta,
  nvm-windows, fnm, and Program Files, mirroring `start.sh`. `/setup` is now platform-aware
  with PowerShell equivalents and the correct `%APPDATA%\Claude` config path.
- **One package, both platforms.** The old `google-multi-account-windows` zip differed from
  the macOS build in exactly one line of `.mcp.json` — and used `${HOME}`, which Windows
  doesn't define, so it was broken there anyway. It had drifted three versions behind. The
  fork is retired.
- **Cross-platform path bug fixed.** `process.env.HOME` is undefined on Windows, which broke
  `~` expansion and the default `~/Downloads` target in `drive_upload`, `drive_download`, and
  `download_attachment`. All now use `os.homedir()`.
- **`/reauth` command** — wraps `npm run setup -- --reauth` and documents the consent screens.
- **Consent screens documented** in the README and `/setup`, with the specific warning that an
  unchecked permission box produces a confusing `Insufficient Permission` later.
- **Distribution trade-offs documented** — shared OAuth client, the 100-user cap, and what
  the restricted Drive scope costs at verification time.

## v0.5.0 Changelog

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
- **`download_attachment`** — writes to disk and returns a path, instead of `get_attachment`
  pushing base64 through the conversation. Filenames are `basename`d so a hostile sender
  can't path-traverse out of the destination folder.
- **`/setup` copy list fixed** — it enumerated server modules by name and had already gone
  stale (`sanitize.js` was missing), so a fresh install crashed on import with
  "server disconnected". It now copies `*.js` and verifies every module landed.

## v0.4.0 Changelog

Shipped as a package but never committed to git; recovered and merged in v0.5.0.

- **`sanitize.js`** — untrusted email content is parsed, stripped, decoded, NFKC-normalized,
  and length-capped before reaching the model: script/style bodies, HTML entities that decode
  to live syntax, CSS-hidden text, zero-width and bidi characters, the Unicode Tags block
  used for invisible steganography, and homoglyph confusables. Output is wrapped in explicit
  untrusted-data delimiters.
- **CRLF header-injection guard** on every send/draft header field.
- **Correct reply threading** — `In-Reply-To`/`References` use the original RFC 5322
  `Message-ID` rather than Gmail's internal resource id.
- **Body extraction fixed** — prefers `text/plain` regardless of MIME tree order.
- **`withAuthErrorHandling`** — an expired refresh token returns a structured re-auth hint
  with the exact command instead of an opaque 401.
- **`replyToMessageId` on drafts**, `list_attachments`, `get_attachment`.

## v0.2.0 Changelog

Hardened based on 6 rounds of real-world Cowork debugging:

- **`start.sh` wrapper** — Auto-discovers node from NVM/volta/fnm/asdf/homebrew. Eliminates the #1 failure mode (Cowork can't find node via version managers).
- **Graceful startup** — Server never crashes on missing config. Starts with zero tools instead of `process.exit(1)`, which Cowork treats as permanently dead.
- **Clean install path** — `~/.google-multi-mcp/` instead of relying on plugin directory extraction (unreliable in Cowork).
- **Desktop config registration** — Setup command writes to `claude_desktop_config.json` directly. Cowork ignores plugin `.mcp.json` files.
- **Health checks** — Setup command runs full diagnostics before and after installation.
- **Battle-tested setup flow** — Every step validated through production debugging.

## Distribution

Each user brings their own OAuth client — the plugin ships **no** credentials. On first
`/setup` the user is prompted for a Client ID and Secret and pointed at
`skills/google-setup/references/gcp-walkthrough.md`. Their values are written only to their
local `~/.google-multi-mcp/config.json` (gitignored, mode `0600`).

This is deliberate: a shared client means shipping its secret in public source, which is
exactly what happened in the [2026-07-23 incident](SECURITY.md#incident--leaked-oauth-client-secret-2026-07-23).
Per-user clients keep each install on its own quota and its own consent, with nothing secret
in the repo or the package.

`driveScope: "full"` (`auth/drive`) is a Google *restricted* scope; a published, verified app
using it triggers an annual third-party security assessment. `driveScope: "file"` avoids
restricted scopes entirely, at the cost of only seeing files the plugin created.

## Security

- Tokens are per-account and stored locally; no credential ever passes through Claude's context
- `drive_share` changes who can see your data and is never called implicitly — confirm before granting access
- Tokens stored locally in `~/.google-multi-mcp/config.json` (mode 0600)
- The plugin never phones home or shares data

## License

MIT
