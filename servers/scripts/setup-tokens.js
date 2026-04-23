#!/usr/bin/env node
/**
 * setup-tokens.js â Interactive setup for Google Multi-Account MCP
 *
 * Usage:
 *   node scripts/setup-tokens.js
 *
 * Pre-baked OAuth credentials â users just enter their email,
 * click authorize in the browser, and they're done.
 *
 * Stores accounts in ~/.google-multi-mcp/config.json
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

// Pre-baked OAuth credentials â users don't need their own GCP project
const DEFAULT_CLIENT_ID =
  "900207089503-v48rgg92na8uke9ct02s9lf2nc4bc3ln.apps.googleusercontent.com";
const DEFAULT_CLIENT_SECRET = "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";

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

  console.log(`\nð Connecting "${label}" (${email})...`);
  console.log(`   Your browser will open. Sign in with: ${email}\n`);

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
            <h1>â ${label} account connected!</h1>
            <p>${email} is now linked to Claude. You can close this tab.</p>
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
  console.log("ââââââââââââââââââââââââââââââââââââââââââââââââââââ");
  console.log("â  Google Multi-Account MCP â Setup               â");
  console.log("ââââââââââââââââââââââââââââââââââââââââââââââââââââ\n");

  ensureConfigDir();
  const existing = loadConfig();

  // Use existing credentials if present, otherwise use pre-baked defaults
  let clientId = existing?.clientId || DEFAULT_CLIENT_ID;
  let clientSecret = existing?.clientSecret || DEFAULT_CLIENT_SECRET;

  // Save credentials to config (idempotent)
  setCredentials(clientId, clientSecret);
  console.log("â OAuth credentials loaded.\n");

  // Show existing accounts if any
  if (existing?.accounts?.length) {
    console.log("Already connected:");
    for (const a of existing.accounts) {
      console.log(`  â¢ ${a.label} (${a.email})`);
    }
    const cont = await ask("\nAdd another account? (y/n): ");
    if (cont.toLowerCase() !== "y") {
      console.log("\nAll set! Restart Claude to pick up any changes.");
      rl.close();
      return;
    }
  }

  // Add accounts loop
  let addMore = true;
  let accountNum = (existing?.accounts?.length || 0) + 1;

  while (addMore) {
    console.log(`\nââ Account ${accountNum} ââ`);
    const label = (
      await ask('Give this account a name (e.g. "personal", "work"): ')
    ).trim();
    const email = (await ask("Gmail address: ")).trim();

    if (!label || !email) {
      console.log("Skipping â name and email are required.");
      continue;
    }

    try {
      await authenticateAccount(clientId, clientSecret, label, email);
      console.log(`â "${label}" (${email}) connected!\n`);
      accountNum++;
    } catch (err) {
      console.error(`â Failed to connect "${label}": ${err.message}\n`);
    }

    const more = await ask("Add another account? (y/n): ");
    if (more.toLowerCase() !== "y") addMore = false;
  }

  const config = loadConfig();
  const total = config?.accounts?.length || 0;

  console.log("\nââââââââââââââââââââââââââââââââââââââââââââââââââ");
  console.log(`  Done! ${total} account(s) connected.`);
  if (total > 0) {
    for (const a of config.accounts) {
      console.log(`    â¢ ${a.label} â ${a.email}`);
    }
  }
  console.log(`\n  Restart Claude (Cmd+Q then reopen) to activate.`);
  console.log("ââââââââââââââââââââââââââââââââââââââââââââââââââ\n");

  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  rl.close();
  process.exit(1);
});
