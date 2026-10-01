import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusIndicator } from "./SaveActions";

/** Outcome of a provider Test Connection, shared by the vision and embedding
 *  provider sections. */
export type TestStatus = "testing" | "ok" | "err" | null;

/** Compact badge for the card-list's Status column. */
export function StatusBadge({ status }: { status: TestStatus }) {
  if (status === "ok") return <Badge variant="default" className="w-fit gap-1 tracking-[0.04em]"><CheckCircle2 className="size-2.5" />Connected</Badge>;
  if (status === "err") return <Badge variant="destructive" className="w-fit gap-1 tracking-[0.04em]"><XCircle className="size-2.5" />Failed</Badge>;
  if (status === "testing") return <Badge variant="secondary" className="w-fit gap-1 tracking-[0.04em]"><Loader2 className="size-2.5 animate-spin" />Testing…</Badge>;
  return <Badge variant="secondary" className="w-fit tracking-[0.04em]">Not tested</Badge>;
}

/** Inline indicator shown beside the Test Connection button; `dimensions`
 *  annotates the embedding path's learned vector width. */
export function ConnectionStatus({ status, dimensions }: { status: TestStatus; dimensions?: number | null }) {
  const message = status === "testing"
    ? "Testing connection…"
    : status === "ok"
      ? `Connection successful${dimensions ? ` (dims: ${dimensions})` : ""}`
      : status === "err"
        ? "Failed — check URL and API key"
        : "No status";
  return <StatusIndicator state={status === "testing" ? "busy" : status} message={message} />;
}
