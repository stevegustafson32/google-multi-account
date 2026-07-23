# Security

## Credential model

This plugin uses a **bring-your-own OAuth client**. You create a Google OAuth client in
your own Cloud project and enter its ID and secret once during `/setup`. They are written
only to `~/.google-multi-mcp/config.json` (mode `0600`, gitignored) and never committed or
shipped. Account refresh tokens live in the same file. Nothing phones home.

Do not commit `config.json`. It is in `.gitignore`; keep it there.

## Incident — leaked OAuth client secret (2026-07-23)

**What happened.** A shared OAuth client secret was hard-coded into
`servers/scripts/setup-tokens.js` in commit `b0f0c4f` (2026-04-23) to let users skip
creating their own client. The repository is public, so the secret was exposed from that
date. Google's automated scanner flagged it on 2026-07-23:

> Secret for client `900207089503-…apps.googleusercontent.com` found at
> github.com/…/setup-tokens.js — generate a new secret.

**Blast radius.** The client secret alone cannot read anyone's Gmail or Drive — access
requires each user's own OAuth consent, and the resulting refresh token stays on their
machine. The real risk: anyone could stand up an app impersonating this one on Google's
consent screen, spending against project `900207089503`'s quota and its 100-user
unverified-app cap.

**Fix applied in code (v0.7.0).**
- The baked `DEFAULT_CLIENT_ID` / `DEFAULT_CLIENT_SECRET` are removed. `setup-tokens.js`
  now prompts for a client id + secret and stores them only in the local config.
- "Pre-baked OAuth / no GCP setup" claims removed from the README, manifest, and `/setup`.
- `npm run setup -- --credentials` added to replace credentials without re-consenting
  accounts (refresh tokens survive a secret rotation).

Removing the secret from the current file does **not** remove it from git history (commit
`b0f0c4f` and every commit until the removal still contain it). Rotation is what makes the
leaked value worthless; history rewrite is optional hygiene (see below).

## Rotation runbook (do this once, on the flagged project)

1. **Cloud console → APIs & Services → Credentials →** open the OAuth client
   `900207089503-…`.
2. **Add secret** (Google supports two live secrets during rotation). Copy the new value.
3. On each machine running the plugin, update the stored secret **without re-consenting**:
   ```bash
   cd ~/.google-multi-mcp/server && npm run setup -- --credentials
   ```
   Enter the same Client ID and the **new** secret. Restart Claude. Existing accounts keep
   working — refresh tokens are bound to the client id and user consent, not the secret.
4. Verify a tool call works (e.g. `search_emails`), then return to the console and
   **delete the old (leaked) secret**. The exposed value is now dead everywhere.

## Optional hardening

- **Make the repo private, or scrub history.** Private stops *future* discovery but does not
  un-leak a 3-month-public value — rotation is still required. To purge the old secret from
  history entirely: `git filter-repo --replace-text` (or BFG), then force-push. Anyone with
  an existing clone still has it, so treat rotation as the real control.
- **Delete the old `.plugin` / `.zip` packages** that embedded the secret (they predate
  v0.7.0). After rotation the embedded value is inert, but removing them avoids confusion.
- **Restricted scope note.** `driveScope: "full"` (`auth/drive`) is a Google *restricted*
  scope; publishing a verified app that uses it triggers an annual third-party security
  assessment. `driveScope: "file"` avoids restricted scopes entirely.

## Reporting

Found something? Open a private security advisory on the GitHub repo rather than a public
issue.
