/**
 * gmail.js — Gmail operations for any configured account
 *
 * v0.4.0 hardening:
 *  - All attacker-controlled strings (snippets, subjects, From, bodies) are
 *    run through sanitize.js before being returned to the model.
 *  - Header fields are validated against CRLF injection.
 *  - In-Reply-To / References use the original message's RFC 5322 Message-ID
 *    header value (not Gmail's internal resource id).
 *  - Body extraction prefers text/plain regardless of part-tree order.
 */

import {
  getGmail,
  getEmail,
  resolveAccounts,
  withAuthErrorHandling,
} from "./auth.js";
import { sanitizeText, sanitizeHtml, wrapUntrusted } from "./sanitize.js";

const HEADER_FIELD_MAX = 1000;
const SNIPPET_MAX = 2000;
const BODY_MAX = 5000;

/**
 * Reject CRLF in any header field value to block header injection.
 * Empty / undefined passes through unchanged.
 */
function assertNoCRLF(name, value) {
  if (value == null || value === "") return value;
  if (typeof value !== "string") return value;
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `Header injection blocked: "${name}" contains CR/LF. ` +
        `Reject any tool argument that includes a newline in an email header.`
    );
  }
  return value;
}

/**
 * Fetch the original message's RFC 5322 Message-ID header so In-Reply-To /
 * References are set correctly. Returns { messageIdHeader, threadId }.
 */
async function fetchOriginalMessageRefs(gmail, messageResourceId) {
  const orig = await gmail.users.messages.get({
    userId: "me",
    id: messageResourceId,
    format: "metadata",
    metadataHeaders: ["Message-ID", "Message-Id"],
  });
  const headers = orig.data.payload?.headers || [];
  const found = headers.find((h) => h.name.toLowerCase() === "message-id");
  return {
    messageIdHeader: found?.value || null,
    threadId: orig.data.threadId,
  };
}

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
              snippet: sanitizeText(full.data.snippet, { maxLen: SNIPPET_MAX }),
              from: sanitizeText(get("From"), { maxLen: HEADER_FIELD_MAX }),
              to: sanitizeText(get("To"), { maxLen: HEADER_FIELD_MAX }),
              cc: sanitizeText(get("Cc"), { maxLen: HEADER_FIELD_MAX }),
              subject: sanitizeText(get("Subject"), { maxLen: HEADER_FIELD_MAX }),
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
  return withAuthErrorHandling(account, () => _getThread({ account, threadId }));
}
async function _getThread({ account, threadId }) {
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

    // Collect plain and html parts separately, prefer plain regardless of
    // tree order. The original code's order-dependent dedupe was a bug.
    let plain = "";
    let html = "";
    function collectParts(part) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        plain += Buffer.from(part.body.data, "base64").toString("utf-8");
      } else if (part.mimeType === "text/html" && part.body?.data) {
        html += Buffer.from(part.body.data, "base64").toString("utf-8");
      }
      if (part.parts) part.parts.forEach(collectParts);
    }
    collectParts(msg.payload);

    const body = plain
      ? sanitizeText(plain, { maxLen: BODY_MAX })
      : sanitizeHtml(html, { maxLen: BODY_MAX });

    return {
      id: msg.id,
      from: sanitizeText(get("From"), { maxLen: HEADER_FIELD_MAX }),
      to: sanitizeText(get("To"), { maxLen: HEADER_FIELD_MAX }),
      cc: sanitizeText(get("Cc"), { maxLen: HEADER_FIELD_MAX }),
      date: get("Date"),
      subject: sanitizeText(get("Subject"), { maxLen: HEADER_FIELD_MAX }),
      body: wrapUntrusted(body),
    };
  });

  return { account, threadId, messages };
}

