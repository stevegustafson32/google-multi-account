/**
 * config.js — Multi-account configuration manager
 *
 * Stores account definitions and credentials in a single config.json file.
 * Supports any number of Google accounts, each with a custom label.
 *
 * Config file location: ~/.google-multi-mcp/config.json
 *
 * Schema:
 * {
 *   "clientId": "...",
 *   "clientSecret": "...",
 *   "accounts": [
 *     { "label": "personal", "email": "user@gmail.com", "tokenStore": "keychain" },
 *     { "label": "work", "email": "user@company.com", "refreshToken": "..." }
 *   ]
 * }
 *
 * Refresh tokens (v0.9.0+): the OS keychain is primary, the JSON file is the
 * fallback. Service "google-multi-mcp", account = the Google address. An
 * account record carries either `tokenStore: "keychain"` or a plaintext
 * `refreshToken`; never both. Tokens still in the file are migrated into the
 * keychain on the next server start or setup run (migrateTokensToKeychain).
 * Google's OAuth policy requires tokens encrypted at rest; this matches what
 * Claude Code does with its own credentials (keychain first, 0600 file second).
 *
 * The client id and secret stay in the file. Google treats an installed-app
 * client secret as public (developers.google.com/identity/protocols/oauth2#installed).
 */

import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";

// GOOGLE_MULTI_CONFIG_DIR exists for tests: it moves the file without moving
// HOME, which the macOS keychain also keys off.
const CONFIG_DIR =
  process.env.GOOGLE_MULTI_CONFIG_DIR || path.join(os.homedir(), ".google-multi-mcp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const KEYCHAIN_SERVICE = "google-multi-mcp";
const TOKEN_STORE_KEYCHAIN = "keychain";

// Optional native dependency. If it is missing or the OS has no keychain
// (headless Linux, a stripped Windows build), every call below falls back to
// the file and says so on stderr once. The server must never crash on this.
const require = createRequire(import.meta.url);
let keyringEntry = null;
let keyringWarned = false;
try {
  keyringEntry = require("@napi-rs/keyring").Entry;
} catch {
  keyringEntry = null;
}

function warnKeyringOnce(reason) {
  if (keyringWarned) return;
  keyringWarned = true;
  console.error(`[google-multi-account] keychain unavailable (${reason}); refresh tokens stay in config.json (mode 0600).`);
}

function keychainRead(email) {
  let token = null;
  if (keyringEntry) {
    try {
      token = new keyringEntry(KEYCHAIN_SERVICE, email).getPassword();
    } catch (err) {
      warnKeyringOnce(err.message);
    }
  }
  return token;
}

function keychainWrite(email, token) {
  let ok = false;
  if (keyringEntry) {
    try {
      new keyringEntry(KEYCHAIN_SERVICE, email).setPassword(token);
      ok = true;
    } catch (err) {
      warnKeyringOnce(err.message);
    }
  }
  return ok;
}

function keychainDelete(email) {
  if (!keyringEntry) return;
  try {
    new keyringEntry(KEYCHAIN_SERVICE, email).deletePassword();
  } catch {
    // Nothing stored, or no keychain. Either way there is nothing to remove.
  }
}

export function getConfigDir() {
  return CONFIG_DIR;
}

export function getConfigPath() {
  return CONFIG_FILE;
}

export function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
  }
}

export function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

export function getAccounts() {
  const config = loadConfig();
  if (!config || !config.accounts || config.accounts.length === 0) {
    return [];
  }
  return config.accounts;
}

export function getAccountLabels() {
  return getAccounts().map((a) => a.label);
}

export function getAccountByLabel(label) {
  return getAccounts().find((a) => a.label === label) || null;
}

/**
 * scopeVersion records which scope set the refresh token was consented under,
 * so the server can tell a pre-Drive token from a current one. Passed in by the
 * setup script rather than imported, to keep config.js free of dependencies.
 */
export function addAccount(label, email, refreshToken, scopeVersion) {
  const config = loadConfig() || { clientId: "", clientSecret: "", accounts: [] };
  const record = { label, email };
  if (scopeVersion !== undefined) record.scopeVersion = scopeVersion;
  storeRefreshToken(record, refreshToken);

  const existing = config.accounts.findIndex((a) => a.label === label);
  if (existing >= 0) {
    config.accounts[existing] = record;
  } else {
    config.accounts.push(record);
  }
  saveConfig(config);
}

export function removeAccount(label) {
  const config = loadConfig();
  if (!config) return;
  const removed = config.accounts.filter((a) => a.label === label);
  config.accounts = config.accounts.filter((a) => a.label !== label);
  saveConfig(config);
  for (const a of removed) keychainDelete(a.email);
}

/**
 * Put a refresh token where it belongs: keychain if possible, file otherwise.
 * Mutates the account record in place; the caller saves the config.
 */
export function storeRefreshToken(account, refreshToken) {
  if (keychainWrite(account.email, refreshToken)) {
    account.tokenStore = TOKEN_STORE_KEYCHAIN;
    delete account.refreshToken;
  } else {
    account.refreshToken = refreshToken;
    delete account.tokenStore;
  }
}

/** Resolve an account's refresh token from whichever store holds it. */
export function getRefreshToken(account) {
  let token = null;
  if (account?.tokenStore === TOKEN_STORE_KEYCHAIN) {
    token = keychainRead(account.email);
  } else if (account?.refreshToken) {
    token = account.refreshToken;
  }
  return token;
}

/**
 * Move any plaintext tokens left in config.json into the keychain. Safe to
 * call on every start: a no-op when nothing is left to move or when the
 * keychain is unavailable. Returns the labels it migrated.
 */
export function migrateTokensToKeychain() {
  const config = loadConfig();
  const migrated = [];
  if (config?.accounts?.length) {
    for (const account of config.accounts) {
      const pending = typeof account.refreshToken === "string" && account.refreshToken.length > 0;
      if (pending && keychainWrite(account.email, account.refreshToken)) {
        account.tokenStore = TOKEN_STORE_KEYCHAIN;
        delete account.refreshToken;
        migrated.push(account.label);
      }
    }
    if (migrated.length > 0) saveConfig(config);
  }
  return migrated;
}

export function setCredentials(clientId, clientSecret) {
  const config = loadConfig() || { clientId: "", clientSecret: "", accounts: [] };
  config.clientId = clientId;
  config.clientSecret = clientSecret;
  saveConfig(config);
}
