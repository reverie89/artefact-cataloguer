// Right-side slide-out drawer that streams catalogue-run activity as a table.
//
// One row per stage (upload → validate → parse row → POST → job ID → poll →
// response → populated fields). Rows with a `verbose` envelope expand on click
// to reveal the HTTP request/response detail. Built on the shadcn Sheet
// (Radix), so Esc + backdrop dismiss, focus trapping, and scroll locking are
// handled by the primitive.

import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { clearLogs, useLogEvents, type LogStatus, type LogVerbose } from "../../lib/logs";

interface Props {
  open: boolean;
  onClose: () => void;
}

const STATUS_LABEL: Record<LogStatus, string> = {
  ok: "ok",
  busy: "busy",
  fail: "fail",
};

const STATUS_DOT_CLASS: Record<LogStatus, string> = {
  ok: "bg-emerald-500",
  busy: "bg-amber-500",
  fail: "bg-destructive",
};

function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Pretty-print JSON-ish values without throwing. */
function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function LogsViewer({ open, onClose }: Props) {
  const events = useLogEvents();
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Keep the latest row in view when pinned to the bottom.
  useLayoutEffect(() => {
    if (!open || !autoScroll || !atBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, open, autoScroll]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    atBottomRef.current = bottom;
    if (bottom !== autoScroll) setAutoScroll(bottom);
  };

  const toggle = (id: number) => setExpanded((m) => ({ ...m, [id]: !m[id] }));

  const errorCount = useMemo(() => events.filter((e) => e.status === "fail").length, [events]);

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent className="w-full flex flex-col gap-0 p-0 sm:max-w-[460px]">
        {/* Header */}
        {/* pr-10 keeps the clear-logs button clear of the Sheet's built-in close (X) button */}
        <SheetHeader className="bg-card border-b flex flex-row items-center gap-2.5 space-y-0 px-4 py-3 pr-10">
          <SheetTitle className="text-[15px] font-semibold">Logs Viewer</SheetTitle>
          <Badge variant="secondary" className="text-[11px]">
            {events.length} {events.length === 1 ? "event" : "events"}
          </Badge>
          {errorCount > 0 && (
            <Badge variant="destructive" className="text-[11px]">
              {errorCount} {errorCount === 1 ? "error" : "errors"}
            </Badge>
          )}
          <div className="flex-1" />
          <label className="text-muted-foreground flex cursor-pointer select-none items-center gap-1.5 text-xs">
            <Checkbox checked={autoScroll} onCheckedChange={(v) => setAutoScroll(v === true)} />
            Autoscroll
          </label>
          <Button
            variant="ghost"
            size="icon"
            onClick={clearLogs}
            disabled={events.length === 0}
            title="Clear logs"
            className="size-7"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </SheetHeader>

        {/* Body: streaming table */}
        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {events.length === 0 ? (
            <div className="text-muted-foreground px-5 py-10 text-center text-[13px] leading-relaxed">
              No activity yet.
              <br />
              Upload a file and run a catalogue to stream live progress here.
            </div>
          ) : (
            <table className="w-full table-fixed border-collapse text-[12.5px]">
              <thead className="sticky top-0 z-[1]">
                <tr className="bg-card">
                  {["Time", "Stage", "Dur", "Status"].map((h, i) => (
                    <th
                      key={h}
                      className={cn(
                        "text-muted-foreground border-b p-2 text-[10.5px] font-semibold uppercase tracking-[0.06em]",
                        i === 2 ? "text-right" : "text-left",
                        i === 0 && "w-[100px]",
                        i === 2 && "w-12",
                        i === 3 && "w-[60px]"
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  const hasVerbose = Boolean(e.verbose);
                  const isOpen = Boolean(expanded[e.id]);
                  const clickable = hasVerbose;
                  return (
                    <Fragment key={e.id}>
                      <tr
                        onClick={clickable ? () => toggle(e.id) : undefined}
                        className={cn(
                          "border-border/60 border-b",
                          clickable && "cursor-pointer",
                          isOpen && "bg-primary/10"
                        )}
                      >
                        <td className="text-muted-foreground whitespace-nowrap p-2 text-[11px]">{e.ts}</td>
                        <td className="overflow-hidden p-2 text-foreground">
                          <span className="inline-flex min-w-0 items-center gap-1.5">
                            {hasVerbose &&
                              (isOpen ? <ChevronDown className="text-muted-foreground size-3" /> : <ChevronRight className="text-muted-foreground size-3" />)}
                            <span className="truncate">
                              {e.label}
                              {e.detail && (
                                <span className="text-muted-foreground mt-px block truncate text-[11px]">
                                  {e.detail}
                                </span>
                              )}
                            </span>
                          </span>
                        </td>
                        <td className="text-muted-foreground whitespace-nowrap p-2 text-right text-[11px]">
                          {formatDuration(e.elapsedMs)}
                        </td>
                        <td className="whitespace-nowrap p-2">
                          <span className="inline-flex items-center gap-1.5">
                            <span className={cn("size-2 rounded-full", STATUS_DOT_CLASS[e.status])} />
                            <span className="text-muted-foreground text-[11px]">{STATUS_LABEL[e.status]}</span>
                          </span>
                        </td>
                      </tr>
                      {isOpen && hasVerbose && e.verbose && (
                        <tr key={`${e.id}-v`} className="bg-muted/40">
                          <td colSpan={4} className="border-border p-2.5">
                            <VerboseBlock verbose={e.verbose} elapsedMs={e.elapsedMs} label={e.label} detail={e.detail} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer: legend */}
        <div className="text-muted-foreground border-border flex items-center gap-3.5 border-t p-2 px-4 text-[11px]">
          {(["ok", "busy", "fail"] as LogStatus[]).map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5">
              <span className={cn("size-2 rounded-full", STATUS_DOT_CLASS[s])} />
              {STATUS_LABEL[s]}
            </span>
          ))}
          <div className="flex-1" />
          <span>Click a row for request/response detail</span>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Expanded HTTP/row envelope rendered beneath a clicked table row. */
function VerboseBlock({
  verbose,
  elapsedMs,
  label,
  detail,
}: {
  verbose: LogVerbose;
  elapsedMs?: number;
  label?: string;
  detail?: string;
}) {
  const hasStage = Boolean(label || detail);
  const hasRequest = Boolean(verbose.method || verbose.url || verbose.headers || verbose.body);
  const hasResponse = Boolean(
    verbose.status !== undefined || verbose.error || verbose.jobId || elapsedMs !== undefined
  );
  const hasDescription = Boolean(verbose.description);
  const hasRecord = Boolean(verbose.record && Object.keys(verbose.record).length);
  const hasMissing = Boolean(verbose.missingColumns && verbose.missingColumns.length);
  const hasDiscarded = Boolean(verbose.discardedColumns && Object.keys(verbose.discardedColumns).length);

  return (
    <div className="bg-background rounded-md border p-2.5 text-[11.5px] leading-relaxed">
      {hasStage && (
        <div className={cn((hasRequest || hasResponse || hasDescription || hasRecord || hasMissing || hasDiscarded) && "mb-2")}>
          {label && <Line label="stage" value={label} />}
          {detail && <Line label="detail" value={detail} />}
        </div>
      )}
      {hasRequest && (
        <div className={cn((hasResponse || hasDescription || hasRecord || hasMissing || hasDiscarded) && "mb-2")}>
          <div className="text-primary mb-1 font-semibold">Request</div>
          {verbose.method && verbose.url && <Line label={verbose.method} value={verbose.url} />}
          {verbose.headers && <Line label="headers" value={verbose.headers.map(([k, v]) => `${k}: ${v}`).join("\n")} />}
          {verbose.body !== undefined && (
            <Line label="body" value={safeStringify(verbose.body)} />
          )}
        </div>
      )}
      {hasResponse && (
        <div className={cn((hasDescription || hasRecord || hasMissing || hasDiscarded) && "mb-2")}>
          <div className="text-primary mb-1 font-semibold">Response</div>
          {verbose.status !== undefined && <Line label="status" value={verbose.status} />}
          {elapsedMs !== undefined && <Line label="elapsed" value={formatDuration(elapsedMs)} />}
          {verbose.jobId && <Line label="job_id" value={verbose.jobId} />}
          {verbose.error && <Line label="error" value={verbose.error} />}
        </div>
      )}
      {hasDescription && (
        <div className={cn((hasRecord || hasMissing || hasDiscarded) && "mb-2")}>
          <div className="text-primary mb-1 font-semibold">Model output</div>
          <Line label="text" value={verbose.description} />
        </div>
      )}
      {hasRecord && (
        <div className={cn((hasMissing || hasDiscarded) && "mb-2")}>
          <div className="text-primary mb-1 font-semibold">Source fields</div>
          {Object.entries(verbose.record!).map(([k, v]) => (
            <Line key={k} label={k} value={v} />
          ))}
        </div>
      )}
      {hasMissing && (
        <div className={cn(hasDiscarded && "mb-2")}>
          <div className="text-destructive mb-1 font-semibold">Missing columns</div>
          <Line label="missing" value={verbose.missingColumns!.join(", ")} />
        </div>
      )}
      {hasDiscarded && (
        <div>
          <div className="text-amber-600 dark:text-amber-400 mb-1 font-semibold">Discarded fields</div>
          {Object.entries(verbose.discardedColumns!).map(([k, v]) => (
            <Line key={k} label={k} value={v} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One label/value row inside a verbose block. */
function Line({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="mb-0.5 flex gap-2">
      <span className="text-muted-foreground w-16 shrink-0">{label}</span>
      <span className="min-w-0 break-words whitespace-pre-wrap">{value}</span>
    </div>
  );
}
