// Right-side slide-out drawer that streams catalogue-run activity as a table.
//
// The stream is split into sections (lib/logs `buildLogSections`): one
// record's stages sit under a collapsible header labelled from its captured
// source record; general events (import, export, vocab sync) stay inline
// between them with no header. Rows with a `verbose` envelope expand on click
// to reveal the HTTP request/response detail (LogsVerboseBlock). Built on the
// shadcn Sheet (Radix), so Esc + backdrop dismiss, focus trapping, and scroll
// locking are handled by the primitive.

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
import { cn, formatDuration } from "@/lib/utils";
import { rowLabel } from "../../app/actions";
import {
  buildLogSections,
  clearLogs,
  useLogEvents,
  type LogEvent,
  type LogSection,
  type LogStatus,
} from "../../lib/logs";
import { LogsVerboseBlock } from "./LogsVerboseBlock";

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

export function LogsViewer({ open, onClose }: Props) {
  const events = useLogEvents();
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
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
  const toggleGroup = (key: string) =>
    setCollapsedGroups((m) => ({ ...m, [key]: !m[key] }));

  const errorCount = useMemo(() => events.filter((e) => e.status === "fail").length, [events]);
  const sections = useMemo(() => buildLogSections(events), [events]);

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
                {sections.map((section) =>
                  section.rowId === undefined ? (
                    <Fragment key={`general-${section.events[0].id}`}>
                      {section.events.map((e) => (
                        <EventRow key={e.id} e={e} isOpen={!!expanded[e.id]} onToggle={toggle} />
                      ))}
                    </Fragment>
                  ) : (
                    <Fragment key={`${section.rowId}-${section.events[0].id}`}>
                      <GroupHeaderRow
                        section={section}
                        collapsed={!!collapsedGroups[section.rowId]}
                        onToggle={toggleGroup}
                      />
                      {!collapsedGroups[section.rowId] &&
                        section.events.map((e) => (
                          <EventRow key={e.id} e={e} isOpen={!!expanded[e.id]} onToggle={toggle} />
                        ))}
                    </Fragment>
                  )
                )}
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

/** One collapsible group header for a record's section: label derived from the
 *  group's first captured source record (via the shared `rowLabel` authority)
 *  so the name survives row deletion and edits. */
function GroupHeaderRow({
  section,
  collapsed,
  onToggle,
}: {
  section: LogSection;
  collapsed: boolean;
  onToggle: (key: string) => void;
}) {
  const record = section.events.find((e) => e.verbose?.record)?.verbose?.record;
  const label = record ? rowLabel({ record }) : "Row";
  return (
    <tr
      onClick={() => onToggle(section.rowId!)}
      className="bg-muted/50 border-border/60 cursor-pointer border-b"
    >
      <td colSpan={4} className="p-2 pl-2.5">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {collapsed ? (
            <ChevronRight className="text-muted-foreground size-3 shrink-0" />
          ) : (
            <ChevronDown className="text-muted-foreground size-3 shrink-0" />
          )}
          <span className="text-foreground truncate text-[12px] font-medium">{label}</span>
          <span className="text-muted-foreground shrink-0 text-[11px]">
            · {section.events.length} {section.events.length === 1 ? "event" : "events"}
          </span>
        </span>
      </td>
    </tr>
  );
}

/** One stream event as a table row; rows with a `verbose` envelope expand into
 *  a LogsVerboseBlock beneath. */
function EventRow({ e, isOpen, onToggle }: { e: LogEvent; isOpen: boolean; onToggle: (id: number) => void }) {
  const hasVerbose = Boolean(e.verbose);
  return (
    <Fragment>
      <tr
        onClick={hasVerbose ? () => onToggle(e.id) : undefined}
        className={cn(
          "border-border/60 border-b",
          hasVerbose && "cursor-pointer",
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
        <tr className="bg-muted/40">
          <td colSpan={4} className="border-border p-2.5">
            <LogsVerboseBlock verbose={e.verbose} elapsedMs={e.elapsedMs} label={e.label} detail={e.detail} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}
