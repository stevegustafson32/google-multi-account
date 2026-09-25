/**
 * gmail-tools.js — MCP registration for the Gmail tools (v0.8.0).
 *
 * Moved out of index.js so the server entry point stays readable. Tool names
 * and existing parameters are unchanged; skills that call create_email_draft
 * with replyToMessageId keep working.
 */

import { z } from "zod";
import { searchEmails, getThread, listLabels, labelMessage } from "./gmail.js";
import { sendEmail, createDraft, replyToEmail } from "./compose.js";
import { listDrafts, updateDraft, sendDraft } from "./drafts.js";
import {
  listAttachments,
  getAttachment,
  downloadAttachment,
  downloadAllAttachments,
} from "./attachments.js";

const ContentTypeParam = z
  .enum(["text/plain", "text/html"])
  .optional()
  .describe('Body format: "text/plain" (default) or "text/html" for rich formatting');

// Models pass recipients as a string or as an array; accept both.
const Recipients = z.union([z.string(), z.array(z.string())]);

const AttachmentsParam = z
  .array(z.string())
  .optional()
  .describe(
    "Local file paths to attach (absolute or ~/…). Total must stay under 18MB; " +
      "for anything bigger use drive_upload and send the link."
  );

const NewThreadParam = z
  .boolean()
  .optional()
  .describe(
    'Set true only to deliberately start a new thread with a "Re:" subject. ' +
      "Otherwise a Re: subject without replyToMessageId is rejected."
  );

