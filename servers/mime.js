/**
 * mime.js — RFC 5322 message construction for Gmail send/draft.
 *
 * Gmail's API takes the raw message bytes. Without attachments that's a single
 * part; with them it's multipart/mixed, so this module builds both and the
 * callers in gmail.js don't have to care which.
 *
 * v0.8.0:
 *  - Every attachment part carries a distinct X-Attachment-Id / Content-ID in
 *    Gmail's own "f_<id>" shape. Without them, Gmail web stamps `Content-ID: <>`
 *    on every part when an API draft is sent from the browser, and Apple Mail
 *    collapses parts with identical Content-IDs — recipients saw one attachment
 *    of two (Thread diligence, 2026-09-22).
 *  - Bodies are quoted-printable, not raw UTF-8 declared as 7bit.
 *  - Filenames use RFC 2231 (filename*=) with an escaped ASCII fallback.
 *  - Address headers are parsed, and non-ASCII display names RFC 2047 encoded.
 *  - Returns the raw Buffer so gmail.js can use media upload (no ~5MB JSON cap).
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

/** Gmail refuses to deliver anything over 25MB *encoded*; base64 inflates 4/3,
 *  so 18MB decoded leaves room for the body and headers. Past that, use Drive. */
export const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

const QP_LINE_MAX = 76;
const ATTACHMENT_ID_CHARS = 10;
const BOUNDARY_CHARS = 24;
const MAX_REFERENCES = 20;

const MIME_TYPES = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

export function guessMime(filename) {
  return MIME_TYPES[path.extname(filename).toLowerCase()] || "application/octet-stream";
}

function isAscii(str) {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(str);
}

function randomToken(length) {
  return crypto.randomBytes(length).toString("hex").slice(0, length);
}

/** RFC 2047 encode a header value when it isn't plain ASCII (accents, emoji…). */
export function encodeHeader(value) {
  const str = String(value ?? "");
  if (isAscii(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, "utf-8").toString("base64")}?=`;
}

/**
 * Split an address list on commas that sit outside quotes and angle brackets,
 * so `"Doe, John" <j@x.com>, a@y.com` is two addresses, not three.
 * Accepts a string or an array of strings.
 */
export function splitAddressList(value) {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.flatMap(splitAddressList);

  const out = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;
  for (const ch of String(value)) {
    if (ch === '"' && !inAngle) inQuotes = !inQuotes;
    else if (ch === "<" && !inQuotes) inAngle = true;
    else if (ch === ">" && !inQuotes) inAngle = false;

    if (ch === "," && !inQuotes && !inAngle) {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Pull the bare mailbox out of `Name <a@b.com>` or `a@b.com`, lowercased. */
export function bareAddress(address) {
  const m = String(address).match(/<([^>]+)>/);
  return (m ? m[1] : String(address)).trim().toLowerCase();
}

/** Format one address so a non-ASCII or comma-bearing display name survives. */
function formatAddress(address) {
  const m = address.match(/^(.*?)\s*<([^>]+)>$/);
  if (!m) return address;
  const name = m[1].trim().replace(/^"(.*)"$/, "$1");
  if (!name) return `<${m[2]}>`;
  if (!isAscii(name)) return `${encodeHeader(name)} <${m[2]}>`;
  if (/[",;:<>@()[\]\\]/.test(name)) {
    return `"${name.replace(/(["\\])/g, "\\$1")}" <${m[2]}>`;
  }
  return `${name} <${m[2]}>`;
}

export function formatAddressList(value) {
  return splitAddressList(value).map(formatAddress).join(", ");
}

