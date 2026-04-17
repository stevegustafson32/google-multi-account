#!/usr/bin/env node
/**
 * index.js — Multi-Account Google MCP Server (v0.2.1)
 *
 * Dynamically registers Gmail and Calendar tools based on the accounts
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
} from "./gmail.js";
import {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  findFreeTime,
} from "./calendar.js";

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

const server = new McpServer({
  name: "google-multi-account",
  version: "0.2.1",
  description:
    labels.length > 0
      ? `Multi-account Google MCP — access Gmail and Calendar for: ${accountList}.`
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
    },
    async ({ account, to, subject, body, cc, bcc, replyToMessageId, contentType }) => {
      const result = await sendEmail({
        account,
        to,
        subject,
        body,
        cc,
        bcc,
        replyToMessageId,
        contentType,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "create_email_draft",
    "Create an email draft in a specific account (does NOT send it).",
    {
      account: AccountParam,
      to: z.string().describe("Recipient email address(es)"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body text. If contentType is text/html, this should be valid HTML."),
      cc: z.string().optional().describe("CC recipients"),
      contentType: z
        .enum(["text/plain", "text/html"])
        .optional()
        .default("text/plain")
        .describe('Body format: "text/plain" (default) or "text/html" for rich formatting'),
    },
    async ({ account, to, subject, body, cc, contentType }) => {
      const result = await createDraft({ account, to, subject, body, cc, contentType });
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
} // end if (labels.length > 0)

// ========================================
// START
// ========================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[google-multi-account] MCP running — ${accounts.length} account(s): ${accountList || "none"}`
  );
}

main().catch((err) => {
  console.error("[google-multi-account] Fatal error:", err);
  process.exit(1);
});
