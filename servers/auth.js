/**
 * auth.js — OAuth2 client manager for N Google accounts
 *
 * Creates and caches OAuth2 clients for each configured account.
 * Auto-refreshes tokens. Provides convenience getters for Gmail/Calendar.
 */

import { google } from "googleapis";
import { loadConfig, getAccounts, saveConfig } from "./config.js";

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
];

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
