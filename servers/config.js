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
 *     { "label": "personal", "email": "user@gmail.com", "refreshToken": "..." },
 *     { "label": "work", "email": "user@company.com", "refreshToken": "..." }
 *   ]
 * }
 */

import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_DIR = path.join(os.homedir(), ".google-multi-mcp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

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
  const record = { label, email, refreshToken };
  if (scopeVersion !== undefined) record.scopeVersion = scopeVersion;

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
  config.accounts = config.accounts.filter((a) => a.label !== label);
  saveConfig(config);
}

export function setCredentials(clientId, clientSecret) {
  const config = loadConfig() || { clientId: "", clientSecret: "", accounts: [] };
  config.clientId = clientId;
  config.clientSecret = clientSecret;
  saveConfig(config);
}
