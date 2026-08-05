import { Buffer } from "node:buffer";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { boundedPreview, projectJobStatus, sanitizeTerminalText, type JobStatus } from "./job-status.js";
import { decideJobControl, inspectJobState } from "./job-lifecycle.js";
import { JobManager } from "./job-manager.js";
import { LiveSubagentsWidget } from "./live-widget.js";
import type { Job, JobState } from "./types.js";

type DashboardTheme = { fg(color: "accent" | "dim" | "error" | "muted" | "success" | "warning", text: string): string; bold(text: string): string };

type DashboardMode = "list" | "compact" | "full";
type ReturnMode = Exclude<DashboardMode, "full">;
type JobRecord = { kind: "job"; id: string; state: JobState; status: JobStatus; job: Job };
type ListRecord = { kind: "heading"; label: string } | JobRecord;

const textFingerprint = (text: string): string => {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${Buffer.byteLength(text, "utf8")}:${hash >>> 0}`;
};

const renderFingerprint = (jobs: readonly Job[]): string => JSON.stringify(jobs.map((job) => ({
  id: job.id,
  state: job.state,
  task: job.request.task,
  profileName: job.profile.name,
  writeAccess: job.request.writeAccess,
  createdAt: job.createdAt,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
  launchModel: job.launchModel,
  launchThinkingLevel: job.launchThinkingLevel,
  launchThinkingSource: job.launchThinkingSource,
  reportedModel: job.model,
  usage: job.usage,
  nonTextProgress: job.progress.filter((item) => item.type !== "text"),
  hasTextProgress: job.progress.some((item) => item.type === "text"),
  textTruncations: job.progress.filter((item) => item.type === "text").map((item) => item.truncation === undefined ? undefined : { keptBytes: item.truncation.keptBytes }),
  output: textFingerprint(job.output),
  stderr: textFingerprint(job.stderr),
  error: job.errorMessage === undefined ? undefined : textFingerprint(job.errorMessage),
  outputTruncation: job.outputTruncation,
  stderrTruncation: job.stderrTruncation,
  errorTruncation: job.errorTruncation,
  truncation: job.truncation,
  malformedEventCount: job.malformedEventCount,
})));

const durationText = (durationMs: number): string => {
  const seconds = Math.floor(Math.max(0, durationMs) / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const stateText = (status: JobStatus): string => {
  const duration = status.state === "queued" ? status.queueDurationMs : status.runDurationMs ?? status.queueDurationMs;
  return `${status.state}${duration === undefined ? "" : ` ${durationText(duration)}`}`;
};

export interface SubagentsDashboardOptions {
  jobs: readonly Job[];
  manager: JobManager;
  theme: DashboardTheme;
  terminalRows(): number;
  requestRender(): void;
  notify(message: string): void;
  close(): void;
  now?: () => number;
}

export class SubagentsDashboard implements Component {
  private jobs: readonly Job[];
  private selected = 0;
  private mode: DashboardMode = "list";
  private listOffset = 0;
  private fullReturnMode: ReturnMode = "list";
  private fullOffset = 0;
  private cachedWidth: number | undefined;
  private cachedRows: number | undefined;
  private cachedLines: string[] | undefined;
  private renderFingerprint: string;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly options: SubagentsDashboardOptions) {
    this.jobs = options.jobs;
    this.renderFingerprint = renderFingerprint(options.jobs);
    this.now = options.now ?? (() => options.manager.currentTime());
  }

  setJobs(jobs: readonly Job[]): void {
    if (this.disposed) return;
    const nextFingerprint = renderFingerprint(jobs);
    const fingerprintChanged = nextFingerprint !== this.renderFingerprint;
    const priorJobs = this.visibleJobs();
    const priorIndex = this.selected;
    const selectedId = priorJobs[priorIndex]?.id;
    const priorMode = this.mode;
    this.jobs = jobs;
    this.renderFingerprint = nextFingerprint;
    const visible = this.visibleJobs();
    const preservedIndex = selectedId === undefined ? -1 : visible.findIndex((job) => job.id === selectedId);
    this.selected = preservedIndex >= 0 ? preservedIndex : Math.min(priorIndex, Math.max(0, visible.length - 1));
    if (this.mode === "full" && preservedIndex < 0) {
      this.mode = "list";
      this.fullOffset = 0;
    }
    if (fingerprintChanged || selectedId !== visible[this.selected]?.id || priorMode !== this.mode) this.changed();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.mode === "full") {
      this.handleFullInput(data);
      return;
    }

    const jobs = this.visibleJobs();
    if (matchesKey(data, Key.up) && this.selected > 0) this.selected -= 1;
    else if (matchesKey(data, Key.down) && this.selected < jobs.length - 1) this.selected += 1;
    else if (matchesKey(data, Key.enter) && jobs[this.selected]) this.mode = this.mode === "list" ? "compact" : "list";
    else if (matchesKey(data, "v") && jobs[this.selected]) {
      this.fullReturnMode = this.mode;
      this.mode = "full";
      this.fullOffset = 0;
    } else if (matchesKey(data, Key.escape)) {
      this.dispose();
      this.options.close();
      return;
    } else {
      const selected = jobs[this.selected];
      if (!selected || !matchesKey(data, "c") || decideJobControl(selected.state, "cancel").kind !== "apply") return;
      try {
        void this.options.manager.cancel(selected.id).catch(() => this.actionFailed());
      } catch {
        this.actionFailed();
      }
      return;
    }
    this.changed();
  }

  render(width: number): string[] {
    const rows = Math.max(0, Math.floor(this.options.terminalRows()));
    if (this.cachedWidth === width && this.cachedRows === rows && this.cachedLines) return this.cachedLines;

    const line = (value: string): string => truncateToWidth(value, width);
    const records = this.records();
    const jobs = records.filter((record): record is JobRecord => record.kind === "job");
    this.selected = Math.min(this.selected, Math.max(0, jobs.length - 1));
    if (this.mode === "full" && !jobs[this.selected]) {
      this.mode = "list";
      this.fullOffset = 0;
    }
    if (this.mode === "full") return this.cache(width, rows, this.fullFrame(jobs[this.selected]!, width, rows));
    if (rows === 0) return this.cache(width, rows, []);
    const title = line(this.options.theme.bold("Subagents"));
    if (rows === 1) return this.cache(width, rows, [title]);

    const bodyRows = Math.max(0, rows - 2);
    const body = this.mode === "compact"
      ? this.compactBody(jobs[this.selected], width, bodyRows)
      : this.listBody(records, jobs[this.selected]?.id, width, bodyRows);
    return this.cache(width, rows, [title, ...body.map(line), line("↑↓ select · enter inspect · v full · c cancel · esc close")]);
  }

  invalidate(): void {
    if (this.disposed) return;
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
  }

  private cache(width: number, rows: number, lines: string[]): string[] {
    this.cachedWidth = width;
    this.cachedRows = rows;
    this.cachedLines = lines;
    return lines;
  }

  private visibleJobs(): JobRecord[] {
    return this.records().filter((record): record is JobRecord => record.kind === "job");
  }

  private records(): ListRecord[] {
    const now = this.now();
    const jobs = this.jobs.map((job) => ({ id: job.id, state: job.state, status: projectJobStatus(job, now), job }));
    const groups: Array<[string, JobRecord[]]> = [
      ["QUEUED", jobs.filter((job) => job.state === "queued").map((job) => ({ kind: "job", ...job }))],
      ["RUNNING", jobs.filter((job) => job.state === "running").map((job) => ({ kind: "job", ...job }))],
      ["INBOX", jobs.filter((job) => inspectJobState(job.state).inbox).map((job) => ({ kind: "job", ...job }))],
    ];
    return groups.flatMap(([label, records]) => records.length === 0 ? [] : [{ kind: "heading", label }, ...records]);
  }

  private handleFullInput(data: string): void {
    if (matchesKey(data, Key.up)) this.fullOffset = Math.max(0, this.fullOffset - 1);
    else if (matchesKey(data, Key.down)) this.fullOffset += 1;
    else if (matchesKey(data, Key.pageUp)) this.fullOffset = Math.max(0, this.fullOffset - Math.max(1, this.options.terminalRows() - 2));
    else if (matchesKey(data, Key.pageDown)) this.fullOffset += Math.max(1, this.options.terminalRows() - 2);
    else if (matchesKey(data, Key.home)) this.fullOffset = 0;
    else if (matchesKey(data, Key.end)) this.fullOffset = Number.MAX_SAFE_INTEGER;
    else if (matchesKey(data, "v") || matchesKey(data, Key.escape)) {
      this.mode = this.fullReturnMode;
      this.fullOffset = 0;
    } else return;
    this.changed();
  }

  private fullFrame(selected: JobRecord, width: number, rows: number): string[] {
    const line = (value: string): string => truncateToWidth(value, width);
    const title = line(this.options.theme.bold(`Subagent ${selected.status.id} · full view`));
    if (rows === 0) return [];
    if (rows === 1) return [title];

    const content = this.fullDetail(selected.job, selected.status, width);
    const bodyRows = Math.max(0, rows - 2);
    const maxOffset = Math.max(0, content.length - bodyRows);
    this.fullOffset = Math.min(Math.max(0, this.fullOffset), maxOffset);
    const body = content.slice(this.fullOffset, this.fullOffset + bodyRows);
    const start = bodyRows === 0 || content.length === 0 ? 0 : this.fullOffset + 1;
    const end = bodyRows === 0 ? 0 : Math.min(content.length, this.fullOffset + body.length);
    const footer = `lines ${start}–${end} of ${content.length} · ↑↓ line · PgUp/PgDn page · Home/End · v/esc back`;
    return [title, ...body.map(line), line(footer)];
  }

  private fullDetail(job: Job, status: JobStatus, width: number): string[] {
    const timestamp = (value: number | undefined, absent: string): string => value === undefined ? absent : new Date(value).toISOString();
    const duration = (value: number | undefined): string => value === undefined ? "Not recorded" : durationText(value);
    const labeledField = (label: string, value: string): string[] => {
      const prefix = `${label}: `;
      const safe = sanitizeTerminalText(value, true);
      const wrappedValue = safe.split("\n").flatMap((segment) => wrapTextWithAnsi(segment, Math.max(1, width - prefix.length)));
      if (prefix.length >= width) return [...wrapTextWithAnsi(prefix, Math.max(1, width)), ...wrappedValue].map((line) => truncateToWidth(line, width));
      const continuation = " ".repeat(prefix.length);
      return wrappedValue.map((line, index) => truncateToWidth(`${index === 0 ? prefix : continuation}${line}`, width));
    };
    const activity = status.recentActivity.length === 0
      ? labeledField("Recent activity", "No activity reported yet")
      : status.recentActivity.flatMap((item) => labeledField("Recent activity", `${new Date(item.timestamp).toISOString()} ${item.kind}: ${item.summary}`));
    const malformed = `${job.malformedEventCount} malformed protocol event${job.malformedEventCount === 1 ? "" : "s"}.`;
    const progress = job.progress.length
      ? job.progress.map((item) => `${new Date(item.timestamp).toISOString()} ${item.type}: ${item.text}`).join("\n")
      : "No activity reported yet.";
    return [
      ...labeledField("Status", `${status.id} ${stateText(status)}`),
      ...labeledField("Task", status.task),
      ...labeledField("Agent", status.agent),
      ...labeledField("Access", status.access),
      ...labeledField("Launch model", status.launchModel ?? "model or Pi default"),
      ...labeledField("Launch thinking", status.launchThinking ?? "model or Pi default"),
      ...labeledField("Reported model", status.reportedModel ?? "Not reported"),
      ...labeledField("Created", timestamp(status.createdAt, "Not recorded")),
      ...labeledField("Started", timestamp(status.startedAt, "Not started")),
      ...labeledField("Finished", timestamp(status.finishedAt, "Not finished")),
      ...labeledField("Queue", duration(status.queueDurationMs)),
      ...labeledField("Run", duration(status.runDurationMs)),
      ...labeledField("Usage", `input ${status.usage.input}, output ${status.usage.output}, cache read ${status.usage.cacheRead}, cache write ${status.usage.cacheWrite}, cost ${status.usage.cost}, turns ${status.usage.turns}`),
      ...activity,
      ...labeledField("Capture", status.captureNotices.length ? status.captureNotices.join(" · ") : "none"),
      ...labeledField("Error", status.hasError ? "reported" : "none"),
      ...labeledField("Output", job.output || "No captured output."),
      ...labeledField("Stderr", job.stderr || "No stderr captured."),
      ...labeledField("Error", job.errorMessage || "No error reported."),
      ...labeledField("Malformed", malformed),
      ...labeledField("Progress", progress),
    ];
  }

  private listBody(records: ListRecord[], selectedId: string | undefined, width: number, bodyRows: number): string[] {
    const selectedRecord = records.findIndex((record) => record.kind === "job" && record.id === selectedId);
    const maxOffset = Math.max(0, records.length - bodyRows);
    if (selectedRecord >= 0 && selectedRecord < this.listOffset) this.listOffset = selectedRecord;
    else if (selectedRecord >= this.listOffset + bodyRows) this.listOffset = selectedRecord - bodyRows + 1;
    this.listOffset = Math.min(Math.max(0, this.listOffset), maxOffset);

    const body = records.slice(this.listOffset, this.listOffset + bodyRows).map((record) => record.kind === "heading"
      ? this.options.theme.fg("dim", record.label)
      : this.row(record.status, record.id === selectedId, width));
    if (body.length === 0 && records.length === 0 && bodyRows > 0) body.push(this.options.theme.fg("dim", "No subagent jobs."));
    return body;
  }

  private compactBody(selected: JobRecord | undefined, width: number, bodyRows: number): string[] {
    if (!selected) return bodyRows > 0 ? [this.options.theme.fg("dim", "No subagent jobs.")] : [];
    const status = selected.status;
    const timestamp = (value: number | undefined, absent: string): string => value === undefined ? absent : new Date(value).toISOString();
    const duration = (value: number | undefined): string => value === undefined ? "Not recorded" : durationText(value);
    const activity = status.recentActivity.length === 0
      ? ["Recent activity: No activity reported yet"]
      : ["Recent activity:", ...status.recentActivity.flatMap((item) => wrapTextWithAnsi(`  ${new Date(item.timestamp).toISOString()} ${item.kind}: ${item.summary}`, Math.max(1, width)))];
    const lines = [
      this.row(status, true, width),
      ...wrapTextWithAnsi(`Task: ${status.task}`, Math.max(1, width)),
      `Agent: ${status.agent} · Access: ${status.access}`,
      `Launch model: ${status.launchModel ?? "model or Pi default"}`,
      `Launch thinking: ${status.launchThinking ?? "model or Pi default"}`,
      `Reported model: ${status.reportedModel ?? "Not reported"}`,
      `Created: ${timestamp(status.createdAt, "Not recorded")}`,
      `Started: ${timestamp(status.startedAt, "Not started")}`,
      `Finished: ${timestamp(status.finishedAt, "Not finished")}`,
      `Queue: ${duration(status.queueDurationMs)}`,
      `Run: ${duration(status.runDurationMs)}`,
      `Usage: input ${status.usage.input}, output ${status.usage.output}, cache read ${status.usage.cacheRead}, cache write ${status.usage.cacheWrite}, cost ${status.usage.cost}, turns ${status.usage.turns}`,
      ...activity,
      `Capture: ${status.captureNotices.length ? status.captureNotices.join(" · ") : "none"}`,
      `Error: ${status.hasError ? "reported" : "none"}`,
    ];
    if (lines.length <= bodyRows) return lines;
    if (bodyRows === 0) return [];
    return [...lines.slice(0, bodyRows - 1), `… ${lines.length - bodyRows + 1} compact lines omitted`];
  }

  private row(status: JobStatus, selected: boolean, width: number): string {
    const marker = selected ? this.options.theme.fg("accent", "> ") : "  ";
    const writeMarker = status.access === "write" ? "W " : "";
    const base = `${marker}${status.id} ${writeMarker}${stateText(status)} · ${status.task}`;
    const activity = status.recentActivity.at(-1)?.summary;
    const withActivity = activity && visibleWidth(`${base} · ${boundedPreview(activity)}`) <= width
      ? `${base} · ${boundedPreview(activity)}`
      : base;
    return truncateToWidth(withActivity, width);
  }

  private actionFailed(): void {
    if (this.disposed) return;
    this.options.notify("Could not cancel subagent job.");
    this.setJobs(this.options.manager.list());
  }

  private changed(): void {
    if (this.disposed) return;
    this.invalidate();
    this.options.requestRender();
  }
}

export function registerSubagentsUi(pi: ExtensionAPI, manager: JobManager): () => void {
  let liveWidget: LiveSubagentsWidget | undefined;
  let removeWidgetSubscription: (() => void) | undefined;
  let activeDashboard: { close(): void } | undefined;
  let cleanedUp = false;

  const clearWidget = (): void => {
    removeWidgetSubscription?.();
    removeWidgetSubscription = undefined;
    liveWidget?.dispose();
    liveWidget = undefined;
  };

  pi.registerCommand("subagents", {
    description: "Open the subagent inbox dashboard",
    handler: async (_args, ctx) => {
      if (cleanedUp) return;
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The subagents dashboard requires interactive mode.", "warning");
        return;
      }
      activeDashboard?.close();
      let unsubscribe: (() => void) | undefined;
      let component: SubagentsDashboard | undefined;
      let doneCustom: (() => void) | undefined;
      let closed = false;
      const opening = {
        close: (): void => {
          if (closed) return;
          closed = true;
          component?.dispose();
          unsubscribe?.();
          unsubscribe = undefined;
          if (activeDashboard === opening) activeDashboard = undefined;
          doneCustom?.();
        },
      };
      activeDashboard = opening;
      try {
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          doneCustom = done;
          component = new SubagentsDashboard({
            jobs: manager.list(),
            manager,
            theme,
            terminalRows: () => tui.terminal.rows,
            requestRender: () => { if (!closed) tui.requestRender(); },
            notify: (message) => { if (!closed) ctx.ui.notify(message, "error"); },
            close: opening.close,
          });
          unsubscribe = manager.subscribe((jobs) => {
            if (!closed) component?.setJobs(jobs);
          });
          return component;
        });
      } finally {
        opening.close();
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    activeDashboard?.close();
    activeDashboard = undefined;
    clearWidget();
    if (cleanedUp || ctx.mode !== "tui") return;
    const widget = new LiveSubagentsWidget();
    liveWidget = widget;
    widget.setUi(ctx.ui);
    let widgetClosed = false;
    const unsubscribe = manager.subscribe((jobs) => {
      if (!widgetClosed) widget.setJobs(jobs);
    });
    removeWidgetSubscription = () => {
      if (widgetClosed) return;
      widgetClosed = true;
      unsubscribe();
    };
  });

  return () => {
    if (cleanedUp) return;
    cleanedUp = true;
    activeDashboard?.close();
    activeDashboard = undefined;
    clearWidget();
  };
}
