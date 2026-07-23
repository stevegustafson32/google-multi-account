---
description: Re-authorize your connected Google accounts (after a scope change or expired token)
allowed-tools: Read, Bash
---

# Google Multi-Account MCP — Re-authorize

Re-consent every configured Google account against the current scope list. Use this when:

- **Drive tools fail with `Insufficient Permission`** — the account's token was minted before
  Drive was added, and Google binds scopes to the refresh token at consent time.
- **Any tool returns a `reauth_command` hint** — the refresh token was revoked or expired.
- **`driveScope` changed** in `~/.google-multi-mcp/config.json` (`full` ⇄ `file`).
- The server logs `Drive scope not yet consented for: …` at startup.

Gmail and Calendar keep working the whole time. Only the newly-added scope is missing.

## Step 1: Confirm what needs it

```bash
node -e "const c=require(require('os').homedir()+'/.google-multi-mcp/config.json');for(const a of c.accounts){console.log(a.label,a.email,'scopeVersion:',a.scopeVersion??'(pre-Drive)')}"
```

Any account showing `(pre-Drive)` or a `scopeVersion` below 2 needs re-consent.

## Step 2: Run it

**macOS / Linux**
```bash
cd ~/.google-multi-mcp/server && npm run setup -- --reauth
```

**Windows (PowerShell)**
```powershell
cd $env:USERPROFILE\.google-multi-mcp\server ; npm run setup -- --reauth
```

If `npm` isn't found, the user is on a version manager Claude didn't inherit:
```bash
source ~/.nvm/nvm.sh && cd ~/.google-multi-mcp/server && npm run setup -- --reauth
```

This walks every configured account through Google's consent screen, one after another.
It does not ask any questions — it reuses the labels and emails already in the config.

## Step 3: Warn the user about the two screens they'll see

**This is the step people get stuck on. Tell them BEFORE the browser opens.**

**Screen 1 — "Google hasn't verified this app."** Red warning triangle, and a
**Back to safety** button that does *not* complete setup.

> This is expected. The plugin uses an OAuth client that hasn't been through Google's
> formal verification review — the same screen appears for any self-published app
> requesting Gmail or Drive access. Nothing is wrong.
>
> Click **Advanced** (bottom left), then **Go to google-multi-account (unsafe)**.

**Screen 2 — the permissions list, with a checkbox per scope.**

> **Check every box**, or click **Select all**.
>
> An unchecked box means that permission is silently missing from the new token. The
> most common outcome is Drive appearing to connect and then failing every call with
> `Insufficient Permission` — with no obvious cause.

Then the flow repeats for the next account. Same two screens each time.

## Step 4: Restart

> Fully quit Claude (Cmd+Q on macOS, or exit from the system tray on Windows) and reopen it.

## Step 5: Verify

Ask Claude to run `drive_search` with `nameContains` set to anything, on each account.
A result list (even an empty one) means the scope took. `Insufficient Permission` means a
checkbox was missed — re-run this command.

If the error is instead `Google Drive API has not been used in project … or it is disabled`,
the scope is fine but the Drive API is not enabled on the GCP project behind the OAuth
client. Enable it in the Cloud console, wait a minute, and retry — no re-auth needed.
