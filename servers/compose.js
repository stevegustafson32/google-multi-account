/**
 * compose.js — outbound mail: send, drafts, replies (v0.8.0).
 *
 * Split out of gmail.js. What changed and why:
 *  - Uploads go through Gmail's media endpoint (message/rfc822) instead of a
 *    base64 string in a JSON body, which caps out around 5MB.
 *  - reply_to_email derives recipients, subject, threading headers and the
 *    quoted history from the parent message. Before this, the model hand-built
 *    those and skipped replyToMessageId about half the time, producing 44
 *    standalone "Re:" drafts across Code + Cowork.
 *  - A "Re:" subject with no reply target is rejected unless newThread:true.
 *  - Draft list/update/send live in drafts.js.
 */

import { Readable } from "stream";
import { getGmail, getEmail, withAuthErrorHandling } from "./auth.js";
import { getAccounts } from "./config.js";
import { buildMessage, splitAddressList, bareAddress } from "./mime.js";
import { sanitizeText, sanitizeHtml } from "./sanitize.js";

const HEADER_FIELD_MAX = 1000;
const QUOTE_MAX = 20000;
const REPLY_PREFIX_RX = /^\s*(re|aw|sv|antw)\s*:/i;
const SKIP_PARENT_LABELS = ["DRAFT", "TRASH", "SPAM"];

// ── guards ─────────────────────────────────────────────────────────────

/** Reject CRLF in any header field value to block header injection. */
export function assertNoCRLF(name, value) {
  const values = Array.isArray(value) ? value : [value];
  for (const v of values) {
    if (typeof v === "string" && /[\r\n]/.test(v)) {
      throw new Error(
        `Header injection blocked: "${name}" contains CR/LF. ` +
          `Reject any tool argument that includes a newline in an email header.`
      );
    }
  }
}

export function assertHeaders({ to, subject, cc, bcc }) {
  assertNoCRLF("to", to);
  assertNoCRLF("subject", subject);
  assertNoCRLF("cc", cc);
  assertNoCRLF("bcc", bcc);
}

/**
 * A "Re:" subject with no parent message becomes a standalone thread in the
 * recipient's inbox. That's almost never intended, so fail loudly and name
 * both ways out. Fwd: is left alone — forwards start new threads by design.
 */
export function assertThreadingIntent({ subject, replyToMessageId, newThread }) {
  if (replyToMessageId || newThread) return;
  if (REPLY_PREFIX_RX.test(subject || "")) {
    throw new Error(
      `Subject "${subject}" reads as a reply, but no replyToMessageId was given, so ` +
        `Gmail would file it as a NEW thread. Use reply_to_email with the messageId ` +
        `or threadId (it fills To/Cc/Subject/threading for you), or pass newThread: true ` +
        `if a fresh thread is really what you want.`
    );
  }
}

// ── transport ──────────────────────────────────────────────────────────

export function media(mime) {
  return { mimeType: "message/rfc822", body: Readable.from(mime) };
}

export function threadField(threadId) {
  return threadId ? { threadId } : {};
}

// ── parent message + own addresses ─────────────────────────────────────

export function headerMap(payload) {
  const map = {};
  for (const h of payload?.headers || []) {
    const key = h.name.toLowerCase();
    if (!(key in map)) map[key] = h.value;
  }
  return map;
}

/** Every address that counts as "me" for this account: configured + sendAs. */
async function ownAddresses(gmail) {
  const own = new Set(getAccounts().map((a) => a.email.toLowerCase()));
  try {
    const res = await gmail.users.settings.sendAs.list({ userId: "me" });
    for (const s of res.data.sendAs || []) own.add(s.sendAsEmail.toLowerCase());
  } catch {
    // sendAs is a nicety; the configured addresses are enough to dedupe.
  }
  return own;
}

/**
 * Resolve the message being replied to. A threadId resolves to the newest
 * message that isn't a draft, trashed or spam — replying to your own pending
 * draft is never the intent.
 */
