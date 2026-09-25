import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { simpleParser } from "mailparser";
import {
  buildMessage,
  splitAddressList,
  formatAddressList,
  encodeQuotedPrintable,
  foldReferences,
} from "../mime.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gmm-test-"));
function fixture(name, bytes) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, bytes);
  return p;
}

test("multiple attachments get distinct Content-IDs and survive byte-for-byte", async () => {
  const a = fixture("policy.docx", Buffer.from([0, 1, 2, 250, 251, 252]));
  const b = fixture("schema.xlsx", fs.readFileSync(process.execPath).subarray(0, 50000));
  const c = fixture("notes.pdf", Buffer.alloc(3000, 7));
  const { mime, attachmentSummary } = buildMessage({
    from: "steve@example.com",
    to: "manuel@example.com",
    subject: "Two docs",
    body: "Here is the pair.",
    attachments: [a, b, c],
  });
  const parsed = await simpleParser(mime);

  assert.equal(parsed.attachments.length, 3);
  assert.equal(attachmentSummary.length, 3);
  const cids = parsed.attachments.map((x) => x.cid);
  assert.ok(cids.every((cid) => /^f_[0-9a-f]{10}$/.test(cid)), `bad cids ${cids}`);
  assert.equal(new Set(cids).size, 3);
  assert.deepEqual(parsed.attachments.map((x) => x.filename), ["policy.docx", "schema.xlsx", "notes.pdf"]);
  assert.ok(parsed.attachments.every((x) => x.contentDisposition === "attachment"));
  assert.ok(parsed.attachments[1].content.equals(fs.readFileSync(b)));
  assert.ok(parsed.attachments[0].content.equals(fs.readFileSync(a)));
});

test("UTF-8 body round-trips through quoted-printable with long lines", async () => {
  const body = "Manuel — “quoted” café ✓\n" + "x".repeat(300) + " trailing \nlast=line";
  const { mime } = buildMessage({ from: "s@x.com", to: "m@x.com", subject: "Résumé ✓", body });
  const text = mime.toString("utf-8");
  assert.ok(text.split("\r\n").every((l) => l.length <= 998));
  assert.match(text, /Content-Transfer-Encoding: quoted-printable/);
  // Raw 8-bit bytes must not leak into the body.
  assert.ok(/^[\x00-\x7F]*$/.test(text), "message contains non-ASCII bytes");
  const parsed = await simpleParser(mime);
  assert.equal(parsed.text.replace(/\n$/, ""), body);
  assert.equal(parsed.subject, "Résumé ✓");
});

test("non-ASCII and quote-bearing filenames decode correctly", async () => {
  const a = fixture("Résumé “final”.pdf", Buffer.from("pdf"));
  const b = fixture('odd "name".txt', Buffer.from("txt"));
  const { mime } = buildMessage({ from: "s@x.com", to: "m@x.com", subject: "f", body: "b", attachments: [a, b] });
  const parsed = await simpleParser(mime);
  assert.deepEqual(parsed.attachments.map((x) => x.filename), ["Résumé “final”.pdf", 'odd "name".txt']);
});

test("address lists: commas in display names, arrays, non-ASCII names", async () => {
  assert.deepEqual(splitAddressList('"Doe, John" <j@x.com>, a@y.com'), ['"Doe, John" <j@x.com>', "a@y.com"]);
  assert.deepEqual(splitAddressList(["a@x.com", "b@x.com, c@x.com"]), ["a@x.com", "b@x.com", "c@x.com"]);
  assert.equal(formatAddressList('"Doe, John" <j@x.com>'), '"Doe, John" <j@x.com>');
  const { mime } = buildMessage({
    from: "s@x.com",
    to: ['"Doe, John" <j@x.com>', "José Núñez <jn@x.com>"],
    cc: [],
    subject: "s",
    body: "b",
  });
  const parsed = await simpleParser(mime);
  assert.deepEqual(parsed.to.value.map((v) => v.address), ["j@x.com", "jn@x.com"]);
  assert.deepEqual(parsed.to.value.map((v) => v.name), ["Doe, John", "José Núñez"]);
  assert.equal(parsed.cc, undefined);
});

test("References are folded and trimmed to root + recent", () => {
  const ids = Array.from({ length: 60 }, (_, i) => `<id${i}@x.com>`);
  const folded = foldReferences(ids);
  const lines = folded.split("\r\n ");
  assert.equal(lines.length, 20);
  assert.equal(lines[0], "<id0@x.com>");
  assert.equal(lines.at(-1), "<id59@x.com>");
});

test("threading headers are emitted", async () => {
  const { mime } = buildMessage({
    from: "s@x.com", to: "m@x.com", subject: "Re: x", body: "b",
    inReplyTo: "<p@x.com>", references: ["<r@x.com>", "<p@x.com>"],
  });
  const parsed = await simpleParser(mime);
  assert.equal(parsed.inReplyTo, "<p@x.com>");
  assert.deepEqual(parsed.references, ["<r@x.com>", "<p@x.com>"]);
});

test("QP encoder escapes = and trailing whitespace", () => {
  assert.equal(encodeQuotedPrintable("a=b "), "a=3Db=20");
});
