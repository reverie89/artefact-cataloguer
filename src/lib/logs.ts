// Curated run-activity stream for the Logs Viewer drawer.
//
// This stream holds only the narrative stages of a catalogue run — upload →
// validate → parse row → POST → job ID → poll → response → populated fields —
// so the drawer reads as a clean, live transcript. Each entry may carry a
// `verbose` envelope (request body, headers, status code, …) which the drawer
// reveals on row click.

import { useSyncExternalStore } from "react";

export type LogStatus = "ok" | "busy" | "fail";

/** Verbose HTTP / row payload shown when a table row is expanded. */
export interface LogVerbose {
  method?: string;
  url?: string;
  headers?: [string, string][];
  body?: unknown;
  status?: number;
  jobId?: string;
  /** Raw HTTP response body (on failure) or the trimmed model answer text
   *  (on success) — whichever the caller captured for debugging. */
  description?: string;
  error?: string;
  /** Source-record fields for an uploaded/parse row, for context. */
  record?: Record<string, string>;
  /** Columns a spreadsheet was missing, on a failed validation. */
  missingColumns?: string[];
  /** Columns dropped from the AI record (name → reason), on validation. */
  discardedColumns?: Record<string, string>;
}

export interface LogEvent {
  id: number;
  /** Wall-clock stamp, `HH:MM:SS.mmm`. */
  ts: string;
  label: string;
  /** Short secondary line shown under the label (e.g. Obj. Number). */
  detail?: string;
  /** Response/duration for this stage, when it completed; rendered as Dur. */
  elapsedMs?: number;
  status: LogStatus;
  /** Group key for related events in one job/row. When a terminal event
   *  (`ok`/`fail`) with a `jobId` lands, every prior `busy` event sharing it is
   *  retroactively resolved to the same outcome, so the in-flight dots clear. */
  jobId?: string;
  /** Owning record's job id (`row-<uid>`), set by Rust catalogue stage events.
   *  Correlation key for the viewer's per-record grouping — deliberately
   *  separate from `jobId`, which stays per-call so busy dots resolve per AI
   *  call and a mid-run call's terminal event can't flip another stage. */
  rowId?: string;
  /** Present only for rows that can expand into a verbose payload. */
  verbose?: LogVerbose;
}

const MAX_EVENTS = 500;

// Module-level store. `events` is reassigned (not mutated) on push/clear so
// `useSyncExternalStore` sees a referentially-new snapshot only on change.
let events: LogEvent[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function nowTs(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Append one activity entry; drops the oldest once the cap is reached. When
 *  the event is terminal (`ok`/`fail`) and carries a `jobId`, every prior
 *  `busy` event in the same job is resolved to the same outcome so the
 *  in-flight dots clear in step with the result. */
export function pushLog(
  e: Omit<LogEvent, "id" | "ts"> & Partial<Pick<LogEvent, "ts">>
): void {
  const { ts, ...rest } = e;
  const event: LogEvent = { id: nextId++, ts: ts ?? nowTs(), ...rest };

  // Resolve earlier busy stages of the same job to this terminal outcome.
  if (event.jobId && event.status !== "busy") {
    events = events.map((prev) =>
      prev.jobId === event.jobId && prev.status === "busy"
        ? { ...prev, status: event.status }
        : prev
    );
  }

  events = [...events, event];
  if (events.length > MAX_EVENTS) events = events.slice(events.length - MAX_EVENTS);
  emit();
}

/** Empty the stream. */
export function clearLogs(): void {
  if (events.length === 0) return;
  events = [];
  emit();
}

/** One contiguous run of the stream under a single group key: either one
 *  record's stages (`rowId` set — rendered with a collapsible group header) or
 *  an inline run of general events (absent — rendered with no header). */
export interface LogSection {
  /** The owning record's job id (`row-<uid>`), when every event in this
   *  section belongs to that record. */
  rowId?: string;
  events: LogEvent[];
}

/** Record-correlation key for one event: the Rust-provided `rowId`, else a
 *  row-prefixed `jobId` (the frontend's run events tag themselves `row-<uid>`).
 *  Rust per-call events keep `jobId = ac-N` for busy-dot resolution and must
 *  never group by it. Single authority for "which record does this event
 *  belong to" — the viewer and tests go through here. */
export function logRowKey(e: LogEvent): string | undefined {
  return e.rowId ?? (e.jobId?.startsWith("row-") ? e.jobId : undefined);
}

/** Split the stream into sections at group-key changes, preserving strict
 *  chronology: a record's events form one section only while consecutive — a
 *  straggler of an earlier record starts a second section with the same key
 *  rather than reordering anything. Consecutive keyless events (import,
 *  export, vocab sync) merge into one inline section. */
export function buildLogSections(events: LogEvent[]): LogSection[] {
  const sections: LogSection[] = [];
  for (const e of events) {
    const key = logRowKey(e);
    const last = sections[sections.length - 1];
    // Keyless events merge into a trailing keyless run; keyed events into
    // their record's run. Anything else starts a new section.
    if (last && last.rowId === key) {
      last.events.push(e);
    } else {
      sections.push({ rowId: key, events: [e] });
    }
  }
  return sections;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): LogEvent[] {
  return events;
}

function getErrorCount(): number {
  return events.filter((e) => e.status === "fail").length;
}

/** Live, ordered stream of activity events. */
export function useLogEvents(): LogEvent[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Count of failed entries — drives the TopBar badge. */
export function useLogErrorCount(): number {
  return useSyncExternalStore(subscribe, getErrorCount, getErrorCount);
}
