/**
 * gmail.js — Gmail operations for any configured account
 */

import fs from "fs";
import path from "path";
import { getGmail, getEmail, resolveAccounts } from "./auth.js";
import { buildMessage } from "./mime.js";

export async function searchEmails({ account, query, maxResults = 20 }) {
  const labels = resolveAccounts(account);
  const allResults = [];

  await Promise.all(
    labels.map(async (label) => {
      try {
        const gmail = getGmail(label);
        const res = await gmail.users.messages.list({
          userId: "me",
          q: query,
          maxResults: Math.min(maxResults, 50),
        });

        const messages = res.data.messages || [];
        const details = await Promise.all(
          messages.map(async (msg) => {
            const full = await gmail.users.messages.get({
              userId: "me",
              id: msg.id,
              format: "metadata",
              metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
            });
            const headers = full.data.payload.headers;
            const get = (name) =>
              (headers.find((h) => h.name === name) || {}).value || "";
            return {
              account: label,
              accountEmail: getEmail(label),
              id: msg.id,
              threadId: msg.threadId,
              snippet: full.data.snippet,
              from: get("From"),
              to: get("To"),
              cc: get("Cc"),
              subject: get("Subject"),
              date: get("Date"),
              labels: full.data.labelIds || [],
            };
          })
        );
        allResults.push(...details);
      } catch (err) {
        allResults.push({
          account: label,
          error: err.message,
        });
      }
    })
  );

  allResults.sort((a, b) => {
    const da = a.date ? new Date(a.date) : new Date(0);
    const db = b.date ? new Date(b.date) : new Date(0);
    return db - da;
  });

  return allResults;
}

export async function getThread({ account, threadId }) {
  const gmail = getGmail(account);
  const res = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });

  const messages = (res.data.messages || []).map((msg) => {
    const headers = msg.payload.headers;
    const get = (name) =>
      (headers.find((h) => h.name === name) || {}).value || "";

    let body = "";
    function extractText(part) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        body += Buffer.from(part.body.data, "base64").toString("utf-8");
      } else if (part.mimeType === "text/html" && !body && part.body?.data) {
        const html = Buffer.from(part.body.data, "base64").toString("utf-8");
        body += html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
      if (part.parts) part.parts.forEach(extractText);
    }
    extractText(msg.payload);

    if (body.length > 5000) body = body.substring(0, 5000) + "\n...[truncated]";

    return {
      id: msg.id,
      from: get("From"),
      to: get("To"),
      cc: get("Cc"),
      date: get("Date"),
      subject: get("Subject"),
      body,
      attachments: collectAttachments(msg.payload),
    };
  });

  return { account, threadId, messages };
}

/**
 * Walk a payload tree for parts that are real attachments. Inline images carry
 * a filename too, so they show up here with inline:true rather than being
 * dropped — a signature logo and a contract look different to the caller.
 */
function collectAttachments(payload, found = []) {
  if (!payload) return found;

  if (payload.filename && payload.body?.attachmentId) {
    const disposition = (payload.headers || []).find(
      (h) => h.name?.toLowerCase() === "content-disposition"
    )?.value;
    found.push({
      filename: payload.filename,
      mimeType: payload.mimeType,
      sizeBytes: payload.body.size,
      attachmentId: payload.body.attachmentId,
      inline: /inline/i.test(disposition || ""),
    });
  }
  if (payload.parts) payload.parts.forEach((p) => collectAttachments(p, found));
  return found;
}

/** List every attachment on a single message, without pulling the bodies. */
export async function listAttachments({ account, messageId }) {
  const gmail = getGmail(account);
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = res.data.payload?.headers || [];
  const get = (name) => (headers.find((h) => h.name === name) || {}).value || "";
  const attachments = collectAttachments(res.data.payload);

  return {
    account,
    messageId,
    subject: get("Subject"),
    from: get("From"),
    date: get("Date"),
    count: attachments.length,
    attachments,
  };
}

/**
 * Download one attachment to disk. destPath may be a directory (the original
 * filename is kept) or a full target path.
 */
export async function downloadAttachment({ account, messageId, attachmentId, filename, destPath }) {
  const gmail = getGmail(account);

  // Resolve by filename when the caller has a name but not an id.
  let id = attachmentId;
  let name = filename;
  if (!id) {
    const listed = await listAttachments({ account, messageId });
    const match = filename
      ? listed.attachments.find((a) => a.filename === filename)
      : listed.attachments[0];
    if (!match) {
      throw new Error(
        filename
          ? `No attachment named "${filename}" on message ${messageId}`
          : `Message ${messageId} has no attachments`
      );
    }
    id = match.attachmentId;
    name = match.filename;
  }

  const res = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id,
  });

  const buf = Buffer.from(res.data.data, "base64url");

  let target = destPath
    ? destPath.startsWith("~")
      ? path.join(process.env.HOME || "", destPath.slice(1))
      : path.resolve(destPath)
    : path.join(process.env.HOME || ".", "Downloads");

  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = path.join(target, name || `attachment-${id.slice(0, 8)}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);

  return {
    account,
    messageId,
    filename: name,
    savedTo: target,
    sizeBytes: buf.length,
    status: "downloaded",
  };
}

export async function sendEmail({
  account,
  to,
  subject,
  body,
  cc,
  bcc,
  replyToMessageId,
  contentType = "text/plain",
  attachments = [],
}) {
  const gmail = getGmail(account);
  const from = getEmail(account);

  let threadId;
  if (replyToMessageId) {
    const orig = await gmail.users.messages.get({
      userId: "me",
      id: replyToMessageId,
      format: "metadata",
    });
    threadId = orig.data.threadId;
  }

  const { raw, attachmentSummary } = buildMessage({
    from,
    to,
    subject,
    body,
    cc,
    bcc,
    contentType,
    attachments,
    inReplyTo: replyToMessageId,
  });

  const params = { userId: "me", requestBody: { raw } };
  if (threadId) params.requestBody.threadId = threadId;

  const res = await gmail.users.messages.send(params);
  return {
    account,
    from,
    messageId: res.data.id,
    threadId: res.data.threadId,
    attachments: attachmentSummary,
    status: "sent",
  };
}

export async function createDraft({
  account,
  to,
  subject,
  body,
  cc,
  bcc,
  contentType = "text/plain",
  attachments = [],
}) {
  const gmail = getGmail(account);
  const from = getEmail(account);

  const { raw, attachmentSummary } = buildMessage({
    from,
    to,
    subject,
    body,
    cc,
    bcc,
    contentType,
    attachments,
  });

  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw } },
  });

  return {
    account,
    from,
    draftId: res.data.id,
    messageId: res.data.message?.id,
    attachments: attachmentSummary,
    status: "draft_created",
  };
}

export async function listLabels({ account }) {
  const gmail = getGmail(account);
  const res = await gmail.users.labels.list({ userId: "me" });
  return {
    account,
    labels: (res.data.labels || []).map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type,
    })),
  };
}

export async function labelMessage({
  account,
  messageId,
  labelIds,
  removeLabelIds,
}) {
  const gmail = getGmail(account);
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      addLabelIds: labelIds || [],
      removeLabelIds: removeLabelIds || [],
    },
  });
  return { account, messageId, labelsAdded: labelIds, labelsRemoved: removeLabelIds, status: "updated" };
}
