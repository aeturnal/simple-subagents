import { Buffer } from "node:buffer";
import type { Job } from "./types.ts";

export const COLLECTED_OUTPUT_MAX_BYTES = 50 * 1024;
export const CAPTURED_TEXT_MAX_BYTES = 50 * 1024;

export interface TruncatedText {
  text: string;
  truncation?: { originalBytes: number; keptBytes: number };
}

export const truncateUtf8 = (text: string, maxBytes: number): TruncatedText => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text };

  let end = Math.max(0, Math.min(bytes.length, Math.floor(maxBytes)));
  while (end > 0) {
    const truncated = bytes.subarray(0, end).toString("utf8");
    if (Buffer.from(truncated, "utf8").equals(bytes.subarray(0, end))) {
      return { text: truncated, truncation: { originalBytes: bytes.length, keptBytes: end } };
    }
    end -= 1;
  }

  return { text: "", truncation: { originalBytes: bytes.length, keptBytes: 0 } };
};

const truncationNotice = (originalBytes: number, keptBytes: number): string =>
  `Output truncated: retained ${keptBytes} of ${originalBytes} bytes.`;

const captureNotice = (label: string, truncation?: { originalBytes: number; keptBytes: number }): string | undefined =>
  truncation && `${label} capture truncated: retained ${truncation.keptBytes} of ${truncation.originalBytes} bytes.`;

const usageLine = (job: Job): string =>
  `- Usage: input ${job.usage.input}, output ${job.usage.output}, cache read ${job.usage.cacheRead}, cache write ${job.usage.cacheWrite}, cost ${job.usage.cost}, turns ${job.usage.turns}`;

const thinkingSelection = (job: Job): string | undefined => {
  if (job.launchThinkingLevel) {
    const source = job.launchThinkingSource === "job" ? "job override"
      : job.launchThinkingSource === "profile" ? "profile"
        : job.launchThinkingSource === "parent" ? "parent session"
          : "model or Pi default";
    return `${job.launchThinkingLevel} (${source})`;
  }
  if (job.launchThinkingSource === "model_or_pi_default") return "model or Pi default";
  return undefined;
};

export const capCollectedPayload = (content: string): string => {
  const originalBytes = Buffer.byteLength(content, "utf8");
  if (originalBytes <= COLLECTED_OUTPUT_MAX_BYTES) return content;

  let notice = truncationNotice(originalBytes, 0);
  while (true) {
    const availableBytes = COLLECTED_OUTPUT_MAX_BYTES - Buffer.byteLength(`\n\n${notice}`, "utf8");
    const text = truncateUtf8(content, Math.max(0, availableBytes)).text;
    const nextNotice = truncationNotice(originalBytes, Buffer.byteLength(text, "utf8"));

    if (nextNotice === notice) return `${text}\n\n${notice}`;
    notice = nextNotice;
  }
};

export const formatCollectedResult = (job: Job): string => {
  const access = job.request.writeAccess ? "write" : "read-only";
  const metadata = [
    `- Status: ${job.state}`,
    `- Agent: ${job.profile.name}`,
    `- Access: ${access}`,
    `- Task: ${job.request.task}`,
    ...(job.launchModel ? [`- Launch model: ${job.launchModel}`] : []),
    ...(thinkingSelection(job) ? [`- Launch thinking: ${thinkingSelection(job)}`] : []),
    ...(job.model ? [`- Reported model: ${job.model}`] : []),
    usageLine(job),
  ];
  const latestPartial = [...job.progress].reverse().find((item) => item.type === "text");
  const captureNotices = [
    captureNotice("Output", job.outputTruncation ?? job.truncation),
    captureNotice("Stderr", job.stderrTruncation),
    captureNotice("Error", job.errorTruncation),
    captureNotice("Partial output", latestPartial?.truncation),
  ].filter((notice): notice is string => notice !== undefined);
  const isFailure = job.state === "failed" || job.state === "cancelled";
  const sections = [
    `# Subagent result: ${job.id}`,
    ...(captureNotices.length ? [`## Capture limits\n${captureNotices.join("\n")}`] : []),
    ...(isFailure ? [`Partial output:\n${latestPartial?.text ?? "none"}`] : []),
    metadata.join("\n"),
  ];

  if (isFailure) {
    sections.push([
      "## Diagnostics",
      `Output:\n${job.output}`,
      `Stderr:\n${job.stderr}`,
      `Error:\n${job.errorMessage ?? "none"}`,
      `Malformed events: ${job.malformedEventCount}`,
    ].join("\n\n"));
  } else {
    sections.push(`## Result\n\n${job.output}`);
  }

  const formattedContent = sections.join("\n\n");
  return capCollectedPayload(formattedContent);
};