/** Quoted-printable encode one line (no line breaks inside), soft-wrapped at 76. */
function encodeQpLine(line) {
  const bytes = Buffer.from(line, "utf-8");
  let out = "";
  let current = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const isLast = i === bytes.length - 1;
    const printable = b >= 33 && b <= 126 && b !== 61;
    const safeSpace = (b === 32 || b === 9) && !isLast;
    const token = printable || safeSpace
      ? String.fromCharCode(b)
      : `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
    // Leave one column for the "=" soft break.
    if (current.length + token.length > QP_LINE_MAX - 1) {
      out += `${current}=\r\n`;
      current = "";
    }
    current += token;
  }
  return out + current;
}

export function encodeQuotedPrintable(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(encodeQpLine)
    .join("\r\n");
}

function wrap76(b64) {
  return b64.replace(/(.{76})/g, "$1\r\n");
}

function base64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** ASCII-only, quote-safe filename for the legacy filename= / name= params. */
function asciiFilename(name) {
  return name
    .replace(/[\r\n]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/(["\\])/g, "\\$1");
}

/** RFC 2231 extended value: UTF-8''percent-encoded. */
function rfc2231(name) {
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `UTF-8''${encoded}`;
}

/** Fold a list of message-ids one per line so the header stays under 998. */
export function foldReferences(ids) {
  const list = ids.filter(Boolean);
  // Keep the thread root plus the most recent ids; that is what clients use.
  const trimmed = list.length > MAX_REFERENCES
    ? [list[0], ...list.slice(-(MAX_REFERENCES - 1))]
    : list;
  return trimmed.join("\r\n ");
}

/**
 * Read the attachment paths off disk and validate them up front, so a bad path
 * fails before we've sent a half-formed message.
 */
export function loadAttachments(paths = []) {
  const files = [];
  let total = 0;

  for (const raw of paths) {
    // os.homedir() rather than process.env.HOME — HOME is unset on Windows,
    // where the equivalent is USERPROFILE.
    const filePath = raw.startsWith("~")
      ? path.join(os.homedir(), raw.slice(1))
      : path.resolve(raw);

    if (!fs.existsSync(filePath)) throw new Error(`Attachment not found: ${filePath}`);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) throw new Error(`Attachment is a directory, not a file: ${filePath}`);

    total += stat.size;
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachments exceed ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB ` +
          `(${(total / 1024 / 1024).toFixed(1)}MB so far). Upload to Drive with ` +
          `drive_upload and send the link instead.`
      );
    }

    files.push({
      filename: path.basename(filePath),
      mimeType: guessMime(filePath),
      content: fs.readFileSync(filePath),
      size: stat.size,
      path: filePath,
    });
  }

  return files;
}

/** Headers for one attachment part, in the shape Gmail itself emits. */
function attachmentPartHeaders(file) {
  const id = `f_${randomToken(ATTACHMENT_ID_CHARS)}`;
  const nameParam = isAscii(file.filename)
    ? `"${asciiFilename(file.filename)}"`
    : `"${encodeHeader(file.filename)}"`;
  return [
    `Content-Type: ${file.mimeType}; name=${nameParam}`,
    `Content-Disposition: attachment; filename="${asciiFilename(file.filename)}"; ` +
      `filename*=${rfc2231(file.filename)}`,
    "Content-Transfer-Encoding: base64",
    `X-Attachment-Id: ${id}`,
    `Content-ID: <${id}>`,
  ];
}

function buildHeaders({ from, to, subject, cc, bcc, inReplyTo, references }) {
  const headers = [
    `From: ${formatAddressList(from)}`,
    `To: ${formatAddressList(to)}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
  ];
  if (splitAddressList(cc).length) headers.push(`Cc: ${formatAddressList(cc)}`);
  if (splitAddressList(bcc).length) headers.push(`Bcc: ${formatAddressList(bcc)}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  const refs = references?.length ? references : inReplyTo ? [inReplyTo] : [];
  if (refs.length) headers.push(`References: ${foldReferences(refs)}`);
  return headers;
}

/**
 * Build the message. Returns { mime, raw, attachmentSummary }:
 *   mime — the RFC 5322 bytes (for media upload)
 *   raw  — the same, base64url (kept for callers that post JSON)
 * The summary is echoed back so the tool result states exactly what got attached.
 * preloadedAttachments ({filename, mimeType, content, size}) lets update_draft
 * carry forward attachments already on a draft without a local file.
 */
export function buildMessage({
  from,
  to,
  subject,
  body,
  cc,
  bcc,
  contentType = "text/plain",
  attachments = [],
  preloadedAttachments = [],
  inReplyTo,
  references,
}) {
  const bodyMime = contentType === "text/html" ? "text/html" : "text/plain";
  const files = [
    ...(attachments.length ? loadAttachments(attachments) : []),
    ...preloadedAttachments,
  ];
  const headers = buildHeaders({ from, to, subject, cc, bcc, inReplyTo, references });
  const bodyHeaders = [
    `Content-Type: ${bodyMime}; charset=UTF-8`,
    "Content-Transfer-Encoding: quoted-printable",
  ];
  const encodedBody = encodeQuotedPrintable(body);

  let text;
  if (files.length === 0) {
    text = [...headers, ...bodyHeaders].join("\r\n") + "\r\n\r\n" + encodedBody + "\r\n";
  } else {
    const boundary = `gmm_${randomToken(BOUNDARY_CHARS)}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

    const parts = [`--${boundary}`, ...bodyHeaders, "", encodedBody];
    for (const f of files) {
      parts.push(
        `--${boundary}`,
        ...attachmentPartHeaders(f),
        "",
        wrap76(f.content.toString("base64"))
      );
    }
    parts.push(`--${boundary}--`, "");
    text = headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n");
  }

  const mime = Buffer.from(text, "utf-8");
  return {
    mime,
    raw: base64url(mime),
    attachmentSummary: files.map((f) => ({
      filename: f.filename,
      mimeType: f.mimeType,
      sizeBytes: f.size,
    })),
  };
}
