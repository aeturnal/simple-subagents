import assert from "node:assert/strict";
import test from "node:test";
import { JsonLineParser } from "../src/json-stream.ts";
import { COLLECTED_OUTPUT_MAX_BYTES, formatCollectedResult, truncateUtf8 } from "../src/output.ts";
import type { Job } from "../src/types.ts";

const job = (overrides: Partial<Job> = {}): Job => ({
  id: "job-42",
  request: { task: "Review token handling", agent: "reviewer", writeAccess: false },
  profile: {
    name: "reviewer",
    description: "Reviews code",
    systemPrompt: "Review the code.",
    source: "user",
  },
  state: "completed",
  createdAt: 0,
  progress: [],
  output: "Final findings",
  stderr: "",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  malformedEventCount: 0,
  ...overrides,
});

test("parses JSON records split across chunks", () => {
  const parser = new JsonLineParser();

  assert.deepEqual(parser.push(Buffer.from('{"type":"message_')), []);
  assert.deepEqual(parser.push(Buffer.from('end"}\r\n')), [{ type: "message_end" }]);
  assert.deepEqual(parser.finish(), []);
});

test("decodes UTF-8 characters split across chunks", () => {
  const parser = new JsonLineParser();
  const line = Buffer.from('{"message":"😀"}\n');

  assert.deepEqual(parser.push(line.subarray(0, 14)), []);
  assert.deepEqual(parser.push(line.subarray(14)), [{ message: "😀" }]);
});

test("ignores blank records and only treats LF as a record boundary", () => {
  const parser = new JsonLineParser();

  assert.deepEqual(parser.push(Buffer.from("\n\r\n{\"first\":true}\r{\"second\":true}\n")), []);
  assert.equal(parser.malformedCount, 1);
  assert.deepEqual(parser.malformedSamples, ['{"first":true}\r{"second":true}']);
});

test("counts malformed records and retains three 500-character samples", () => {
  const parser = new JsonLineParser();
  const oversized = "x".repeat(501);

  assert.deepEqual(parser.push(Buffer.from(`bad\n${oversized}\nthird\nfourth\n`)), []);
  assert.equal(parser.malformedCount, 4);
  assert.deepEqual(parser.malformedSamples, ["bad", "x".repeat(500), "third"]);
});

test("parses a final unterminated record when finished", () => {
  const parser = new JsonLineParser();

  assert.deepEqual(parser.push(Buffer.from('{"complete":true}')), []);
  assert.deepEqual(parser.finish(), [{ complete: true }]);
});

test("truncates without splitting UTF-8 characters", () => {
  const result = truncateUtf8("a😀b", 5);

  assert.equal(result.text, "a😀");
  assert.deepEqual(result.truncation, { originalBytes: 6, keptBytes: 5 });
});

test("backs up from incomplete UTF-8 prefixes", () => {
  for (const maxBytes of [2, 3, 4]) {
    assert.deepEqual(truncateUtf8("a😀b", maxBytes), {
      text: "a",
      truncation: { originalBytes: 6, keptBytes: 1 },
    });
  }
});

test("does not add truncation metadata when text fits", () => {
  const result = truncateUtf8("a😀b", 6);

  assert.deepEqual(result, { text: "a😀b" });
});

test("formats a completed result deterministically", () => {
  assert.equal(
    formatCollectedResult(job()),
    "# Subagent result: job-42\n\n- Status: completed\n- Agent: reviewer\n- Access: read-only\n- Task: Review token handling\n\n## Result\n\nFinal findings",
  );
});

test("formats failed results with output, stderr, and truncation diagnostics", () => {
  assert.equal(
    formatCollectedResult(
      job({
        state: "failed",
        output: "Partial answer",
        stderr: "process exited 1",
        truncation: { originalBytes: 60000, keptBytes: 51200 },
      }),
    ),
    "# Subagent result: job-42\n\n- Status: failed\n- Agent: reviewer\n- Access: read-only\n- Task: Review token handling\n\n## Diagnostics\n\nOutput:\nPartial answer\n\nStderr:\nprocess exited 1\n\nOutput truncated: retained 51200 of 60000 bytes.",
  );
});

test("caps completed results at the complete model-visible byte limit", () => {
  const formatted = formatCollectedResult(job({ output: "😀".repeat(20_000) }));

  assert.ok(Buffer.byteLength(formatted) <= COLLECTED_OUTPUT_MAX_BYTES);
  assert.ok(!formatted.includes("\uFFFD"));
});

test("caps failed diagnostics without duplicating output and merges truncation counts", () => {
  const formatted = formatCollectedResult(
    job({
      state: "failed",
      output: "😀".repeat(15_000),
      stderr: "😀".repeat(15_000),
      truncation: { originalBytes: 100_000, keptBytes: 60_000 },
    }),
  );
  const notice = /\n\nOutput truncated: retained (\d+) of (\d+) bytes\.$/.exec(formatted);

  assert.ok(Buffer.byteLength(formatted) <= COLLECTED_OUTPUT_MAX_BYTES);
  assert.equal(formatted.split("Output:\n").length - 1, 1);
  assert.ok(!formatted.includes("\uFFFD"));
  assert.ok(notice);
  assert.equal(notice[2], "100000");
  assert.equal(notice[1], String(Buffer.byteLength(formatted.slice(0, notice.index))));
});

test("caps cancelled results with large multibyte stderr", () => {
  const formatted = formatCollectedResult(
    job({ state: "cancelled", output: "partial", stderr: "😀".repeat(20_000) }),
  );

  assert.ok(Buffer.byteLength(formatted) <= COLLECTED_OUTPUT_MAX_BYTES);
  assert.ok(!formatted.includes("\uFFFD"));
});
