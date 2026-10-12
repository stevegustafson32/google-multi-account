/**
 * scopes.js — the single source of truth for OAuth scopes.
 *
 * These used to be duplicated in auth.js and scripts/setup-tokens.js, which
 * meant a scope added in one place silently didn't get consented in the other.
 * Both now import from here.
 *
 * Drive scope choice:
 *   "full" (default) — https://www.googleapis.com/auth/drive
 *       Read/write everything in the account's Drive. Required to write into a
 *       folder the user created by hand, and to search files the plugin didn't
 *       create. This is a Google "restricted" scope: fine for personal use and
 *       for apps in Testing mode, but a published/verified app carries a yearly
 *       security assessment. Keep this unless you distribute the plugin widely.
 *   "file" — https://www.googleapis.com/auth/drive.file
 *       Per-file access, no verification burden, but the plugin can only touch
 *       files it created itself. Search across an existing Drive won't work.
 *
 * Set it in ~/.google-multi-mcp/config.json:  { "driveScope": "file" }
 * Changing it requires re-consent:  npm run setup -- --reauth
 */

import { loadConfig } from "./config.js";

// gmail.modify already grants everything gmail.readonly and gmail.compose do
// (read, labels, drafts, send). calendar already covers calendar.events.
// Five scopes were consented through v0.8.0; three is the real set.
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

export const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"];

export const DRIVE_SCOPE_FULL = "https://www.googleapis.com/auth/drive";
export const DRIVE_SCOPE_FILE = "https://www.googleapis.com/auth/drive.file";

export function driveScope() {
  const config = loadConfig();
  return config?.driveScope === "file" ? DRIVE_SCOPE_FILE : DRIVE_SCOPE_FULL;
}

/** Every scope the server needs, in the order they're consented. */
export function getScopes() {
  return [...GMAIL_SCOPES, ...CALENDAR_SCOPES, driveScope()];
}

/**
 * True when the stored tokens predate the Drive scope. We can't inspect a
 * refresh token's scopes offline, so this is a config-recorded marker written
 * at setup time — see scripts/setup-tokens.js.
 */
export function accountNeedsReauth(account) {
  return !account?.scopeVersion || account.scopeVersion < SCOPE_VERSION;
}

/**
 * Bump when the scope list changes in a way that needs fresh consent.
 *   1  Gmail + Calendar
 *   2  + Drive (v0.5.0)
 *   3  trimmed to gmail.modify / calendar / drive, PKCE setup (v0.9.0)
 */
export const SCOPE_VERSION = 3;
