// Expanded request/response envelope for one Logs Viewer row, extracted from
// LogsViewer.tsx so the drawer's table rendering stays lean. Pure
// presentation over the captured `LogVerbose` payload — no state.

import { cn, formatDuration } from "@/lib/utils";
import type { LogVerbose } from "../../lib/logs";

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

/** Expanded HTTP/row envelope rendered beneath a clicked table row. */
export function LogsVerboseBlock({
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