async function resolveParent(gmail, { messageId, threadId }) {
  let msg;
  if (messageId) {
    const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    msg = res.data;
  } else if (threadId) {
    const res = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
    const candidates = (res.data.messages || []).filter(
      (m) => !(m.labelIds || []).some((l) => SKIP_PARENT_LABELS.includes(l))
    );
    msg = candidates.at(-1);
    if (!msg) throw new Error(`Thread ${threadId} has no sent or received messages to reply to`);
  } else {
    throw new Error("Pass messageId or threadId to reply to");
  }
  return { msg, headers: headerMap(msg.payload) };
}

function dedupe(addresses, exclude) {
  const seen = new Set(exclude);
  const out = [];
  for (const a of addresses) {
    const key = bareAddress(a);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** Recipients for a reply, following what Gmail's own Reply / Reply all do. */
export function replyRecipients(headers, own, replyAll) {
  const fromMe = own.has(bareAddress(headers.from || ""));
  const parentTo = splitAddressList(headers.to);
  const parentCc = splitAddressList(headers.cc);

  let to;
  let cc = [];
  if (fromMe) {
    // Following up on my own message: go back to the same people.
    to = parentTo;
    if (replyAll) cc = parentCc;
  } else {
    to = splitAddressList(headers["reply-to"] || headers.from);
    if (replyAll) cc = [...parentTo, ...parentCc];
  }
  const finalTo = dedupe(to, fromMe ? [] : own);
  const finalCc = dedupe(cc, [...own, ...finalTo.map(bareAddress)]);
  return { to: finalTo, cc: finalCc };
}

/** The alias the parent was addressed to, so the reply comes from the same one. */
function replyFrom(headers, own, fallback) {
  const fromMe = bareAddress(headers.from || "");
  if (own.has(fromMe)) return fromMe;
  const addressed = [...splitAddressList(headers.to), ...splitAddressList(headers.cc)].map(bareAddress);
  return addressed.find((a) => own.has(a)) || fallback;
}

export function replySubject(subject) {
  const s = (subject || "").trim();
  return REPLY_PREFIX_RX.test(s) ? s : `Re: ${s}`;
}

export function threadingHeaders(headers) {
  const messageIdHeader = headers["message-id"] || null;
  const prior = (headers.references || "").split(/\s+/).filter(Boolean);
  const references = messageIdHeader ? [...prior, messageIdHeader] : prior;
  return { inReplyTo: messageIdHeader || undefined, references };
}

// ── quoting ────────────────────────────────────────────────────────────

function parentText(payload) {
  let plain = "";
  let html = "";
  (function walk(part) {
    if (part.mimeType === "text/plain" && part.body?.data && !part.filename) {
      plain += Buffer.from(part.body.data, "base64url").toString("utf-8");
    } else if (part.mimeType === "text/html" && part.body?.data && !part.filename) {
      html += Buffer.from(part.body.data, "base64url").toString("utf-8");
    }
    (part.parts || []).forEach(walk);
  })(payload);
  const text = plain || sanitizeHtml(html, { maxLen: QUOTE_MAX });
  return text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX)}\n[…]` : text;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Append the parent in the shape Gmail uses, so it collapses behind "…". */
export function withQuote(body, contentType, headers, text) {
  const attribution = `On ${headers.date || "an earlier date"}, ${headers.from || "the sender"} wrote:`;
  if (contentType === "text/html") {
    const quoted = escapeHtml(text).replace(/\r?\n/g, "<br>");
    return (
      `${body}<br><br><div class="gmail_quote"><div class="gmail_attr">${escapeHtml(attribution)}</div>` +
      `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">` +
      `${quoted}</blockquote></div>`
    );
  }
  const quoted = text.replace(/\r?\n/g, "\n").split("\n").map((l) => `> ${l}`).join("\n");
  return `${body}\n\n${attribution}\n${quoted}`;
}

// ── send / draft (existing tools, now media upload + guard) ─────────────

async function legacyReplyContext(gmail, replyToMessageId) {
  if (!replyToMessageId) return {};
  const { msg, headers } = await resolveParent(gmail, { messageId: replyToMessageId });
  return { threadId: msg.threadId, ...threadingHeaders(headers) };
}

