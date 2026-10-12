#!/usr/bin/env node
/**
 * setup-tokens.js — Interactive setup for Google Multi-Account MCP
 *
 * Usage:
 *   node scripts/setup-tokens.js
 *
 * Brings its own OAuth client (prompted once, stored in the local config).
 * No credentials are embedded in this file.
 *
 * Stores accounts and credentials in ~/.google-multi-mcp/config.json (gitignored)
 */

import http from "http";
import crypto from "crypto";
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

// Google's native-app guidance (RFC 8252 §8.3) prefers http://127.0.0.1:<port>,
// and a Desktop-app client accepts it without registration. Installs that still
// use a legacy Web-application client registered for the localhost form:
//   GOOGLE_MULTI_REDIRECT_URI=http://localhost:3847/oauth/callback npm run setup
const REDIRECT_URI =
  process.env.GOOGLE_MULTI_REDIRECT_URI || "http://127.0.0.1:3847/oauth/callback";
const CALLBACK_PORT = Number(new URL(REDIRECT_URI).port) || 3847;
const CALLBACK_PATH = new URL(REDIRECT_URI).pathname;
// Only loopback addresses are bound. `listen(port)` with no host binds every
// interface (Node picks `::`), which let anything on the LAN hand us a code.
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"];
const ALLOWED_HOST_HEADERS = new Set([
  `localhost:${CALLBACK_PORT}`,
  `127.0.0.1:${CALLBACK_PORT}`,
  `[::1]:${CALLBACK_PORT}`,
]);
const SCOPES = getScopes();

// `npm run setup -- --reauth` re-consents every account already in the config,
// which is what you need after the scope list changes (Drive landed in v0.5.0).
const REAUTH = process.argv.includes("--reauth");

// `npm run setup -- --credentials` replaces only the OAuth client id/secret and
// exits, without touching account tokens. Use it after rotating a secret in the
// Cloud console — existing refresh tokens survive a secret rotation.
const CREDENTIALS_ONLY = process.argv.includes("--credentials");

// No credentials are baked into this file. A shared OAuth client means shipping
// its secret in public source, which Google's scanner flags and which lets
// anyone impersonate the app on your project's quota. Each install brings its
// own client (id + secret), stored only in the local, gitignored config.json.
// See skills/google-setup/references/gcp-walkthrough.md.

// Line-queue input instead of rl.question. rl.question races badly with EOF on
// piped/redirected stdin — a fast pipe can close before the callback fires,
// hanging the promise and exiting 0 silently, or resolving in the wrong order.
// Buffering 'line' events and dispensing them handles a human at a TTY and a
// scripted `printf ... | setup` identically. Answers requested after stdin
// closes resolve to "" so validation runs deterministically.
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const lineQueue = [];
const waiters = [];
let stdinClosed = false;

rl.on("line", (line) => {
  const w = waiters.shift();
  if (w) w(line);
  else lineQueue.push(line);
});
rl.on("close", () => {
  stdinClosed = true;
  while (waiters.length) waiters.shift()("");
});

function ask(question) {
  process.stdout.write(question);
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (stdinClosed) return Promise.resolve("");
  return new Promise((resolve) => waiters.push(resolve));
}

