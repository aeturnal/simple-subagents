import assert from "node:assert/strict";
import test from "node:test";
import { JsonLineParser } from "../src/json-stream.ts";
import {
  CAPTURED_TEXT_MAX_BYTES,
  COLLECTED_OUTPUT_MAX_BYTES,
  MALFORMED_EVENT_SAMPLE_MAX_BYTES,
  formatCollectedResult,
  truncateUtf8,
} from "../src/output.ts";
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

test("bounds malformed samples at a UTF-8-safe byte limit", () => {
  const parser = new JsonLineParser();

  parser.push(Buffer.from(`${"😀".repeat(200)}\n`));

  assert.equal(CAPTURED_TEXT_MAX_BYTES, 50 * 1024);
  assert.equal(MALFORMED_EVENT_SAMPLE_MAX_BYTES, 500);
  assert.ok(Buffer.byteLength(parser.malformedSamples[0] ?? "", "utf8") <= MALFORMED_EVENT_SAMPLE_MAX_BYTES);
  assert.doesNotMatch(parser.malformedSamples[0] ?? "", /\uFFFD/);
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
    "# Subagent result: job-42\n\n- Status: completed\n- Agent: reviewer\n- Access: read-only\n- Task: Review token handling\n- Usage: input 0, output 0, cache read 0, cache write 0, cost 0, turns 0\n\n## Result\n\nFinal findings",
  );
});

test("formats model, usage, and independent actionable diagnostics", () => {
  const formatted = formatCollectedResult(job({
    state: "failed",
    model: "openai/gpt-5",
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, turns: 6 },
    output: "Partial answer",
    stderr: "stderr warning",
    errorMessage: "assistant error",
    malformedEventCount: 2,
    malformedEventSamples: ["bad event"],
    outputTruncation: { originalBytes: 60_000, keptBytes: 50 * 1024 },
    stderrTruncation: { originalBytes: 70_000, keptBytes: 50 * 1024 },
  }));

  for (const expected of [
    "- Model: openai/gpt-5",
    "- Usage: input 1, output 2, cache read 3, cache write 4, cost 0.5, turns 6",
    "Output capture truncated: retained 51200 of 60000 bytes.",
    "Stderr capture truncated: retained 51200 of 70000 bytes.",
    "Error:\nassistant error",
    "Malformed events: 2",
    "- bad event",
  ]) assert.match(formatted, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
    "# Subagent result: job-42\n\n- Status: failed\n- Agent: reviewer\n- Access: read-only\n- Task: Review token handling\n- Usage: input 0, output 0, cache read 0, cache write 0, cost 0, turns 0\n\n## Diagnostics\n\nOutput:\nPartial answer\n\nOutput capture truncated: retained 51200 of 60000 bytes.\n\nStderr:\nprocess exited 1\n\nError:\nnone\n\nMalformed events: 0\nMalformed samples:\nnone",
  );
});

test("caps completed results at the complete model-visible byte limit", () => {
  const formatted = formatCollectedResult(job({ output: "😀".repeat(20_000) }));

  assert.ok(Buffer.byteLength(formatted) <= COLLECTED_OUTPUT_MAX_BYTES);
  assert.ok(!formatted.includes("\uFFFD"));
});

test("caps failed diagnostics without duplicating output and reports formatted-payload counts", () => {
  const output = "😀".repeat(15_000);
  const stderr = "😀".repeat(15_000);
  const formatted = formatCollectedResult(
    job({
      state: "failed",
      output,
      stderr,
      truncation: { originalBytes: 100_000, keptBytes: 60_000 },
    }),
  );
  const notice = /\n\nOutput truncated: retained (\d+) of (\d+) bytes\.$/.exec(formatted);
  const completeContent = `# Subagent result: job-42\n\n- Status: failed\n- Agent: reviewer\n- Access: read-only\n- Task: Review token handling\n- Usage: input 0, output 0, cache read 0, cache write 0, cost 0, turns 0\n\n## Diagnostics\n\nOutput:\n${output}\n\nOutput capture truncated: retained 60000 of 100000 bytes.\n\nStderr:\n${stderr}\n\nError:\nnone\n\nMalformed events: 0\nMalformed samples:\nnone`;

  assert.ok(Buffer.byteLength(formatted) <= COLLECTED_OUTPUT_MAX_BYTES);
  assert.equal(formatted.split("Output:\n").length - 1, 1);
  assert.ok(!formatted.includes("\uFFFD"));
  assert.ok(notice);
  assert.equal(Number(notice[2]), Buffer.byteLength(completeContent));
  assert.equal(notice[1], String(Buffer.byteLength(formatted.slice(0, notice.index))));
});

test("reports final cap counts in the formatted-payload domain after upstream output truncation", () => {
  const stderr = "x".repeat(COLLECTED_OUTPUT_MAX_BYTES + 1);
  const formatted = formatCollectedResult(
    job({
      state: "failed",
      output: "partial",
      stderr,
      truncation: { originalBytes: 1_000, keptBytes: 500 },
    }),
  );
  const notice = /\n\nOutput truncated: retained (\d+) of (\d+) bytes\.$/.exec(formatted);
  const completeContent = `# Subagent result: job-42\n\n- Status: failed\n- Agent: reviewer\n- Access: read-only\n- Task: Review token handling\n- Usage: input 0, output 0, cache read 0, cache write 0, cost 0, turns 0\n\n## Diagnostics\n\nOutput:\npartial\n\nOutput capture truncated: retained 500 of 1000 bytes.\n\nStderr:\n${stderr}\n\nError:\nnone\n\nMalformed events: 0\nMalformed samples:\nnone`;

  assert.ok(notice);
  assert.equal(Number(notice[2]), Buffer.byteLength(completeContent));
  assert.equal(Number(notice[1]), Buffer.byteLength(formatted.slice(0, notice.index)));
  assert.ok(Number(notice[1]) <= Number(notice[2]));
  assert.ok(Buffer.byteLength(formatted) <= COLLECTED_OUTPUT_MAX_BYTES);
  assert.ok(!formatted.includes("\uFFFD"));
});

test("caps cancelled results with large multibyte stderr", () => {
  const formatted = formatCollectedResult(
    job({ state: "cancelled", output: "partial", stderr: "😀".repeat(20_000) }),
  );

  assert.ok(Buffer.byteLength(formatted) <= COLLECTED_OUTPUT_MAX_BYTES);
  assert.ok(!formatted.includes("\uFFFD"));
});
