#!/usr/bin/env node
/**
 * setup-tokens.js — Interactive setup for Google Multi-Account MCP
 *
 * Usage:
 *   node scripts/setup-tokens.js
 *
 * Pre-baked OAuth credentials — users just enter their email,
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
import { getScopes, SCOPE_VERSION, driveScope } from "../scopes.js";

const REDIRECT_URI = "http://localhost:3847/oauth/callback";
const SCOPES = getScopes();

// `npm run setup -- --reauth` re-consents every account already in the config,
// which is what you need after the scope list changes (Drive landed in v0.5.0).
const REAUTH = process.argv.includes("--reauth");

// Pre-baked OAuth credentials — users don't need their own GCP project
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

  console.log(`\n🔐 Connecting "${label}" (${email})...`);
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
        addAccount(label, email, tokens.refresh_token, SCOPE_VERSION);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html><body style="font-family:system-ui;text-align:center;padding:60px">
            <h1>✅ ${label} account connected!</h1>
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
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  Google Multi-Account MCP — Setup               ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  ensureConfigDir();
  const existing = loadConfig();

  // Use existing credentials if present, otherwise use pre-baked defaults
  let clientId = existing?.clientId || DEFAULT_CLIENT_ID;
  let clientSecret = existing?.clientSecret || DEFAULT_CLIENT_SECRET;

  // Save credentials to config (idempotent)
  setCredentials(clientId, clientSecret);

  // Tell the user which credentials are active
  if (clientId === DEFAULT_CLIENT_ID) {
    console.log("✅ Using default shared credentials (no GCP project needed).\n");
  } else {
    console.log("✅ Using user-provided credentials from ~/.google-multi-mcp/config.json.\n");
  }

  // ── Re-authorize existing accounts (after a scope change) ──
  if (REAUTH) {
    const list = existing?.accounts || [];
    if (list.length === 0) {
      console.log("Nothing to re-authorize — no accounts configured yet.");
      console.log("Run without --reauth to add your first account.\n");
      rl.close();
      return;
    }

    console.log(`Drive scope: ${driveScope()}`);
    console.log(`Re-authorizing ${list.length} account(s) with the current scopes.`);
    console.log("Approve the Google Drive permission on each screen.\n");

    for (const a of list) {
      try {
        await authenticateAccount(clientId, clientSecret, a.label, a.email);
        console.log(`✅ ${a.label} (${a.email}) re-authorized.\n`);
      } catch (err) {
        console.error(`❌ FAILED ${a.label}: ${err.message}\n`);
      }
    }

    console.log("Done. Restart Claude (Cmd+Q then reopen) to pick up the new scopes.\n");
    rl.close();
    return;
  }

  // Show existing accounts if any
  if (existing?.accounts?.length) {
    console.log("Already connected:");
    for (const a of existing.accounts) {
      console.log(`  • ${a.label} (${a.email})`);
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
    console.log(`\n── Account ${accountNum} ──`);
    const label = (
      await ask('Give this account a name (e.g. "personal", "work"): ')
    ).trim();
    const email = (await ask("Gmail address: ")).trim();

    if (!label || !email) {
      console.log("Skipping — name and email are required.");
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
  console.log(`  Done! ${total} account(s) connected.`);
  if (total > 0) {
    for (const a of config.accounts) {
      console.log(`    • ${a.label} → ${a.email}`);
    }
  }
  console.log(`\n  Restart Claude (Cmd+Q then reopen) to activate.`);
  console.log("══════════════════════════════════════════════════\n");

  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  rl.close();
  process.exit(1);
});
