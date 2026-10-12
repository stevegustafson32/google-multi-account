#!/usr/bin/env node
/**
 * index.js — Multi-Account Google MCP Server (v0.9.0)
 *
 * Dynamically registers Gmail, Calendar, and Drive tools based on the accounts
 * configured in ~/.google-multi-mcp/config.json. Supports any number
 * of Google accounts with custom labels.
 *
 * IMPORTANT: This server must NEVER call process.exit() on config errors.
 * Cowork/Claude Desktop treats a crashed MCP server as permanently dead.
 * Instead, start gracefully with zero tools and log the problem to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getAccountLabels, getAccounts, getConfigPath, migrateTokensToKeychain } from "./config.js";
import { registerGmailTools } from "./gmail-tools.js";
import {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  findFreeTime,
} from "./calendar.js";
import {
  driveSearch,
  driveListFolder,
  driveUpload,
  driveDownload,
  driveCreateFolder,
  driveFileInfo,
  driveShare,
} from "./drive.js";
import { accountNeedsReauth, driveScope, SCOPE_VERSION } from "./scopes.js";

// ========================================
// LOAD CONFIG (never crash on failure)
// ========================================

// v0.9.0: refresh tokens live in the OS keychain. Any still in config.json
// from an older install move over here, before the first client is built.
try {
  const moved = migrateTokensToKeychain();
  if (moved.length > 0) {
    console.error(`[google-multi-account] moved refresh tokens to the keychain for: ${moved.join(", ")}`);
  }
} catch (err) {
  console.error(`[google-multi-account] token migration skipped: ${err.message}`);
}

const accounts = getAccounts();
const labels = getAccountLabels();

if (labels.length === 0) {
  console.error(
    "[google-multi-account] No accounts configured.\n" +
      "  Run the /setup command in Claude, or manually:\n" +
      "  cd ~/.google-multi-mcp/server && npm run setup\n" +
      "  Config expected at: " + getConfigPath()
  );
}

// Build description showing configured accounts
const accountList = accounts
  .map((a) => `"${a.label}" (${a.email})`)
  .join(", ");

// Tokens consented under an older scope set keep working (older sets were
// supersets), but name them at startup so the next --reauth is not a surprise.
// Pre-v2 tokens lack Drive entirely and 403 on Drive calls.
const staleAccounts = accounts.filter(accountNeedsReauth).map((a) => a.label);
if (staleAccounts.length > 0) {
  console.error(
    `[google-multi-account] consented under an older scope set (need v${SCOPE_VERSION}): ${staleAccounts.join(", ")}.\n` +
      "  Re-authorize when convenient:\n" +
      "  cd ~/.google-multi-mcp/server && npm run setup -- --reauth"
  );
}

// Tools that send, share, or delete prompt on EVERY call in Claude Code, even
// in auto / acceptEdits / bypassPermissions, with no "don't ask again" and no
// allow-rule bypass (code.claude.com/docs/en/mcp#require-approval-for-a-specific-tool).
// This is the deterministic gate against a hostile email steering the model
// into forwarding mail or sharing a Drive file. Reads stay unprompted.
// Trim this list to loosen it; adding a name is all it takes to tighten it.
const SIDE_EFFECT_TOOLS = new Set([
  "send_email",
  "reply_to_email",
  "send_draft",
  "drive_share",
  "create_calendar_event",
  "update_calendar_event",
  "delete_calendar_event",
]);
const REQUIRES_USER_INTERACTION = Object.freeze({
  "anthropic/requiresUserInteraction": true,
});

function markSideEffectTools(mcpServer) {
  const originalTool = mcpServer.tool.bind(mcpServer);
  mcpServer.tool = (name, ...rest) => {
    const registered = originalTool(name, ...rest);
    if (SIDE_EFFECT_TOOLS.has(name)) {
      registered.update({ _meta: REQUIRES_USER_INTERACTION });
    }
    return registered;
  };
}

const server = new McpServer({
  name: "google-multi-account",
  version: "0.9.0",
  description:
    labels.length > 0
      ? `Multi-account Google MCP — Gmail, Calendar, and Drive for: ${accountList}. ` +
        "Every tool takes an 'account' parameter, so a file or message in one " +
        "identity's Drive/mailbox is reachable without switching logins."
      : "Multi-account Google MCP — no accounts configured yet. Run /setup.",
});

markSideEffectTools(server);

// ========================================
// REGISTER TOOLS (only if accounts exist)
// ========================================

if (labels.length > 0) {
  const AccountParam = z
    .enum(labels)
    .describe(`Which Google account: ${accountList}`);

  const AccountOrAllParam = z
    .enum([...labels, "all"])
    .describe(
      `Which Google account(s): ${accountList}, or "all" to search across every account`
    );

  // ── GMAIL TOOLS (gmail-tools.js) ─────────────────────────────

  registerGmailTools(server, { labels, AccountParam, AccountOrAllParam });

  // ── CALENDAR TOOLS ───────────────────────────────────────────

  server.tool(
    "list_calendar_events",
    `List calendar events from one or all accounts (${labels.join(", ")}). Defaults to next 7 days.`,
    {
      account: AccountOrAllParam,
      timeMin: z.string().optional().describe("Start of range (ISO 8601). Defaults to now."),
      timeMax: z.string().optional().describe("End of range (ISO 8601). Defaults to 7 days from now."),
      maxResults: z.number().optional().default(25).describe("Max events"),
      query: z.string().optional().describe("Text search within event titles/descriptions"),
    },
    async ({ account, timeMin, timeMax, maxResults, query }) => {
      const results = await listEvents({ account, timeMin, timeMax, maxResults, query });
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  server.tool(
    "create_calendar_event",
    "Create a new calendar event on a specific account's calendar.",
    {
      account: AccountParam,
      summary: z.string().describe("Event title"),
      startTime: z.string().describe("Start time (ISO 8601 for timed, YYYY-MM-DD for all-day)"),
      endTime: z.string().describe("End time (ISO 8601 for timed, YYYY-MM-DD for all-day)"),
      description: z.string().optional().describe("Event description/notes"),
      location: z.string().optional().describe("Event location"),
      allDay: z.boolean().optional().default(false).describe("All-day event"),
      attendees: z.array(z.string()).optional().describe("Attendee email addresses"),
      conferenceType: z
        .enum(["meet", "none"])
        .optional()
        .default("none")
        .describe('Add Google Meet link: "meet" or "none"'),
    },
    async (params) => {
      const result = await createEvent(params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "update_calendar_event",
    "Update an existing calendar event.",
    {
      account: AccountParam,
      eventId: z.string().describe("Event ID to update"),
      summary: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description"),
      location: z.string().optional().describe("New location"),
      startTime: z.string().optional().describe("New start time (ISO 8601)"),
      endTime: z.string().optional().describe("New end time (ISO 8601)"),
      attendees: z.array(z.string()).optional().describe("Updated attendee list"),
    },
    async (params) => {
      const result = await updateEvent(params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "delete_calendar_event",
    "Delete a calendar event.",
    {
      account: AccountParam,
      eventId: z.string().describe("Event ID to delete"),
    },
    async ({ account, eventId }) => {
      const result = await deleteEvent({ account, eventId });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "find_free_time",
    "Find available time slots across ALL configured calendars. Shows when you're truly free.",
    {
      timeMin: z.string().optional().describe("Start of range (ISO 8601). Defaults to now."),
      timeMax: z.string().optional().describe("End of range (ISO 8601). Defaults to 7 days from now."),
      duration: z.number().optional().default(30).describe("Minimum slot duration in minutes (default 30)"),
      workingHoursOnly: z
        .boolean()
        .optional()
        .default(true)
        .describe("Only show working hours (8 AM - 6 PM, weekdays). Default true."),
    },
    async (params) => {
      const result = await findFreeTime(params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ── DRIVE TOOLS ────────────────────────────────────────────
  //
  // Every ID parameter also accepts a pasted Drive URL — a folder link copied
  // from the browser works as-is, no ID extraction needed.

  const FileIdParam = z
    .string()
    .describe("Drive file ID, or a pasted Drive URL (…/file/d/<id>/…, …?id=<id>)");

  const FolderIdParam = z
    .string()
    .describe("Drive folder ID, or a pasted folder URL (…/drive/folders/<id>)");

  server.tool(
    "drive_search",
    `Search a specific account's Google Drive (${labels.join(", ")}). ` +
      "Use nameContains for filename search, fullText to search inside documents.",
    {
      account: AccountParam,
      nameContains: z.string().optional().describe("Match against the file name"),
      fullText: z.string().optional().describe("Match against file contents and name"),
      folderId: FolderIdParam.optional().describe("Restrict the search to one folder"),
      mimeType: z
        .string()
        .optional()
        .describe(
          "Exact MIME type filter, e.g. 'application/vnd.google-apps.folder' for folders only"
        ),
      rawQuery: z
        .string()
        .optional()
        .describe("Full Drive query syntax, used instead of the fields above"),
      maxResults: z.number().optional().default(25).describe("Max files (default 25, max 100)"),
      includeTrashed: z.boolean().optional().default(false).describe("Include trashed files"),
    },
    async (params) => {
      const result = await driveSearch(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "drive_list_folder",
    "List everything inside a Drive folder.",
    {
      account: AccountParam,
      folderId: FolderIdParam,
      maxResults: z.number().optional().default(100).describe("Max items (default 100)"),
    },
    async (params) => {
      const result = await driveListFolder(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "drive_upload",
    "Upload a local file into a specific account's Drive. This is how a file gets " +
      "into a personal Drive folder from a work login, or the reverse.",
    {
      account: AccountParam,
      filePath: z.string().describe("Local file to upload (absolute or ~/…)"),
      folderId: FolderIdParam.optional().describe("Destination folder. Omit for My Drive root."),
      name: z.string().optional().describe("Name in Drive. Defaults to the local filename."),
      mimeType: z.string().optional().describe("Override the detected content type"),
      convertTo: z
        .enum(["none", "document", "spreadsheet", "presentation"])
        .optional()
        .default("none")
        .describe("Convert to a native Google Doc/Sheet/Slides instead of storing the raw file"),
    },
    async (params) => {
      const result = await driveUpload(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "drive_download",
    "Download a Drive file to disk. Google Docs/Sheets/Slides are exported " +
      "(.docx/.xlsx/.pptx by default).",
    {
      account: AccountParam,
      fileId: FileIdParam,
      destPath: z
        .string()
        .optional()
        .describe("Destination folder or file path. Defaults to ~/Downloads."),
      exportMimeType: z
        .string()
        .optional()
        .describe("Export format for Google-native files, e.g. 'application/pdf'"),
    },
    async (params) => {
      const result = await driveDownload(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "drive_create_folder",
    "Create a folder in a specific account's Drive.",
    {
      account: AccountParam,
      name: z.string().describe("Folder name"),
      parentId: FolderIdParam.optional().describe("Parent folder. Omit for My Drive root."),
    },
    async (params) => {
      const result = await driveCreateFolder(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "drive_file_info",
    "Get metadata and current sharing permissions for a Drive file or folder.",
    { account: AccountParam, fileId: FileIdParam },
    async (params) => {
      const result = await driveFileInfo(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "drive_share",
    "Grant access to a Drive file or folder. This changes who can see the owner's " +
      "data, so confirm with the user before calling it. Use type 'user' with an " +
      "emailAddress for a named person, or type 'anyone' for a link-anyone-can-open.",
    {
      account: AccountParam,
      fileId: FileIdParam,
      role: z
        .enum(["reader", "commenter", "writer"])
        .optional()
        .default("reader")
        .describe("Access level to grant"),
      type: z
        .enum(["user", "anyone"])
        .optional()
        .default("user")
        .describe("'user' grants to one address; 'anyone' makes it link-accessible"),
      emailAddress: z.string().optional().describe("Who to share with (required when type=user)"),
      sendNotification: z
        .boolean()
        .optional()
        .default(false)
        .describe("Email the person that you shared it (user type only)"),
    },
    async (params) => {
      const result = await driveShare(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
} // end if (labels.length > 0)

// ========================================
// START
// ========================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[google-multi-account] MCP running — ${accounts.length} account(s): ${accountList || "none"}` +
      (labels.length > 0 ? ` — Gmail + Calendar + Drive (${driveScope().split("/").pop()})` : "")
  );
}

main().catch((err) => {
  console.error("[google-multi-account] Fatal error:", err);
  // Do NOT call process.exit() — Cowork/Claude Desktop treats a crashed
  // MCP server as permanently dead. Log and let the process stay alive.
});