async function authenticateAccount(clientId, clientSecret, label, email) {
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  // PKCE (S256) binds the authorization code to this process: a code captured
  // in transit is useless without the verifier. `state` is a per-run nonce so
  // the listener rejects any callback it did not initiate (CSRF on loopback).
  // Both are "recommended" by Google for installed apps and MUST per RFC 8252.
  const { codeVerifier, codeChallenge } = await oauth2.generateCodeVerifierAsync();
  const state = crypto.randomBytes(32).toString("base64url");

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    login_hint: email,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  console.log(`\n🔐 Connecting "${label}" (${email})...`);
  console.log(`   Your browser will open. Sign in with: ${email}\n`);

  // Dynamic import for ESM 'open' package. The URL is built by googleapis from
  // our own constants, never from input, so the mcp-remote CVE-2025-6514 shape
  // (attacker-controlled URL reaching a shell) does not apply here.
  const open = (await import("open")).default;

  return new Promise((resolve, reject) => {
    // One listener per loopback family so a browser resolving localhost to
    // ::1 still lands, without ever binding a non-loopback interface.
    const servers = [];
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      for (const srv of servers) srv.close();
      if (err) reject(err);
      else resolve();
    };

    const timeout = setTimeout(() => {
      finish(new Error("Timed out waiting for OAuth callback (2 minutes)"));
    }, 120_000);

    const handler = async (req, res) => {
      if (!ALLOWED_HOST_HEADERS.has(req.headers.host)) {
        res.writeHead(421);
        res.end("Misdirected request");
        return;
      }
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      if (url.searchParams.get("state") !== state) {
        res.writeHead(400);
        res.end("State mismatch — this callback was not started by the running setup. Ignored.");
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        const reason = url.searchParams.get("error") || "missing authorization code";
        res.writeHead(400);
        res.end(`Authorization failed: ${reason}`);
        finish(new Error(`Google returned: ${reason}`));
        return;
      }

      try {
        const { tokens } = await oauth2.getToken({ code, codeVerifier });
        if (!tokens.refresh_token) {
          throw new Error("No refresh_token in response (consent screen may have skipped offline access)");
        }
        addAccount(label, email, tokens.refresh_token, SCOPE_VERSION);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html><body style="font-family:system-ui;text-align:center;padding:60px">
            <h1>✅ ${label} account connected!</h1>
            <p>${email} is now linked to Claude. You can close this tab.</p>
          </body></html>
        `);
        finish();
      } catch (err) {
        res.writeHead(500);
        res.end("Token exchange failed: " + err.message);
        finish(err);
      }
    };

    let bound = 0;
    for (const host of LOOPBACK_HOSTS) {
      const srv = http.createServer(handler);
      srv.on("error", (err) => {
        // ::1 may be absent (IPv6 disabled). Only fail if nothing bound.
        if (host === "::1" && err.code === "EADDRNOTAVAIL") return;
        finish(new Error(`Could not listen on ${host}:${CALLBACK_PORT}: ${err.message}`));
      });
      srv.listen(CALLBACK_PORT, host, () => {
        servers.push(srv);
        bound += 1;
        if (bound === 1) {
          open(authUrl).catch(() => {
            console.log("   Could not open browser automatically.");
            console.log("   Open this URL manually:\n");
            console.log(`   ${authUrl}\n`);
          });
        }
      });
    }
  });
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  Google Multi-Account MCP — Setup               ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  ensureConfigDir();
  const existing = loadConfig();

  // Bring-your-own OAuth client. Prompt when the config has no credentials yet,
  // or when the user explicitly asks to replace them (`--credentials`, e.g. after
  // rotating a leaked secret in the Cloud console).
  const needCreds =
    CREDENTIALS_ONLY || !existing?.clientId || !existing?.clientSecret;

  let clientId = existing?.clientId;
  let clientSecret = existing?.clientSecret;

  if (needCreds) {
    console.log("This plugin uses your own Google OAuth client (nothing is pre-baked).");
    console.log("Create one — 5 minutes, one time:");
    console.log("  1. https://console.cloud.google.com  → create/pick a project");
    console.log("  2. Enable the Gmail, Google Calendar, and Google Drive APIs");
    console.log("  3. Audience: External, then Publish app (Testing mode expires tokens in 7 days)");
    console.log("  4. Clients → Create client → Desktop app (no redirect URI needed)");
    console.log("  5. Copy the Client ID and Client Secret below.");
    console.log("  (Full walkthrough: skills/google-setup/references/gcp-walkthrough.md)\n");

    const idIn = (await ask(`Client ID${clientId ? ` [${clientId}]` : ""}: `)).trim();
    const secretIn = (await ask("Client Secret: ")).trim();
    clientId = idIn || clientId;
    clientSecret = secretIn || clientSecret;

    if (!clientId || !clientSecret) {
      console.error("\n❌ Both a Client ID and Client Secret are required. Nothing saved.");
      rl.close();
      return;
    }
    setCredentials(clientId, clientSecret);
    console.log("✅ Credentials saved to ~/.google-multi-mcp/config.json (gitignored, mode 0600).\n");

    if (CREDENTIALS_ONLY) {
      console.log("Credentials updated. Existing account tokens are unchanged — no re-auth needed");
      console.log("unless a tool reports an auth error. Restart Claude to pick up the change.\n");
      rl.close();
      return;
    }
  } else {
    console.log("✅ Using your saved credentials from ~/.google-multi-mcp/config.json.\n");
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
      // On closed stdin every ask() returns "" — a bare `continue` here would
      // spin forever. Stop instead of looping when there's no more input.
      if (stdinClosed) break;
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
