import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { targetFor } from "../attachments.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gmm-target-"));

test("a destination folder that does not exist yet is created and gets the filename", () => {
  const folder = path.join(tmp, "reports", "incoming");
  assert.equal(fs.existsSync(folder), false);

  const target = targetFor(folder, { filename: "submarine_review.md", partId: "1" });

  assert.equal(target, path.join(folder, "submarine_review.md"));
  assert.equal(fs.statSync(folder).isDirectory(), true, "the destination must be a folder");
});

test("an existing folder gets the filename", () => {
  const folder = path.join(tmp, "existing");
  fs.mkdirSync(folder, { recursive: true });

  assert.equal(
    targetFor(folder, { filename: "a.pdf", partId: "1" }),
    path.join(folder, "a.pdf")
  );
});

test("a path with an extension stays a file path, existing or not", () => {
  const target = path.join(tmp, "renamed.pdf");
  assert.equal(targetFor(target, { filename: "a.pdf", partId: "1" }), target);
  fs.writeFileSync(target, "x");
  assert.equal(targetFor(target, { filename: "a.pdf", partId: "1" }), target);
});

test("a trailing separator marks a new folder", () => {
  const folder = path.join(tmp, "trailing");
  const target = targetFor(folder + path.sep, { filename: "b.png", partId: "2" });

  assert.equal(target, path.join(folder, "b.png"));
  assert.equal(fs.statSync(folder).isDirectory(), true);
});

test("downloads never overwrite an existing file", () => {
  const folder = path.join(tmp, "collide");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "a.pdf"), "1");

  assert.equal(
    targetFor(folder, { filename: "a.pdf", partId: "1" }),
    path.join(folder, "a (1).pdf")
  );
});

test("a hostile filename cannot escape the destination folder", () => {
  const folder = path.join(tmp, "hostile");
  const target = targetFor(folder, { filename: "../../evil.sh", partId: "3" });

  assert.equal(path.dirname(target), folder);
  assert.equal(path.basename(target), "evil.sh");
});
