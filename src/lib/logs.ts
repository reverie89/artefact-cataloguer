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
