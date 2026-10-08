import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusIndicator } from "./SaveActions";

/** Outcome of a provider Test Connection, shared by the vision and embedding
 *  provider sections. */
export type TestStatus = "testing" | "ok" | "err" | null;

/** Provider errors arrive as `HTTP <code>: <body>` — the body can be a long
 *  JSON blob, so the inline indicator caps it and the full text goes to the
 *  hover tooltip. */
const MAX_ERROR_CHARS = 160;

/** Compact badge for the card-list's Status column. `error` (when present)
 *  is attached as the hover tooltip on the Failed badge. */
export function StatusBadge({ status, error }: { status: TestStatus; error?: string }) {
  if (status === "ok") return <Badge variant="default" className="w-fit gap-1 tracking-[0.04em]"><CheckCircle2 className="size-2.5" />Connected</Badge>;
  if (status === "err") return <Badge variant="destructive" title={error} className="w-fit gap-1 tracking-[0.04em]"><XCircle className="size-2.5" />Failed</Badge>;
  if (status === "testing") return <Badge variant="secondary" className="w-fit gap-1 tracking-[0.04em]"><Loader2 className="size-2.5 animate-spin" />Testing…</Badge>;
  return <Badge variant="secondary" className="w-fit tracking-[0.04em]">Not tested</Badge>;
}

/** Inline indicator shown beside the Test Connection button; `dimensions`
 *  annotates the embedding path's learned vector width and `error` shows the
 *  provider's actual failure text (falling back to the generic hint only when
 *  the backend gave none). */
export function ConnectionStatus({ status, dimensions, error }: { status: TestStatus; dimensions?: number | null; error?: string }) {
  const detail = error && error.length > MAX_ERROR_CHARS ? `${error.slice(0, MAX_ERROR_CHARS)}…` : error;
  const message = status === "testing"
    ? "Testing connection…"
    : status === "ok"
      ? `Connection successful${dimensions ? ` (dims: ${dimensions})` : ""}`
      : status === "err"
        ? (detail || "Failed — check URL and API key")
        : "No status";
  return <StatusIndicator
    state={status === "testing" ? "busy" : status}
    message={message}
    title={status === "err" && error && error.length > MAX_ERROR_CHARS ? error : undefined}
  />;
}
