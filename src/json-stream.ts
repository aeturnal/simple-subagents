import { StringDecoder } from "node:string_decoder";
import { CAPTURED_TEXT_MAX_BYTES } from "./output.ts";

export class JsonLineParser {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private _malformedCount = 0;

  get malformedCount(): number {
    return this._malformedCount;
  }

  push(chunk: Buffer): unknown[] {
    return this.consume(this.pending + this.decoder.write(chunk), false);
  }

  finish(): unknown[] {
    return this.consume(this.pending + this.decoder.end(), true);
  }

  private consume(text: string, finished: boolean): unknown[] {
    const records = text.split("\n");
    const pending = finished ? "" : records.pop() ?? "";
    this.pending = pending;
    const oversizedPending = !finished && Buffer.byteLength(pending, "utf8") > CAPTURED_TEXT_MAX_BYTES;
    const results = records.flatMap((record) => this.parse(record));
    if (!oversizedPending) return results;

    const oversizedMalformed = this.malformed();
    this.pending = "";
    this.decoder = new StringDecoder("utf8");
    return [...results, ...oversizedMalformed];
  }

  private parse(record: string): unknown[] {
    const line = record.endsWith("\r") ? record.slice(0, -1) : record;
    if (line.trim().length === 0) return [];

    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return this.malformed();
    }
  }

  private malformed(): unknown[] {
    this._malformedCount += 1;
    return [];
  }
}
