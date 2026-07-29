import { StringDecoder } from "node:string_decoder";

export class JsonLineParser {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private _malformedCount = 0;
  private readonly _malformedSamples: string[] = [];

  get malformedCount(): number {
    return this._malformedCount;
  }

  get malformedSamples(): readonly string[] {
    return this._malformedSamples;
  }

  push(chunk: Buffer): unknown[] {
    return this.consume(this.pending + this.decoder.write(chunk), false);
  }

  finish(): unknown[] {
    return this.consume(this.pending + this.decoder.end(), true);
  }

  private consume(text: string, finished: boolean): unknown[] {
    const records = text.split("\n");
    this.pending = finished ? "" : records.pop() ?? "";

    return records.flatMap((record) => this.parse(record));
  }

  private parse(record: string): unknown[] {
    const line = record.endsWith("\r") ? record.slice(0, -1) : record;
    if (line.trim().length === 0) return [];

    try {
      return [JSON.parse(line) as unknown];
    } catch {
      this._malformedCount += 1;
      if (this._malformedSamples.length < 3) this._malformedSamples.push(line.slice(0, 500));
      return [];
    }
  }
}
