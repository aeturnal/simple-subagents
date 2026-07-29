import { Buffer } from "node:buffer";
import type { Job } from "./types.ts";

export const COLLECTED_OUTPUT_MAX_BYTES = 50 * 1024;

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
    if (Buffer.byteLength(truncated, "utf8") === end) {
      return { text: truncated, truncation: { originalBytes: bytes.length, keptBytes: end } };
    }
    end -= 1;
  }

  return { text: "", truncation: { originalBytes: bytes.length, keptBytes: 0 } };
};

export const formatCollectedResult = (job: Job): string => {
  const output = truncateUtf8(job.output, COLLECTED_OUTPUT_MAX_BYTES);
  const truncation = job.truncation ?? output.truncation;
  const access = job.request.writeAccess ? "write" : "read-only";
  const sections = [
    `# Subagent result: ${job.id}`,
    `- Status: ${job.state}\n- Agent: ${job.profile.name}\n- Access: ${access}\n- Task: ${job.request.task}`,
    `## Result\n\n${output.text}`,
  ];

  if (job.state === "failed" || job.state === "cancelled") {
    sections.push(`## Diagnostics\n\nOutput:\n${output.text}\n\nStderr:\n${job.stderr}`);
  }

  if (truncation) {
    sections.push(`Output truncated: retained ${truncation.keptBytes} of ${truncation.originalBytes} bytes.`);
  }

  return sections.join("\n\n");
};
