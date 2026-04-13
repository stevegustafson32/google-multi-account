#!/usr/bin/env node
/**
 * setup-tokens.js — Interactive setup for Google Multi-Account MCP
 *
 * Usage:
 *   node scripts/setup-tokens.js
 *
 * Walks the user through:
 * 1. Entering GCP OAuth credentials (Client ID + Secret)
 * 2. Adding Google accounts one by one with custom labels
 * 3. OAuth browser flow for each account
 *
 * Stores everything in ~/.google-multi-mcp/config.json
 */

import http from "http";
import { URL } from "url";
import { google } from "googleapis";
import {
  loadConfig,
  saveConfig,
  ensureConfigDir,
  setCredentials,
  addAccount,
  getConfigPath,
} from "../config.js";
import readline from "readline";

const REDIRECT_URI = "http://localhost:3847/oauth/callback";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function authenticateAccount(clientId, clientSecret, label, email) {
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    login_hint: email,
  });

  console.log(`\n🔐 Authenticating "${label}" (${email})...`);
  console.log(`   Opening browser. Sign in with: ${email}\n`);

  // Dynamic import for ESM 'open' package
  const open = (await import("open")).default;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for OAuth callback (2 minutes)"));
    }, 120_000);

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost:3847");
      if (url.pathname !== "/oauth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400);
        res.end("Missing authorization code");
        return;
      }

      try {
        const { tokens } = await oauth2.getToken(code);
        addAccount(label, email, tokens.refresh_token);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html><body style="font-family:system-ui;text-align:center;padding:60px">
            <h1>✅ ${label} account connected!</h1>
            <p>${email} is now linked. You can close this tab.</p>
          </body></html>
        `);

        clearTimeout(timeout);
        server.close();
        resolve();
      } catch (err) {
        res.writeHead(500);
        res.end("Token exchange failed: " + err.message);
        clearTimeout(timeout);
        server.close();
        reject(err);
      }
    });

    server.listen(3847, () => {
      open(authUrl).catch(() => {
        console.log("   Could not open browser automatically.");
        console.log("   Open this URL manually:\n");
        console.log(`   ${authUrl}\n`);
      });
    });
  });
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  Google Multi-Account MCP — Setup               ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  ensureConfigDir();
  const existing = loadConfig();

  let clientId, clientSecret;

  if (existing?.clientId && existing?.clientSecret) {
    console.log(`Found existing credentials in ${getConfigPath()}`);
    const reuse = await ask("Use existing GCP credentials? (y/n): ");
    if (reuse.toLowerCase() === "y") {
      clientId = existing.clientId;
      clientSecret = existing.clientSecret;
    }
  }

  if (!clientId) {
    console.log("\nYou'll need a Google Cloud Platform OAuth client.");
    console.log("If you don't have one yet, create it at:");
    console.log("  https://console.cloud.google.com/auth/clients\n");
    console.log("Required settings:");
    console.log("  • Application type: Web application");
    console.log("  • Authorized redirect URI: http://localhost:3847/oauth/callback");
    console.log("  • APIs enabled: Gmail API, Google Calendar API\n");

    clientId = await ask("Client ID: ");
    clientSecret = await ask("Client Secret: ");
    setCredentials(clientId.trim(), clientSecret.trim());
    console.log("\n✅ Credentials saved.\n");
  }

  // Add accounts loop
  let addMore = true;
  let accountNum = (existing?.accounts?.length || 0) + 1;

  if (existing?.accounts?.length) {
    console.log(`\nExisting accounts:`);
    for (const a of existing.accounts) {
      console.log(`  • ${a.label} (${a.email})`);
    }
    const cont = await ask("\nAdd another account? (y/n): ");
    if (cont.toLowerCase() !== "y") addMore = false;
  }

  while (addMore) {
    console.log(`\n── Account ${accountNum} ──`);
    const label = (
      await ask('Label (e.g. "personal", "work", "client-acme"): ')
    ).trim();
    const email = (await ask("Email address: ")).trim();

    if (!label || !email) {
      console.log("Skipping — label and email are required.");
      continue;
    }

    try {
      await authenticateAccount(clientId, clientSecret, label, email);
      console.log(`✅ "${label}" (${email}) connected!\n`);
      accountNum++;
    } catch (err) {
      console.error(`❌ Failed to connect "${label}": ${err.message}\n`);
    }

    const more = await ask("Add another account? (y/n): ");
    if (more.toLowerCase() !== "y") addMore = false;
  }

  const config = loadConfig();
  const total = config?.accounts?.length || 0;

  console.log("\n══════════════════════════════════════════════════");
  console.log(`  Setup complete! ${total} account(s) configured.`);
  if (total > 0) {
    for (const a of config.accounts) {
      console.log(`    • ${a.label} → ${a.email}`);
    }
  }
  console.log(`\n  Config: ${getConfigPath()}`);
  console.log("══════════════════════════════════════════════════\n");

  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  rl.close();
  process.exit(1);
});
