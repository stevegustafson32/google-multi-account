#!/usr/bin/env node
/**
 * index.js — Multi-Account Google MCP Server (v0.7.0)
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
import { getAccountLabels, getAccounts, getConfigPath } from "./config.js";
import {
  searchEmails,
  getThread,
  sendEmail,
  createDraft,
  listLabels,
  labelMessage,
  listAttachments,
  getAttachment,
  downloadAttachment,
} from "./gmail.js";
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
import { accountNeedsReauth, driveScope } from "./scopes.js";

// ========================================
// LOAD CONFIG (never crash on failure)
// ========================================

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

// Drive arrived in v0.5.0. Tokens minted before it were consented without the
// Drive scope, so Drive calls 403 with a confusing message. Name the stale
// accounts at startup instead — the tools still register either way.
const staleAccounts = accounts.filter(accountNeedsReauth).map((a) => a.label);
if (staleAccounts.length > 0) {
  console.error(
    `[google-multi-account] Drive scope not yet consented for: ${staleAccounts.join(", ")}.\n` +
      "  Drive tools will fail until you re-authorize:\n" +
      "  cd ~/.google-multi-mcp/server && npm run setup -- --reauth"
  );
}

const server = new McpServer({
  name: "google-multi-account",
  version: "0.7.0",
  description:
    labels.length > 0
      ? `Multi-account Google MCP — Gmail, Calendar, and Drive for: ${accountList}. ` +
        "Every tool takes an 'account' parameter, so a file or message in one " +
        "identity's Drive/mailbox is reachable without switching logins."
      : "Multi-account Google MCP — no accounts configured yet. Run /setup.",
});

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

  // ── GMAIL TOOLS ──────────────────────────────────────────────

  server.tool(
    "search_emails",
    `Search emails across one or all Google accounts (${labels.join(", ")}). Returns message metadata.`,
    {
      account: AccountOrAllParam,
      query: z
        .string()
        .describe(
          "Gmail search query (same syntax as Gmail search bar). Examples: 'from:john@example.com', 'subject:invoice', 'is:unread newer_than:2d'"
        ),
      maxResults: z
        .number()
        .optional()
        .default(20)
        .describe("Max results to return (default 20, max 50)"),
    },
    async ({ account, query, maxResults }) => {
      const results = await searchEmails({ account, query, maxResults });
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  server.tool(
    "get_email_thread",
    "Get a full email thread including message bodies.",
    {
      account: AccountParam,
      threadId: z.string().describe("Thread ID from search_emails results"),
    },
    async ({ account, threadId }) => {
      const result = await getThread({ account, threadId });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "send_email",
    `Send an email from any configured account (${labels.join(", ")}).`,
    {
      account: AccountParam,
      to: z.string().describe("Recipient email address(es), comma-separated"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body text. If contentType is text/html, this should be valid HTML."),
      cc: z.string().optional().describe("CC recipients, comma-separated"),
      bcc: z.string().optional().describe("BCC recipients, comma-separated"),
      replyToMessageId: z
        .string()
        .optional()
        .describe("Message ID to reply to (threads the reply)"),
      contentType: z
        .enum(["text/plain", "text/html"])
        .optional()
        .default("text/plain")
        .describe('Body format: "text/plain" (default) or "text/html" for rich formatting'),
      attachments: z
        .array(z.string())
        .optional()
        .describe(
          "Local file paths to attach (absolute or ~/…). Total must stay under 20MB; " +
            "for anything bigger use drive_upload and send the link."
        ),
    },
    async ({ account, to, subject, body, cc, bcc, replyToMessageId, contentType, attachments }) => {
      const result = await sendEmail({
        account,
        to,
        subject,
        body,
        cc,
        bcc,
        replyToMessageId,
        contentType,
        attachments,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "create_email_draft",
    "Create an email draft in a specific account (does NOT send it). Pass replyToMessageId to thread the draft with an existing conversation.",
    {
      account: AccountParam,
      to: z.string().describe("Recipient email address(es)"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body text. If contentType is text/html, this should be valid HTML."),
      cc: z.string().optional().describe("CC recipients"),
      bcc: z.string().optional().describe("BCC recipients"),
      replyToMessageId: z
        .string()
        .optional()
        .describe("Message ID to reply to (threads the draft with the original conversation)"),
      contentType: z
        .enum(["text/plain", "text/html"])
        .optional()
        .default("text/plain")
        .describe('Body format: "text/plain" (default) or "text/html" for rich formatting'),
      attachments: z
        .array(z.string())
        .optional()
        .describe("Local file paths to attach (absolute or ~/…). Total must stay under 20MB."),
    },
    async ({ account, to, subject, body, cc, bcc, replyToMessageId, contentType, attachments }) => {
      const result = await createDraft({
        account, to, subject, body, cc, bcc, replyToMessageId, contentType, attachments,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "list_email_labels",
    "List all labels/folders for a Gmail account.",
    { account: AccountParam },
    async ({ account }) => {
      const result = await listLabels({ account });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "label_email",
    "Add or remove labels from an email message.",
    {
      account: AccountParam,
      messageId: z.string().describe("Message ID to modify"),
      labelIds: z
        .array(z.string())
        .optional()
        .describe("Label IDs to ADD"),
      removeLabelIds: z
        .array(z.string())
        .optional()
        .describe("Label IDs to REMOVE"),
    },
    async ({ account, messageId, labelIds, removeLabelIds }) => {
      const result = await labelMessage({
        account,
        messageId,
        labelIds,
        removeLabelIds,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "list_attachments",
    "List all attachments on a specific email message. Returns filename, MIME type, size, and attachmentId for each.",
    {
      account: AccountParam,
      messageId: z.string().describe("Message ID (from search_emails results)"),
    },
    async ({ account, messageId }) => {
      const result = await listAttachments({ account, messageId });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "download_attachment",
    "Save an email attachment straight to disk and return the path. Prefer this " +
      "over get_attachment for anything large or binary — get_attachment returns " +
      "base64 into the conversation.",
    {
      account: AccountParam,
      messageId: z.string().describe("Message ID the attachment belongs to"),
      attachmentId: z
        .string()
        .optional()
        .describe("Attachment ID from list_attachments. Omit to select by filename."),
      filename: z
        .string()
        .optional()
        .describe("Attachment filename to match. Omit both to take the first attachment."),
      destPath: z
        .string()
        .optional()
        .describe("Destination folder or file path. Defaults to ~/Downloads."),
    },
    async (params) => {
      const result = await downloadAttachment(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_attachment",
    "Download an email attachment. Returns the file data as base64url-encoded string. Use attachmentId from list_attachments, or specify filename to look it up.",
    {
      account: AccountParam,
      messageId: z.string().describe("Message ID containing the attachment"),
      attachmentId: z
        .string()
        .optional()
        .describe("Attachment ID from list_attachments (preferred, faster)"),
      filename: z
        .string()
        .optional()
        .describe("Filename to look up if attachmentId not available"),
    },
    async ({ account, messageId, attachmentId, filename }) => {
      const result = await getAttachment({ account, messageId, attachmentId, filename });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

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
