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
    if (Buffer.from(truncated, "utf8").equals(bytes.subarray(0, end))) {
      return { text: truncated, truncation: { originalBytes: bytes.length, keptBytes: end } };
    }
    end -= 1;
  }

  return { text: "", truncation: { originalBytes: bytes.length, keptBytes: 0 } };
};

const truncationNotice = (originalBytes: number, keptBytes: number): string =>
  `Output truncated: retained ${keptBytes} of ${originalBytes} bytes.`;

const truncateFormattedResult = (content: string, originalBytes: number): string => {
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
  const sections = [
    `# Subagent result: ${job.id}`,
    `- Status: ${job.state}\n- Agent: ${job.profile.name}\n- Access: ${access}\n- Task: ${job.request.task}`,
  ];

  if (job.state === "failed" || job.state === "cancelled") {
    sections.push(`## Diagnostics\n\nOutput:\n${job.output}\n\nStderr:\n${job.stderr}`);
  } else {
    sections.push(`## Result\n\n${job.output}`);
  }

  const formattedContent = job.truncation
    ? `${sections.join("\n\n")}\n\n${truncationNotice(job.truncation.originalBytes, job.truncation.keptBytes)}`
    : sections.join("\n\n");
  const contentBytes = Buffer.byteLength(formattedContent, "utf8");

  if (contentBytes <= COLLECTED_OUTPUT_MAX_BYTES) return formattedContent;
  return truncateFormattedResult(formattedContent, contentBytes);
};
