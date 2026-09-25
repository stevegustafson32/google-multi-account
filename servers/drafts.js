/**
 * drafts.js — draft lifecycle: list, update in place, send (v0.8.0).
 *
 * Without update_draft every revision created a new draft; the same attachment
 * set was drafted 2–5 times. drafts.update replaces the whole message, so this
 * carries forward anything the caller didn't pass — including attachments and
 * threading headers, which a naive replace silently drops.
 */

import { getGmail, getEmail, withAuthErrorHandling } from "./auth.js";
import { buildMessage } from "./mime.js";
import { sanitizeText } from "./sanitize.js";
import { walkAttachmentParts } from "./attachments.js";
import { assertHeaders, headerMap, media, threadField } from "./compose.js";

const HEADER_FIELD_MAX = 1000;
const SNIPPET_MAX = 300;

export async function listDrafts(params) {
  return withAuthErrorHandling(params.account, () => _listDrafts(params));
}
async function _listDrafts({ account, query, maxResults = 20 }) {
  const gmail = getGmail(account);
  const res = await gmail.users.drafts.list({ userId: "me", q: query, maxResults: Math.min(maxResults, 50) });
  const drafts = await Promise.all(
    (res.data.drafts || []).map(async (d) => {
      const full = await gmail.users.drafts.get({ userId: "me", id: d.id, format: "full" });
      const m = full.data.message;
      const h = headerMap(m.payload);
      const parts = walkAttachmentParts(m.payload).filter((p) => !p.inline);
      return {
        draftId: d.id,
        messageId: m.id,
        threadId: m.threadId,
        // In-Reply-To is the real signal; threadId === id breaks after an update.
        threaded: Boolean(h["in-reply-to"]),
        to: sanitizeText(h.to, { maxLen: HEADER_FIELD_MAX }),
        cc: sanitizeText(h.cc, { maxLen: HEADER_FIELD_MAX }),
        subject: sanitizeText(h.subject, { maxLen: HEADER_FIELD_MAX }),
        snippet: sanitizeText(m.snippet, { maxLen: SNIPPET_MAX }),
        attachments: parts.map((p) => p.filename),
      };
    })
  );
  return { account, drafts };
}

/** Pull an existing draft's attachments back into memory so an update keeps them. */
async function existingAttachments(gmail, message) {
  const parts = walkAttachmentParts(message.payload).filter((p) => !p.inline);
  return Promise.all(
    parts.map(async (p) => {
      const data = p._data
        ? p._data
        : (await gmail.users.messages.attachments.get({ userId: "me", messageId: message.id, id: p.attachmentId })).data.data;
      const content = Buffer.from(data, "base64url");
      return { filename: p.filename, mimeType: p.mimeType, content, size: content.length };
    })
  );
}

function currentBody(payload) {
  let plain = "";
  let html = "";
  (function walk(part) {
    if (part.filename) return;
    if (part.mimeType === "text/plain" && part.body?.data) plain += Buffer.from(part.body.data, "base64url").toString("utf-8");
    if (part.mimeType === "text/html" && part.body?.data) html += Buffer.from(part.body.data, "base64url").toString("utf-8");
    (part.parts || []).forEach(walk);
  })(payload);
  // Prefer HTML: a draft touched in Gmail web is multipart/alternative, and
  // keeping only the plain half would drop Steve's formatting.
  return html ? { body: html, contentType: "text/html" } : { body: plain, contentType: "text/plain" };
}

export async function updateDraft(params) {
  return withAuthErrorHandling(params.account, () => _updateDraft(params));
}
/**
 * Replace a draft in place. Gmail's drafts.update swaps the whole message, so
 * anything not passed is carried over from the current draft: recipients,
 * subject, body, threading headers, thread and attachments. expectedMessageId
 * is an optimistic lock — if the draft changed since you read it (e.g. Steve
 * edited it in Gmail), the update refuses instead of clobbering the edit.
 */
async function _updateDraft({
  account, draftId, expectedMessageId, to, cc, bcc, subject, body, contentType,
  attachments = [], keepExistingAttachments = true,
}) {
  assertHeaders({ to, subject, cc, bcc });
  const gmail = getGmail(account);
  const current = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "full" });
  const message = current.data.message;
  if (expectedMessageId && message.id !== expectedMessageId) {
    throw new Error(
      `Draft ${draftId} changed since you read it (now message ${message.id}, you expected ` +
        `${expectedMessageId}). Re-read it with list_drafts before updating.`
    );
  }
  const h = headerMap(message.payload);
  const existingBody = currentBody(message.payload);
  const carried = keepExistingAttachments ? await existingAttachments(gmail, message) : [];
  const { mime, attachmentSummary } = buildMessage({
    from: h.from || getEmail(account),
    to: to ?? h.to,
    cc: cc ?? h.cc,
    bcc: bcc ?? h.bcc,
    subject: subject ?? h.subject,
    body: body ?? existingBody.body,
    contentType: contentType ?? existingBody.contentType,
    attachments,
    preloadedAttachments: carried,
    inReplyTo: h["in-reply-to"],
    references: (h.references || "").split(/\s+/).filter(Boolean),
  });
  const res = await gmail.users.drafts.update({
    userId: "me",
    id: draftId,
    requestBody: { id: draftId, message: threadField(message.threadId) },
    media: media(mime),
  });
  return {
    account, draftId, messageId: res.data.message?.id, threadId: res.data.message?.threadId,
    attachments: attachmentSummary, status: "draft_updated",
  };
}

export async function sendDraft(params) {
  return withAuthErrorHandling(params.account, () => _sendDraft(params));
}
/** Send through the API so the MIME we built ships as-is (no Gmail web rewrite). */
async function _sendDraft({ account, draftId }) {
  const gmail = getGmail(account);
  const res = await gmail.users.drafts.send({ userId: "me", requestBody: { id: draftId } });
  return { account, draftId, messageId: res.data.id, threadId: res.data.threadId, status: "sent" };
}
