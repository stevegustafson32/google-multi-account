/**
 * auth.js — OAuth2 client manager for N Google accounts
 *
 * Creates and caches OAuth2 clients for each configured account.
 * Auto-refreshes tokens. Provides convenience getters for Gmail/Calendar.
 */

import { google } from "googleapis";
import { loadConfig, getAccounts, saveConfig } from "./config.js";
import { getScopes } from "./scopes.js";

// Kept as a named export for backwards compatibility; scopes.js is the source.
export const SCOPES = getScopes();

const clients = new Map();

function getOAuthClient(label) {
  if (clients.has(label)) return clients.get(label);

  const config = loadConfig();
  if (!config) throw new Error("No config found. Run setup first.");

  const account = config.accounts.find((a) => a.label === label);
  if (!account) throw new Error(`Account "${label}" not found in config.`);

  const oauth2 = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    "http://localhost:3847/oauth/callback"
  );

  oauth2.setCredentials({ refresh_token: account.refreshToken });

  oauth2.on("tokens", (tokens) => {
    if (tokens.refresh_token) {
      account.refreshToken = tokens.refresh_token;
      saveConfig(config);
    }
  });

  clients.set(label, oauth2);
  return oauth2;
}

export function getClient(label) {
  return getOAuthClient(label);
}

export function getGmail(label) {
  return google.gmail({ version: "v1", auth: getOAuthClient(label) });
}

export function getCalendar(label) {
  return google.calendar({ version: "v3", auth: getOAuthClient(label) });
}

export function getDrive(label) {
  return google.drive({ version: "v3", auth: getOAuthClient(label) });
}

export function getEmail(label) {
  const account = getAccounts().find((a) => a.label === label);
  return account ? account.email : label;
}

/**
 * Resolve "both" or "all" into the list of account labels,
 * or return a single-element array for a specific label.
 */
export function resolveAccounts(account) {
  if (account === "all") {
    return getAccounts().map((a) => a.label);
  }
  return [account];
}

/**
 * Detect Google API errors that mean "this account's refresh token is no
 * longer valid" — typically because the refresh token expired (e.g. 7-day
 * Testing-mode rule), the user revoked the app, the OAuth client was
 * rotated, or scopes changed.
 */
export function isAuthError(err) {
  if (!err) return false;
  const code = err.code || err.response?.status;
  if (code === 401 || code === 403) return true;
  const msg = String(err.message || err);
  return /invalid_grant|invalid_token|Token has been expired or revoked|unauthorized_client/i.test(msg);
}

/**
 * Wrap a Google API call so token-invalid errors return a structured re-auth
 * hint instead of an opaque 401. The model can then surface the exact command
 * the user needs to run.
 */
export async function withAuthErrorHandling(label, fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isAuthError(err)) throw err;
    const account = getAccounts().find((a) => a.label === label);
    const email = account?.email || "<email>";
    return {
      error: `Account "${label}" (${email}) needs to be re-authenticated. ` +
        `The refresh token is no longer valid (commonly: app is in Testing mode and ` +
        `the 7-day window passed, the OAuth client was rotated, or the user revoked access).`,
      reauth_command: `cd ~/.google-multi-mcp/server && npm run setup`,
      original_error: String(err.message || err),
      account: label,
    };
  }
}
