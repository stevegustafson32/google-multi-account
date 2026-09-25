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
 *
 * v0.5.0:
 *  - send/draft accept local file attachments; message construction moved to
 *    mime.js (multipart/mixed). The CRLF guards and Message-ID threading above
 *    still run first — attachments changed the body, not the header rules.
 *  - Threads report an attachments array; download_attachment writes to disk.
 *
 * v0.8.0:
 *  - Outbound mail moved to compose.js / drafts.js, attachment reads to
 *    attachments.js. This file keeps search, thread reads and labels.
 */

import {
  getGmail,
  getEmail,
  resolveAccounts,
  withAuthErrorHandling,
} from "./auth.js";
import { sanitizeText, sanitizeHtml, wrapUntrusted } from "./sanitize.js";
import { walkAttachmentParts, describeParts } from "./attachments.js";

const HEADER_FIELD_MAX = 1000;
const SNIPPET_MAX = 2000;
const BODY_MAX = 5000;
const THREAD_MAX_MESSAGES = 10;

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

export async function getThread(params) {
  return withAuthErrorHandling(params.account, () => _getThread(params));
}
/**
 * v0.8.0: long threads overflowed the model's context (51k–192k chars seen).
 * Return the newest maxMessages (chronological order kept) and cap each body.
 */
async function _getThread({ account, threadId, maxMessages = THREAD_MAX_MESSAGES, bodyMax = BODY_MAX }) {
  const gmail = getGmail(account);
  const res = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });

  const all = res.data.messages || [];
  const kept = all.slice(-Math.max(1, maxMessages));
  const messages = kept.map((msg) => {
    const headers = msg.payload.headers;
    const get = (name) =>
      (headers.find((h) => h.name.toLowerCase() === name.toLowerCase()) || {}).value || "";

    // Collect plain and html parts separately, prefer plain regardless of
    // tree order. Named parts are attachments, not the body.
    let plain = "";
    let html = "";
    function collectParts(part) {
      if (!part.filename && part.mimeType === "text/plain" && part.body?.data) {
        plain += Buffer.from(part.body.data, "base64").toString("utf-8");
      } else if (!part.filename && part.mimeType === "text/html" && part.body?.data) {
        html += Buffer.from(part.body.data, "base64").toString("utf-8");
      }
      if (part.parts) part.parts.forEach(collectParts);
    }
    collectParts(msg.payload);

    const body = plain
      ? sanitizeText(plain, { maxLen: bodyMax })
      : sanitizeHtml(html, { maxLen: bodyMax });

    return {
      id: msg.id,
      isDraft: (msg.labelIds || []).includes("DRAFT"),
      from: sanitizeText(get("From"), { maxLen: HEADER_FIELD_MAX }),
      to: sanitizeText(get("To"), { maxLen: HEADER_FIELD_MAX }),
      cc: sanitizeText(get("Cc"), { maxLen: HEADER_FIELD_MAX }),
      date: get("Date"),
      subject: sanitizeText(get("Subject"), { maxLen: HEADER_FIELD_MAX }),
      body: wrapUntrusted(body),
      // Same walker as list_attachments, so partIds line up for downloads.
      attachments: describeParts(walkAttachmentParts(msg.payload)),
    };
  });

  return {
    account,
    threadId,
    totalMessages: all.length,
    returnedMessages: messages.length,
    truncated: messages.length < all.length,
    messages,
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
