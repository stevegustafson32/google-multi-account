/**
 * drive.js — Google Drive operations for any configured account.
 *
 * The point of this module is the `account` parameter: the built-in Drive
 * connector is bound to one Google identity, so a file that lives in a personal
 * Drive is invisible to a work login and vice versa. Every function here takes
 * a label ("personal" / "work") and acts as that identity.
 *
 * Folder and file arguments accept either a bare ID or a pasted Drive URL —
 * copying the URL out of the browser is what people actually do.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { getDrive, getEmail } from "./auth.js";
import { guessMime } from "./mime.js";

/** Google-native types can't be downloaded raw; they're exported to a real format. */
const EXPORT_DEFAULTS = {
  "application/vnd.google-apps.document":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.google-apps.spreadsheet":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.google-apps.presentation":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.google-apps.drawing": "image/png",
  "application/vnd.google-apps.script": "application/vnd.google-apps.script+json",
};

const EXPORT_EXTENSIONS = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/markdown": ".md",
  "text/html": ".html",
  "image/png": ".png",
};

const CONVERT_TARGETS = {
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: "application/vnd.google-apps.presentation",
};

const FIELDS =
  "id,name,mimeType,size,modifiedTime,createdTime,webViewLink,parents,owners(emailAddress),trashed";

/** Shared drives are opt-in on every v3 call; Workspace accounts need them. */
const ALL_DRIVES = { supportsAllDrives: true, includeItemsFromAllDrives: true };

/**
 * Accept a raw ID or any Drive URL shape:
 *   .../folders/<id>   .../file/d/<id>/view   ...?id=<id>   /open?id=<id>
 */
export function parseDriveId(input) {
  if (!input) return input;
  const str = String(input).trim();
  if (!str.includes("/") && !str.includes("?")) return str;

  const patterns = [
    /\/folders\/([a-zA-Z0-9_-]+)/,
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /\/document\/d\/([a-zA-Z0-9_-]+)/,
    /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/,
    /\/presentation\/d\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
  ];
  for (const re of patterns) {
    const m = str.match(re);
    if (m) return m[1];
  }
  return str;
}

// os.homedir() rather than process.env.HOME — HOME is unset on Windows.
function expandPath(p) {
  if (!p) return p;
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
}

function shape(file, account) {
  return {
    account,
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.size ? Number(file.size) : undefined,
    modifiedTime: file.modifiedTime,
    owner: file.owners?.[0]?.emailAddress,
    webViewLink: file.webViewLink,
    parents: file.parents,
  };
}

/**
 * Search one account's Drive. `nameContains` is the everyday case; `rawQuery`
 * takes full Drive query syntax for anything more specific.
 */
export async function driveSearch({
  account,
  nameContains,
  fullText,
  rawQuery,
  folderId,
  mimeType,
  maxResults = 25,
  includeTrashed = false,
}) {
  const drive = getDrive(account);
  const clauses = [];

  if (rawQuery) {
    clauses.push(`(${rawQuery})`);
  } else {
    if (nameContains) clauses.push(`name contains '${nameContains.replace(/'/g, "\\'")}'`);
    if (fullText) clauses.push(`fullText contains '${fullText.replace(/'/g, "\\'")}'`);
    if (mimeType) clauses.push(`mimeType = '${mimeType}'`);
  }
  if (folderId) clauses.push(`'${parseDriveId(folderId)}' in parents`);
  if (!includeTrashed) clauses.push("trashed = false");

  const res = await drive.files.list({
    q: clauses.join(" and ") || undefined,
    pageSize: Math.min(maxResults, 100),
    fields: `files(${FIELDS}),nextPageToken`,
    orderBy: "modifiedTime desc",
    ...ALL_DRIVES,
  });

  return {
    account,
    accountEmail: getEmail(account),
    query: clauses.join(" and "),
    count: (res.data.files || []).length,
    files: (res.data.files || []).map((f) => shape(f, account)),
  };
}

export async function driveListFolder({ account, folderId, maxResults = 100 }) {
  const id = parseDriveId(folderId);
  const drive = getDrive(account);

  const meta = await drive.files.get({ fileId: id, fields: FIELDS, ...ALL_DRIVES });
  const res = await drive.files.list({
    q: `'${id}' in parents and trashed = false`,
    pageSize: Math.min(maxResults, 200),
    fields: `files(${FIELDS})`,
    orderBy: "folder,name",
    ...ALL_DRIVES,
  });

  return {
    account,
    accountEmail: getEmail(account),
    folder: { id: meta.data.id, name: meta.data.name, webViewLink: meta.data.webViewLink },
    count: (res.data.files || []).length,
    files: (res.data.files || []).map((f) => shape(f, account)),
  };
}