export async function sendEmail(params) {
  return withAuthErrorHandling(params.account, () => _sendEmail(params));
}
async function _sendEmail({ account, to, subject, body, cc, bcc, replyToMessageId, newThread, contentType = "text/plain", attachments = [] }) {
  assertHeaders({ to, subject, cc, bcc });
  assertThreadingIntent({ subject, replyToMessageId, newThread });
  const gmail = getGmail(account);
  const from = getEmail(account);
  const ctx = await legacyReplyContext(gmail, replyToMessageId);
  const { mime, attachmentSummary } = buildMessage({
    from, to, subject, body, cc, bcc, contentType, attachments,
    inReplyTo: ctx.inReplyTo, references: ctx.references,
  });
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: threadField(ctx.threadId),
    media: media(mime),
  });
  return {
    account, from, messageId: res.data.id, threadId: res.data.threadId,
    attachments: attachmentSummary, status: "sent",
  };
}

export async function createDraft(params) {
  return withAuthErrorHandling(params.account, () => _createDraft(params));
}
async function _createDraft({ account, to, subject, body, cc, bcc, replyToMessageId, newThread, contentType = "text/plain", attachments = [] }) {
  assertHeaders({ to, subject, cc, bcc });
  assertThreadingIntent({ subject, replyToMessageId, newThread });
  const gmail = getGmail(account);
  const from = getEmail(account);
  const ctx = await legacyReplyContext(gmail, replyToMessageId);
  const { mime, attachmentSummary } = buildMessage({
    from, to, subject, body, cc, bcc, contentType, attachments,
    inReplyTo: ctx.inReplyTo, references: ctx.references,
  });
  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message: threadField(ctx.threadId) },
    media: media(mime),
  });
  return {
    account, from, draftId: res.data.id, messageId: res.data.message?.id,
    threadId: res.data.message?.threadId, attachments: attachmentSummary,
    status: "draft_created",
  };
}

// ── reply_to_email ─────────────────────────────────────────────────────

export async function replyToEmail(params) {
  return withAuthErrorHandling(params.account, () => _replyToEmail(params));
}
async function _replyToEmail({
  account, messageId, threadId, body, replyAll = false, send = false,
  cc: extraCc, bcc, attachments = [], quote = true, contentType = "text/plain",
}) {
  assertNoCRLF("cc", extraCc);
  assertNoCRLF("bcc", bcc);
  const gmail = getGmail(account);
  const { msg, headers } = await resolveParent(gmail, { messageId, threadId });
  const own = await ownAddresses(gmail);
  const recipients = replyRecipients(headers, own, replyAll);
  if (recipients.to.length === 0) {
    throw new Error(`Could not work out who to reply to on message ${msg.id} (no From/To).`);
  }
  const cc = dedupe([...recipients.cc, ...splitAddressList(extraCc)], recipients.to.map(bareAddress));
  const from = replyFrom(headers, own, getEmail(account));
  const subject = replySubject(headers.subject);
  const fullBody = quote ? withQuote(body, contentType, headers, parentText(msg.payload)) : body;
  const { mime, attachmentSummary } = buildMessage({
    from, to: recipients.to, cc, bcc, subject, body: fullBody, contentType, attachments,
    ...threadingHeaders(headers),
  });

  const common = { userId: "me", media: media(mime) };
  const res = send
    ? await gmail.users.messages.send({ ...common, requestBody: { threadId: msg.threadId } })
    : await gmail.users.drafts.create({ ...common, requestBody: { message: { threadId: msg.threadId } } });
  const message = send ? res.data : res.data.message;
  return {
    account,
    from,
    to: recipients.to.map((a) => sanitizeText(a, { maxLen: HEADER_FIELD_MAX })),
    cc: cc.map((a) => sanitizeText(a, { maxLen: HEADER_FIELD_MAX })),
    subject: sanitizeText(subject, { maxLen: HEADER_FIELD_MAX }),
    repliedTo: msg.id,
    draftId: send ? undefined : res.data.id,
    messageId: message?.id,
    threadId: message?.threadId,
    threaded: message?.threadId === msg.threadId,
    attachments: attachmentSummary,
    status: send ? "sent" : "draft_created",
  };
}
