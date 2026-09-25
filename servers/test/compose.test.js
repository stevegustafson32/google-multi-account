import { test } from "node:test";
import assert from "node:assert/strict";
import {
  replyRecipients,
  replySubject,
  threadingHeaders,
  assertThreadingIntent,
  withQuote,
} from "../compose.js";
import { walkAttachmentParts } from "../attachments.js";

const own = new Set(["steve@wuunderfund.com", "stevegustafson@gmail.com"]);

test("reply to someone else goes to Reply-To, else From", () => {
  const h = { from: "Manuel <manuel@wf.com>", to: "steve@wuunderfund.com", "reply-to": "list@wf.com" };
  assert.deepEqual(replyRecipients(h, own, false), { to: ["list@wf.com"], cc: [] });
  delete h["reply-to"];
  assert.deepEqual(replyRecipients(h, own, false), { to: ["Manuel <manuel@wf.com>"], cc: [] });
});

test("reply-all drops me, dedupes case-insensitively, keeps To out of Cc", () => {
  const h = {
    from: "Andrew <Andrew@thread.bank>",
    to: "Steve <STEVE@wuunderfund.com>, zach@thread.bank",
    cc: "andrew@thread.bank, \"Blosh, Elizabeth\" <e@thread.bank>, stevegustafson@gmail.com",
  };
  const r = replyRecipients(h, own, true);
  assert.deepEqual(r.to, ["Andrew <Andrew@thread.bank>"]);
  assert.deepEqual(r.cc, ["zach@thread.bank", '"Blosh, Elizabeth" <e@thread.bank>']);
});

test("following up on my own sent message goes back to the original recipients", () => {
  const h = { from: "Steve <steve@wuunderfund.com>", to: "manuel@wf.com", cc: "julia@x.com" };
  assert.deepEqual(replyRecipients(h, own, false), { to: ["manuel@wf.com"], cc: [] });
  assert.deepEqual(replyRecipients(h, own, true), { to: ["manuel@wf.com"], cc: ["julia@x.com"] });
});

test("subject gets one Re: and keeps foreign prefixes", () => {
  assert.equal(replySubject("Thread diligence"), "Re: Thread diligence");
  assert.equal(replySubject("RE: Thread diligence"), "RE: Thread diligence");
  assert.equal(replySubject("AW: Angebot"), "AW: Angebot");
  assert.equal(replySubject("Fwd: deck"), "Re: Fwd: deck");
  assert.equal(replySubject("Reminder: call"), "Re: Reminder: call");
});

test("threading headers chain References and survive a missing Message-ID", () => {
  assert.deepEqual(threadingHeaders({ "message-id": "<b@x>", references: "<r@x>\r\n <a@x>" }), {
    inReplyTo: "<b@x>",
    references: ["<r@x>", "<a@x>", "<b@x>"],
  });
  assert.deepEqual(threadingHeaders({}), { inReplyTo: undefined, references: [] });
});

test("Re: without a reply target is rejected; escapes work", () => {
  assert.throws(() => assertThreadingIntent({ subject: "Re: vendor policy" }), /reply_to_email/);
  assert.throws(() => assertThreadingIntent({ subject: "AW: x" }), /newThread/);
  assert.doesNotThrow(() => assertThreadingIntent({ subject: "Re: x", newThread: true }));
  assert.doesNotThrow(() => assertThreadingIntent({ subject: "Re: x", replyToMessageId: "abc" }));
  assert.doesNotThrow(() => assertThreadingIntent({ subject: "Fwd: deck" }));
  assert.doesNotThrow(() => assertThreadingIntent({ subject: "Reminder: call" }));
});

test("quote: plain uses > lines, html uses gmail_quote and escapes", () => {
  const h = { date: "Tue, 22 Sep 2026", from: "Manuel <m@wf.com>" };
  const plain = withQuote("Here you go.", "text/plain", h, "line1\nline2");
  assert.match(plain, /Here you go\.\n\nOn Tue, 22 Sep 2026, Manuel <m@wf.com> wrote:\n> line1\n> line2$/);
  const html = withQuote("<p>Hi</p>", "text/html", h, "<script>x</script>");
  assert.match(html, /class="gmail_quote"/);
  assert.ok(!html.includes("<script>"));
});

test("attachment walker keeps inline-data parts and flags inline images", () => {
  const payload = {
    parts: [
      { partId: "0", mimeType: "text/plain", filename: "", body: { data: "aGk", size: 2 } },
      { partId: "1", mimeType: "image/png", filename: "image.png", headers: [{ name: "Content-Disposition", value: "inline; filename=image.png" }], body: { attachmentId: "A1", size: 900 } },
      { partId: "2", mimeType: "text/csv", filename: "small.csv", headers: [], body: { data: "YSxi", size: 3 } },
      { partId: "3", mimeType: "image/png", filename: "image.png", headers: [{ name: "Content-Disposition", value: "attachment" }], body: { attachmentId: "A3", size: 5000 } },
    ],
  };
  const parts = walkAttachmentParts(payload);
  assert.deepEqual(parts.map((p) => [p.partId, p.inline, p.attachmentId]), [
    ["1", true, "A1"],
    ["2", false, null],
    ["3", false, "A3"],
  ]);
});