/** Upload a local file. `convertTo` turns it into a native Google Doc/Sheet/Slides. */
export async function driveUpload({
  account,
  filePath,
  folderId,
  name,
  mimeType,
  convertTo = "none",
}) {
  const local = expandPath(filePath);
  if (!fs.existsSync(local)) throw new Error(`File not found: ${local}`);
  const stat = fs.statSync(local);
  if (stat.isDirectory()) throw new Error(`Path is a directory, not a file: ${local}`);

  const drive = getDrive(account);
  const sourceMime = mimeType || guessMime(local);

  const requestBody = { name: name || path.basename(local) };
  if (folderId) requestBody.parents = [parseDriveId(folderId)];
  if (convertTo !== "none") {
    const target = CONVERT_TARGETS[convertTo];
    if (!target) throw new Error(`Unknown convertTo: ${convertTo}`);
    requestBody.mimeType = target;
  }

  const res = await drive.files.create({
    requestBody,
    media: { mimeType: sourceMime, body: fs.createReadStream(local) },
    fields: FIELDS,
    ...ALL_DRIVES,
  });

  return {
    ...shape(res.data, account),
    accountEmail: getEmail(account),
    uploadedFrom: local,
    sizeBytesLocal: stat.size,
    status: "uploaded",
  };
}

/** Download to disk. Google-native files are exported (default .docx/.xlsx/.pptx). */
export async function driveDownload({ account, fileId, destPath, exportMimeType }) {
  const id = parseDriveId(fileId);
  const drive = getDrive(account);

  const meta = await drive.files.get({ fileId: id, fields: FIELDS, ...ALL_DRIVES });
  const isNative = meta.data.mimeType?.startsWith("application/vnd.google-apps");
  const exportMime = isNative
    ? exportMimeType || EXPORT_DEFAULTS[meta.data.mimeType] || "application/pdf"
    : null;

  let target = expandPath(destPath || path.join(os.homedir(), "Downloads"));
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    const ext = exportMime ? EXPORT_EXTENSIONS[exportMime] || "" : "";
    const base = meta.data.name.endsWith(ext) ? meta.data.name : meta.data.name + ext;
    target = path.join(target, base);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const res = exportMime
    ? await drive.files.export({ fileId: id, mimeType: exportMime }, { responseType: "arraybuffer" })
    : await drive.files.get(
        { fileId: id, alt: "media", ...ALL_DRIVES },
        { responseType: "arraybuffer" }
      );

  const buf = Buffer.from(res.data);
  fs.writeFileSync(target, buf);

  return {
    account,
    id,
    name: meta.data.name,
    savedTo: target,
    sizeBytes: buf.length,
    exportedAs: exportMime || meta.data.mimeType,
    status: "downloaded",
  };
}

export async function driveCreateFolder({ account, name, parentId }) {
  const drive = getDrive(account);
  const requestBody = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) requestBody.parents = [parseDriveId(parentId)];

  const res = await drive.files.create({ requestBody, fields: FIELDS, ...ALL_DRIVES });
  return { ...shape(res.data, account), accountEmail: getEmail(account), status: "created" };
}

export async function driveFileInfo({ account, fileId }) {
  const drive = getDrive(account);
  const res = await drive.files.get({
    fileId: parseDriveId(fileId),
    fields: FIELDS + ",description,shared,permissions(id,type,role,emailAddress)",
    ...ALL_DRIVES,
  });
  return {
    ...shape(res.data, account),
    accountEmail: getEmail(account),
    shared: res.data.shared,
    permissions: res.data.permissions,
  };
}

/**
 * Grant access to a file or folder. This changes who can see the user's data,
 * so it is deliberately explicit — no implicit "anyone with the link" default.
 */
export async function driveShare({ account, fileId, role = "reader", type = "user", emailAddress, sendNotification = false }) {
  if (type === "user" && !emailAddress) {
    throw new Error("emailAddress is required when type is 'user'");
  }
  const drive = getDrive(account);
  const id = parseDriveId(fileId);

  const permission = { role, type };
  if (emailAddress) permission.emailAddress = emailAddress;

  await drive.permissions.create({
    fileId: id,
    requestBody: permission,
    sendNotificationEmail: type === "user" ? sendNotification : false,
    ...ALL_DRIVES,
  });

  const meta = await drive.files.get({ fileId: id, fields: FIELDS, ...ALL_DRIVES });
  return {
    account,
    id,
    name: meta.data.name,
    webViewLink: meta.data.webViewLink,
    grantedTo: emailAddress || type,
    role,
    status: "shared",
  };
}
