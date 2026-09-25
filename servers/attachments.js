/**
 * attachments.js — reading attachments off received mail (v0.8.0).
 *
 * Split out of gmail.js. Fixes over v0.7:
 *  - One walker feeds list_attachments, get_email_thread and downloads, so they
 *    always report the same set. Small attachments Gmail stores inline
 *    (body.data, no attachmentId) are included instead of silently missing.
 *  - partId is the selector. Filenames repeat (three "image.png" parts) and
 *    Gmail regenerates attachmentId on every fetch, so neither is a stable key.
 *  - Downloads never overwrite: "file.pdf" → "file (1).pdf".
 *  - download_all_attachments saves every real attachment in one call.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { getGmail, withAuthErrorHandling } from "./auth.js";
import { sanitizeText } from "./sanitize.js";

const FILENAME_MAX = 256;

function dispositionOf(part) {
  const header = (part.headers || []).find(
    (h) => h.name?.toLowerCase() === "content-disposition"
  );
  return header?.value || "";
}

/**
 * Walk a payload tree for every part that carries a filename. Inline images
 * (signature logos) are reported with inline:true rather than dropped — a
 * logo and a contract look different to the caller.
 */
export function walkAttachmentParts(payload, found = []) {
  if (!payload) return found;
  if (payload.filename && payload.body && (payload.body.attachmentId || payload.body.data)) {
    found.push({
      partId: payload.partId,
      filename: payload.filename,
      mimeType: payload.mimeType,
      sizeBytes: payload.body.size || 0,
      attachmentId: payload.body.attachmentId || null,
      inline: /^\s*inline/i.test(dispositionOf(payload)),
      _data: payload.body.data || null,
    });
  }
  if (payload.parts) payload.parts.forEach((p) => walkAttachmentParts(p, found));
  return found;
}

/** The public shape: sender-controlled filename scrubbed, raw data dropped. */
export function describeParts(parts) {
  return parts.map(({ _data, ...rest }) => ({
    ...rest,
    filename: sanitizeText(rest.filename, { maxLen: FILENAME_MAX }),
  }));
}

async function fetchParts(gmail, messageId) {
  const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  return walkAttachmentParts(res.data.payload);
}

/**
 * Pick one part. partId wins, then attachmentId, then an exact filename that
 * must be unambiguous. Nothing given → the first non-inline attachment.
 */
function selectPart(parts, { partId, attachmentId, filename }, messageId) {
  let match;
  if (partId) {
    match = parts.find((p) => p.partId === partId);
  } else if (attachmentId) {
    match = parts.find((p) => p.attachmentId === attachmentId);
  } else if (filename) {
    const named = parts.filter((p) => p.filename === filename);
    if (named.length > 1) {
      throw new Error(
        `${named.length} attachments named "${filename}" on message ${messageId}. ` +
          `Pass partId instead: ${named.map((p) => p.partId).join(", ")}`
      );
    }
    match = named[0];
  } else {
    match = parts.find((p) => !p.inline) || parts[0];
  }
  if (!match) {
    const want = partId || attachmentId || filename;
    throw new Error(
      want
        ? `No attachment matching "${want}" on message ${messageId}`
        : `Message ${messageId} has no attachments`
    );
  }
  return match;
}

async function partBytes(gmail, messageId, part) {
  if (part._data) return Buffer.from(part._data, "base64url");
  const res = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: part.attachmentId,
  });
  return Buffer.from(res.data.data, "base64url");
}

function expandHome(p) {
  // os.homedir() rather than process.env.HOME — HOME is unset on Windows.
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
}

/** "name.pdf" → "name (1).pdf" until the path is free. */
function freePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let n = 1; fs.existsSync(candidate); n++) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

/** Resolve where a part lands. A directory (existing, or ending in /) gets a safe name. */
function targetFor(destPath, part) {
  const dest = destPath ? expandHome(destPath) : path.join(os.homedir(), "Downloads");
  const looksLikeDir =
    !destPath ||
    /[\\/]$/.test(destPath) ||
    (fs.existsSync(dest) && fs.statSync(dest).isDirectory());
  if (!looksLikeDir) return dest;
  // Strip any path separators a hostile sender put in the filename so the
  // write can't escape the destination directory.
  const safe = path.basename(part.filename || `attachment-${part.partId}`);
  fs.mkdirSync(dest, { recursive: true });
  return freePath(dest, safe);
}

function writeBytes(target, buf) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
}

export async function listAttachments(params) {
  return withAuthErrorHandling(params.account, () => _listAttachments(params));
}
async function _listAttachments({ account, messageId }) {
  const parts = await fetchParts(getGmail(account), messageId);
  return { account, messageId, attachments: describeParts(parts) };
}

export async function getAttachment(params) {
  return withAuthErrorHandling(params.account, () => _getAttachment(params));
}
async function _getAttachment({ account, messageId, partId, attachmentId, filename }) {
  const gmail = getGmail(account);
  const part = selectPart(await fetchParts(gmail, messageId), { partId, attachmentId, filename }, messageId);
  const buf = await partBytes(gmail, messageId, part);
  return {
    account,
    messageId,
    partId: part.partId,
    filename: sanitizeText(part.filename, { maxLen: FILENAME_MAX }),
    size: buf.length,
    data: buf.toString("base64url"),
  };
}

export async function downloadAttachment(params) {
  return withAuthErrorHandling(params.account, () => _downloadAttachment(params));
}
/**
 * Save an attachment to disk. get_attachment returns base64 into the model's
 * context, which is the wrong shape for anything large or binary — this writes
 * straight to a file and returns only the path.
 */
async function _downloadAttachment({ account, messageId, partId, attachmentId, filename, destPath }) {
  const gmail = getGmail(account);
  const part = selectPart(await fetchParts(gmail, messageId), { partId, attachmentId, filename }, messageId);
  const buf = await partBytes(gmail, messageId, part);
  const target = targetFor(destPath, part);
  writeBytes(target, buf);
  return {
    account,
    messageId,
    partId: part.partId,
    filename: sanitizeText(part.filename, { maxLen: FILENAME_MAX }),
    savedTo: target,
    sizeBytes: buf.length,
    status: "downloaded",
  };
}

export async function downloadAllAttachments(params) {
  return withAuthErrorHandling(params.account, () => _downloadAllAttachments(params));
}
async function _downloadAllAttachments({ account, messageId, destDir, includeInline = false }) {
  const gmail = getGmail(account);
  const parts = (await fetchParts(gmail, messageId)).filter((p) => includeInline || !p.inline);
  const dir = destDir ? `${destDir.replace(/[\\/]$/, "")}/` : undefined;
  const saved = [];
  // Sequential on purpose: freePath must see the previous write to pick "(1)".
  for (const part of parts) {
    const buf = await partBytes(gmail, messageId, part);
    const target = targetFor(dir, part);
    writeBytes(target, buf);
    saved.push({
      partId: part.partId,
      filename: sanitizeText(part.filename, { maxLen: FILENAME_MAX }),
      savedTo: target,
      sizeBytes: buf.length,
    });
  }
  return { account, messageId, count: saved.length, saved, status: "downloaded" };
}
