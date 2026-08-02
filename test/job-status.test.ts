import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { boundedPreview, sanitizeTerminalText } from "../src/job-status.js";

test("removes unsafe terminal controls while optionally retaining SGR", () => {
  const hostile = "ok\rreplace\t😀 e\u0301 漢\u001B]0;owned\u0007\u001B[2J\u001B[H\u001B[K\u001B[31mred\u001B[0m";
  const plain = sanitizeTerminalText(hostile);
  const styled = sanitizeTerminalText(hostile, true);
  assert.doesNotMatch(plain, /\r|\t|\u001B|\u0007/);
  assert.doesNotMatch(styled, /\u001B\](?:.|\n)*|\u001B\[(?:2J|H|K)/);
  assert.match(styled, /\u001B\[31mred\u001B\[0m/);
});

test("bounds previews on grapheme and UTF-8 boundaries", () => {
  const value = boundedPreview("😀".repeat(400), 511, 400);
  assert.equal(Buffer.from(value, "utf8").toString("utf8"), value);
  assert.ok(Buffer.byteLength(value, "utf8") <= 511);
  assert.equal(boundedPreview("a\tb\r\nc", 100, 100), "a b c");
});
