import { truncateUtf8 } from "./output.js";

export const STATUS_ACTIVITY_LIMIT = 3;
export const STATUS_JOB_LIMIT = 20;
export const STATUS_PREVIEW_MAX_BYTES = 512;
export const STATUS_PREVIEW_MAX_GRAPHEMES = 160;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function sanitizeTerminalText(text: string, preserveSgr = false): string {
  let safe = "";
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index);
    if (code === 0x1b && text[index + 1] === "]") {
      index += 2;
      while (index < text.length && text.charCodeAt(index) !== 0x07 && !(text.charCodeAt(index) === 0x1b && text[index + 1] === "\\")) index += 1;
      index += text.charCodeAt(index) === 0x1b ? 2 : 1;
      continue;
    }
    if (code === 0x1b && text[index + 1] === "[") {
      let end = index + 2;
      while (end < text.length && !(text.charCodeAt(end) >= 0x40 && text.charCodeAt(end) <= 0x7e)) end += 1;
      const sequence = text.slice(index, Math.min(text.length, end + 1));
      const final = text[end];
      const parameters = text.slice(index + 2, end);
      if (preserveSgr && final === "m" && /^[0-9:;]*$/.test(parameters)) safe += sequence;
      index = Math.min(text.length, end + 1);
      continue;
    }
    if (code === 0x1b) { index += Math.min(2, text.length - index); continue; }
    const value = text[index] ?? "";
    if (value === "\n") safe += value;
    else if (value === "\t") safe += "   ";
    else if (value !== "\r" && code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) safe += value;
    index += 1;
  }
  return safe;
}

export function boundedPreview(text: string, maxBytes = STATUS_PREVIEW_MAX_BYTES, maxGraphemes = STATUS_PREVIEW_MAX_GRAPHEMES): string {
  const normalized = sanitizeTerminalText(text).replace(/\s+/gu, " ").trim();
  let bounded = "";
  let count = 0;
  for (const segment of graphemes.segment(normalized)) {
    if (count >= maxGraphemes) break;
    bounded += segment.segment;
    count += 1;
  }
  return truncateUtf8(bounded, maxBytes).text;
}