export async function sendEmail(params) {
  return withAuthErrorHandling(params.account, () => _sendEmail(params));
}
async function _sendEmail({
  account,
  to,
  subject,
  body,
  cc,
  bcc,
  replyToMessageId,
  contentType = "text/plain",
}) {
  // Block header injection up front.
  assertNoCRLF("to", to);
  assertNoCRLF("subject", subject);
  assertNoCRLF("cc", cc);
  assertNoCRLF("bcc", bcc);

  const gmail = getGmail(account);
  const from = getEmail(account);

  const mime = contentType === "text/html" ? "text/html" : "text/plain";
  let headers = `From: ${from}\nTo: ${to}\nSubject: ${subject}\nMIME-Version: 1.0\nContent-Type: ${mime}; charset=utf-8\n`;
  if (cc) headers += `Cc: ${cc}\n`;
  if (bcc) headers += `Bcc: ${bcc}\n`;

  let threadId;
  if (replyToMessageId) {
    const refs = await fetchOriginalMessageRefs(gmail, replyToMessageId);
    if (refs.messageIdHeader) {
      headers += `In-Reply-To: ${refs.messageIdHeader}\nReferences: ${refs.messageIdHeader}\n`;
    }
    threadId = refs.threadId;
  }

  const raw = Buffer.from(headers + "\n" + body)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const params = { userId: "me", requestBody: { raw } };
  if (threadId) params.requestBody.threadId = threadId;

  const res = await gmail.users.messages.send(params);
  return {
    account,
    from,
    messageId: res.data.id,
    threadId: res.data.threadId,
    status: "sent",
  };
}

export async function createDraft(params) {
  return withAuthErrorHandling(params.account, () => _createDraft(params));
}
async function _createDraft({
  account,
  to,
  subject,
  body,
  cc,
  replyToMessageId,
  contentType = "text/plain",
}) {
  assertNoCRLF("to", to);
  assertNoCRLF("subject", subject);
  assertNoCRLF("cc", cc);

  const gmail = getGmail(account);
  const from = getEmail(account);

  const mime = contentType === "text/html" ? "text/html" : "text/plain";
  let headers = `From: ${from}\nTo: ${to}\nSubject: ${subject}\nMIME-Version: 1.0\nContent-Type: ${mime}; charset=utf-8\n`;
  if (cc) headers += `Cc: ${cc}\n`;

  let threadId;
  if (replyToMessageId) {
    const refs = await fetchOriginalMessageRefs(gmail, replyToMessageId);
    if (refs.messageIdHeader) {
      headers += `In-Reply-To: ${refs.messageIdHeader}\nReferences: ${refs.messageIdHeader}\n`;
    }
    threadId = refs.threadId;
  }

  const raw = Buffer.from(headers + "\n" + body)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const message = { raw };
  if (threadId) message.threadId = threadId;

  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message },
  });

  return {
    account,
    from,
    draftId: res.data.id,
    threadId: res.data.message?.threadId,
    status: "draft_created",
  };
}

export async function listLabels({ account }) {
  return withAuthErrorHandling(account, () => _listLabels({ account }));
}
async function _listLabels({ account }) {
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

export async function labelMessage(params) {
  return withAuthErrorHandling(params.account, () => _labelMessage(params));
}
async function _labelMessage({
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
  return {
    account,
    messageId,
    labelsAdded: labelIds,
    labelsRemoved: removeLabelIds,
    status: "updated",
  };
}

export async function listAttachments(params) {
  return withAuthErrorHandling(params.account, () => _listAttachments(params));
}
async function _listAttachments({ account, messageId }) {
  const gmail = getGmail(account);
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const attachments = [];
  function findAttachments(part) {
    if (part.filename && part.filename.length > 0 && part.body) {
      attachments.push({
        partId: part.partId,
        filename: part.filename,
        mimeType: part.mimeType,
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId || null,
      });
    }
    if (part.parts) part.parts.forEach(findAttachments);
  }
  findAttachments(res.data.payload);

  return { account, messageId, attachments };
}

export async function getAttachment(params) {
  return withAuthErrorHandling(params.account, () => _getAttachment(params));
}
async function _getAttachment({
  account,
  messageId,
  attachmentId,
  filename,
}) {
  const gmail = getGmail(account);

  if (attachmentId) {
    const res = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: attachmentId,
    });
    return {
      account,
      messageId,
      filename: filename || "attachment",
      size: res.data.size,
      data: res.data.data,
    };
  }

  const msg = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  let targetPart = null;
  function findPart(part) {
    if (part.filename === filename && part.body) {
      targetPart = part;
      return;
    }
    if (part.parts) part.parts.forEach(findPart);
  }
  findPart(msg.data.payload);

  if (!targetPart) {
    return { account, messageId, error: `Attachment "${filename}" not found` };
  }

  if (targetPart.body.data) {
    return {
      account,
      messageId,
      filename,
      size: targetPart.body.size,
      data: targetPart.body.data,
    };
  }

  const res = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: targetPart.body.attachmentId,
  });
  return {
    account,
    messageId,
    filename,
    size: res.data.size,
    data: res.data.data,
  };
}
