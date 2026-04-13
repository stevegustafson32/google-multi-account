/**
 * gmail.js — Gmail operations for any configured account
 */

import { getGmail, getEmail, resolveAccounts } from "./auth.js";

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
    };
  });

  return { account, threadId, messages };
}

export async function sendEmail({
  account,
  to,
  subject,
  body,
  cc,
  bcc,
  replyToMessageId,
}) {
  const gmail = getGmail(account);
  const from = getEmail(account);

  let headers = `From: ${from}\nTo: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n`;
  if (cc) headers += `Cc: ${cc}\n`;
  if (bcc) headers += `Bcc: ${bcc}\n`;

  let threadId;
  if (replyToMessageId) {
    headers += `In-Reply-To: ${replyToMessageId}\nReferences: ${replyToMessageId}\n`;
    const orig = await gmail.users.messages.get({
      userId: "me",
      id: replyToMessageId,
      format: "metadata",
    });
    threadId = orig.data.threadId;
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

export async function createDraft({ account, to, subject, body, cc }) {
  const gmail = getGmail(account);
  const from = getEmail(account);

  let headers = `From: ${from}\nTo: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n`;
  if (cc) headers += `Cc: ${cc}\n`;

  const raw = Buffer.from(headers + "\n" + body)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw } },
  });

  return {
    account,
    from,
    draftId: res.data.id,
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
