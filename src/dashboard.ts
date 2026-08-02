import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { boundedPreview, projectJobStatus, type JobStatus } from "./job-status.js";
import { JobManager } from "./job-manager.js";
import type { Job, JobState } from "./types.js";

type DashboardTheme = { fg(color: "accent" | "dim" | "error" | "muted" | "success" | "warning", text: string): string; bold(text: string): string };

type AttentionCounts = { queued: number; running: number; ready: number };
type DashboardMode = "list" | "compact";
type JobRecord = { kind: "job"; id: string; state: JobState; status: JobStatus };
type ListRecord = { kind: "heading"; label: string } | JobRecord;

const attentionCounts = (jobs: readonly Job[]): AttentionCounts => jobs.reduce<AttentionCounts>((counts, job) => {
  if (job.state === "queued") counts.queued += 1;
  else if (job.state === "running") counts.running += 1;
  else if (["completed", "failed", "cancelled"].includes(job.state)) counts.ready += 1;
  return counts;
}, { queued: 0, running: 0, ready: 0 });

const isInbox = (state: JobState): boolean => state === "completed" || state === "failed" || state === "cancelled";

const durationText = (durationMs: number): string => {
  const seconds = Math.floor(Math.max(0, durationMs) / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const stateText = (status: JobStatus): string => {
  const duration = status.state === "queued" ? status.queueDurationMs : status.runDurationMs;
  return `${status.state}${duration === undefined ? "" : ` ${durationText(duration)}`}`;
};

export function formatWidgetLines(jobs: readonly Job[], theme: DashboardTheme): string[] {
  const counts = attentionCounts(jobs);
  const parts = [
    counts.queued > 0 ? `${counts.queued} queued` : "",
    counts.running > 0 ? `${counts.running} running` : "",
    counts.ready > 0 ? `${counts.ready} ready` : "",
  ].filter(Boolean);
  if (parts.length === 0) return [];
  return [theme.fg("accent", "● Subagents") + theme.fg("dim", ` · ${parts.join(" · ")}`)];
}

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
  private cachedWidth: number | undefined;
  private cachedRows: number | undefined;
  private cachedLines: string[] | undefined;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly options: SubagentsDashboardOptions) {
    this.jobs = options.jobs;
    this.now = options.now ?? (() => options.manager.currentTime());
  }

  setJobs(jobs: readonly Job[]): void {
    const priorJobs = this.visibleJobs();
    const priorIndex = this.selected;
    const selectedId = priorJobs[priorIndex]?.id;
    this.jobs = jobs;
    const visible = this.visibleJobs();
    const preservedIndex = selectedId === undefined ? -1 : visible.findIndex((job) => job.id === selectedId);
    this.selected = preservedIndex >= 0 ? preservedIndex : Math.min(priorIndex, Math.max(0, visible.length - 1));
    this.changed();
  }

  handleInput(data: string): void {
    const jobs = this.visibleJobs();
    if (matchesKey(data, Key.up) && this.selected > 0) this.selected -= 1;
    else if (matchesKey(data, Key.down) && this.selected < jobs.length - 1) this.selected += 1;
    else if (matchesKey(data, Key.enter) && jobs[this.selected]) this.mode = this.mode === "list" ? "compact" : "list";
    else if (matchesKey(data, Key.escape)) {
      this.dispose();
      this.options.close();
      return;
    } else {
      const selected = jobs[this.selected];
      if (!selected || !matchesKey(data, "c") || (selected.state !== "queued" && selected.state !== "running")) return;
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
    if (rows === 0) return this.cache(width, rows, []);
    const title = line(this.options.theme.bold("Subagents"));
    if (rows === 1) return this.cache(width, rows, [title]);

    const records = this.records();
    const jobs = records.filter((record): record is JobRecord => record.kind === "job");
    this.selected = Math.min(this.selected, Math.max(0, jobs.length - 1));
    const bodyRows = Math.max(0, rows - 2);
    const body = this.mode === "compact"
      ? this.compactBody(jobs[this.selected], width, bodyRows)
      : this.listBody(records, jobs[this.selected]?.id, width, bodyRows);
    return this.cache(width, rows, [title, ...body.map(line), line("↑↓ select · enter inspect · c cancel · esc close")]);
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
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
    const jobs = this.jobs.map((job) => ({ id: job.id, state: job.state, status: projectJobStatus(job, now) }));
    const groups: Array<[string, JobRecord[]]> = [
      ["QUEUED", jobs.filter((job) => job.state === "queued").map((job) => ({ kind: "job", ...job }))],
      ["RUNNING", jobs.filter((job) => job.state === "running").map((job) => ({ kind: "job", ...job }))],
      ["INBOX", jobs.filter((job) => isInbox(job.state)).map((job) => ({ kind: "job", ...job }))],
    ];
    return groups.flatMap(([label, records]) => records.length === 0 ? [] : [{ kind: "heading", label }, ...records]);
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
    this.invalidate();
    this.options.requestRender();
  }
}

export function registerSubagentsUi(pi: ExtensionAPI, manager: JobManager): () => void {
  let widgetContext: ExtensionContext | undefined;
  let removeWidgetSubscription: (() => void) | undefined;

  const clearWidget = (): void => {
    removeWidgetSubscription?.();
    removeWidgetSubscription = undefined;
    if (widgetContext?.mode === "tui") widgetContext.ui.setWidget("simple-subagents", undefined);
    widgetContext = undefined;
  };

  pi.registerCommand("subagents", {
    description: "Open the subagent inbox dashboard",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The subagents dashboard requires interactive mode.", "warning");
        return;
      }
      let unsubscribe: (() => void) | undefined;
      let component: SubagentsDashboard | undefined;
      let closed = false;
      const close = (done: () => void): void => {
        if (closed) return;
        closed = true;
        component?.dispose();
        unsubscribe?.();
        unsubscribe = undefined;
        done();
      };
      try {
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          component = new SubagentsDashboard({
            jobs: manager.list(),
            manager,
            theme,
            terminalRows: () => tui.terminal.rows,
            requestRender: () => tui.requestRender(),
            notify: (message) => ctx.ui.notify(message, "error"),
            close: () => close(done),
          });
          unsubscribe = manager.subscribe((jobs) => {
            component?.setJobs(jobs);
          });
          return component;
        });
      } finally {
        if (!closed) {
          closed = true;
          component?.dispose();
          unsubscribe?.();
          unsubscribe = undefined;
        }
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    clearWidget();
    if (ctx.mode !== "tui") return;
    widgetContext = ctx;
    removeWidgetSubscription = manager.subscribe((jobs) => {
      const counts = attentionCounts(jobs);
      if (counts.queued + counts.running + counts.ready === 0) {
        ctx.ui.setWidget("simple-subagents", undefined);
        return;
      }
      ctx.ui.setWidget("simple-subagents", (_tui, theme) => ({
        render: (width) => formatWidgetLines(jobs, theme).map((line) => truncateToWidth(line, width)),
        invalidate: () => {},
      }));
    });
  });

  return clearWidget;
}