function reply(result) {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export function registerGmailTools(server, { labels, AccountParam, AccountOrAllParam }) {
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
      maxResults: z.number().optional().describe("Max results to return (default 20, max 50)"),
    },
    async ({ account, query, maxResults }) => reply(await searchEmails({ account, query, maxResults }))
  );

  server.tool(
    "get_email_thread",
    "Get an email thread with message bodies. Returns the newest maxMessages " +
      "(default 10) in chronological order; truncated:true means older ones were left out.",
    {
      account: AccountParam,
      threadId: z.string().describe("Thread ID from search_emails results"),
      maxMessages: z.number().optional().describe("How many of the newest messages to return (default 10)"),
      bodyMax: z.number().optional().describe("Max characters per message body (default 5000)"),
    },
    async (params) => reply(await getThread(params))
  );

  server.tool(
    "reply_to_email",
    "Reply to an email IN ITS THREAD. Use this for every reply instead of " +
      "create_email_draft. Pass the messageId to answer (or a threadId to answer its " +
      "latest message). To, Cc, the Re: subject, threading headers and the quoted " +
      "history are filled in for you, so the draft shows up inline under the " +
      "conversation in Gmail. Creates a draft unless send:true.",
    {
      account: AccountParam,
      messageId: z.string().optional().describe("Message to reply to (from search_emails / get_email_thread)"),
      threadId: z.string().optional().describe("Or a thread: replies to its newest non-draft message"),
      body: z.string().describe("Your reply only. The quoted original is appended automatically."),
      replyAll: z.boolean().optional().describe("Include the other To/Cc recipients (default false)"),
      send: z.boolean().optional().describe("Send immediately instead of drafting (default false)"),
      cc: Recipients.optional().describe("Extra Cc recipients to add"),
      bcc: Recipients.optional().describe("Bcc recipients"),
      attachments: AttachmentsParam,
      quote: z.boolean().optional().describe("Append the quoted original (default true)"),
      contentType: ContentTypeParam,
    },
    async (params) => reply(await replyToEmail(params))
  );

  server.tool(
    "send_email",
    `Send a NEW email from any configured account (${labels.join(", ")}). ` +
      "For replies use reply_to_email.",
    {
      account: AccountParam,
      to: Recipients.describe("Recipient email address(es): comma-separated string or array"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body text. If contentType is text/html, this should be valid HTML."),
      cc: Recipients.optional().describe("CC recipients"),
      bcc: Recipients.optional().describe("BCC recipients"),
      replyToMessageId: z
        .string()
        .optional()
        .describe("Message ID to reply to (threads the reply). Prefer reply_to_email."),
      newThread: NewThreadParam,
      contentType: ContentTypeParam,
      attachments: AttachmentsParam,
    },
    async (params) => reply(await sendEmail(params))
  );

  server.tool(
    "create_email_draft",
    "Create a draft of a NEW email (does NOT send it). For replies use " +
      "reply_to_email, which threads the draft inline. To revise a draft use " +
      "update_draft — never create a second draft for the same email.",
    {
      account: AccountParam,
      to: Recipients.describe("Recipient email address(es): comma-separated string or array"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body text. If contentType is text/html, this should be valid HTML."),
      cc: Recipients.optional().describe("CC recipients"),
      bcc: Recipients.optional().describe("BCC recipients"),
      replyToMessageId: z
        .string()
        .optional()
        .describe("Message ID to reply to (threads the draft). Prefer reply_to_email."),
      newThread: NewThreadParam,
      contentType: ContentTypeParam,
      attachments: AttachmentsParam,
    },
    async (params) => reply(await createDraft(params))
  );

  server.tool(
    "list_drafts",
    "List drafts with recipients, subject, attachment names, and whether each is " +
      "threaded into a conversation. Returns draftId + messageId for update_draft.",
    {
      account: AccountParam,
      query: z.string().optional().describe("Gmail search to filter drafts, e.g. 'to:manuel'"),
      maxResults: z.number().optional().describe("Default 20, max 50"),
    },
    async (params) => reply(await listDrafts(params))
  );

  server.tool(
    "update_draft",
    "Revise an existing draft in place (same draft, same thread). Only pass the " +
      "fields you are changing; recipients, subject, body, threading and existing " +
      "attachments carry over. New attachments are added to the existing ones.",
    {
      account: AccountParam,
      draftId: z.string().describe("Draft ID from create_email_draft / reply_to_email / list_drafts"),
      expectedMessageId: z
        .string()
        .describe("The draft's current messageId (from the create result or list_drafts). Refuses if the draft changed since."),
      to: Recipients.optional(),
      cc: Recipients.optional(),
      bcc: Recipients.optional(),
      subject: z.string().optional(),
      body: z.string().optional().describe("Full replacement body"),
      contentType: ContentTypeParam,
      attachments: AttachmentsParam,
      keepExistingAttachments: z
        .boolean()
        .optional()
        .describe("Keep the attachments already on the draft (default true)"),
    },
    async (params) => reply(await updateDraft(params))
  );

  server.tool(
    "send_draft",
    "Send an existing draft through the API, exactly as built. Confirm with the user first.",
    {
      account: AccountParam,
      draftId: z.string().describe("Draft ID to send"),
    },
    async (params) => reply(await sendDraft(params))
  );

  server.tool(
    "list_email_labels",
    "List all labels/folders for a Gmail account.",
    { account: AccountParam },
    async ({ account }) => reply(await listLabels({ account }))
  );

  server.tool(
    "label_email",
    "Add or remove labels from an email message.",
    {
      account: AccountParam,
      messageId: z.string().describe("Message ID to modify"),
      labelIds: z.array(z.string()).optional().describe("Label IDs to ADD"),
      removeLabelIds: z.array(z.string()).optional().describe("Label IDs to REMOVE"),
    },
    async (params) => reply(await labelMessage(params))
  );

  server.tool(
    "list_attachments",
    "List every attachment on a message: partId (use it to download), filename, " +
      "MIME type, size, and inline:true for embedded images like signature logos.",
    {
      account: AccountParam,
      messageId: z.string().describe("Message ID (from search_emails results)"),
    },
    async (params) => reply(await listAttachments(params))
  );

  const PartSelector = {
    partId: z.string().optional().describe("partId from list_attachments (preferred, always unique)"),
    attachmentId: z.string().optional().describe("attachmentId from list_attachments"),
    filename: z
      .string()
      .optional()
      .describe("Exact filename; errors if several attachments share it"),
  };

  server.tool(
    "download_attachment",
    "Save ONE email attachment to disk and return the path. For several, use " +
      "download_all_attachments. Never overwrites: a clash saves as 'name (1).ext'.",
    {
      account: AccountParam,
      messageId: z.string().describe("Message ID the attachment belongs to"),
      ...PartSelector,
      destPath: z
        .string()
        .optional()
        .describe("Destination folder (end with /) or file path. Defaults to ~/Downloads."),
    },
    async (params) => reply(await downloadAttachment(params))
  );

  server.tool(
    "download_all_attachments",
    "Save every attachment on a message to a folder in one call. Skips inline " +
      "images (signature logos) unless includeInline is true.",
    {
      account: AccountParam,
      messageId: z.string().describe("Message ID"),
      destDir: z.string().optional().describe("Destination folder. Defaults to ~/Downloads."),
      includeInline: z.boolean().optional().describe("Also save inline images (default false)"),
    },
    async (params) => reply(await downloadAllAttachments(params))
  );

  server.tool(
    "get_attachment",
    "Return an attachment's bytes as base64url INTO the conversation. Only for " +
      "small files you need to read inline; prefer download_attachment.",
    {
      account: AccountParam,
      messageId: z.string().describe("Message ID containing the attachment"),
      ...PartSelector,
    },
    async (params) => reply(await getAttachment(params))
  );
}
