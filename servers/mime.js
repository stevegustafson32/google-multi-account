/**
 * mime.js — RFC 5322 message construction for Gmail send/draft.
 *
 * Gmail's API takes a base64url-encoded raw message. Without attachments that's
 * a single part; with them it's multipart/mixed, so this module builds both and
 * the callers in gmail.js don't have to care which.
 */

import fs from "fs";
import os from "os";
import path from "path";

/** Gmail rejects raw messages well before this, but base64 inflates 4/3, so cap
 *  the decoded payload and tell the caller to use Drive for anything larger. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

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

/** RFC 2047 encode a header value when it isn't plain ASCII (accents, emoji…). */
function encodeHeader(value) {
  const str = String(value ?? "");
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, "utf-8").toString("base64")}?=`;
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

/**
 * Build a base64url raw message.
 * Returns { raw, attachmentSummary } — the summary is echoed back to the caller
 * so the tool result states exactly what got attached.
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
  inReplyTo,
}) {
  const bodyMime = contentType === "text/html" ? "text/html" : "text/plain";
  const files = attachments.length ? loadAttachments(attachments) : [];

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
  ];
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${inReplyTo}`);
  }

  let message;

  if (files.length === 0) {
    headers.push(`Content-Type: ${bodyMime}; charset=utf-8`);
    message = Buffer.from(headers.join("\r\n") + "\r\n\r\n" + body, "utf-8");
  } else {
    const boundary = `----gmm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

    const parts = [
      `--${boundary}`,
      `Content-Type: ${bodyMime}; charset=utf-8`,
      "Content-Transfer-Encoding: 7bit",
      "",
      body,
    ];

    for (const f of files) {
      parts.push(
        `--${boundary}`,
        `Content-Type: ${f.mimeType}; name="${encodeHeader(f.filename)}"`,
        `Content-Disposition: attachment; filename="${encodeHeader(f.filename)}"`,
        "Content-Transfer-Encoding: base64",
        "",
        wrap76(f.content.toString("base64"))
      );
    }

    parts.push(`--${boundary}--`, "");
    message = Buffer.from(headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n"), "utf-8");
  }

  return {
    raw: base64url(message),
    attachmentSummary: files.map((f) => ({
      filename: f.filename,
      mimeType: f.mimeType,
      sizeBytes: f.size,
    })),
  };
}
