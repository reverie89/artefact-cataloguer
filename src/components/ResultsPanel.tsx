import { Download, Package, RotateCcw, Search } from "lucide-react";
import type { AppActions } from "../app/actions";
import type { AppState } from "../app/state";
import { ResultRow } from "./ResultRow";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Props {
  state: AppState;
  actions: AppActions;
  convertFileSrc: (path: string) => string;
}

export function ResultsPanel({ state, actions, convertFileSrc }: Props) {
  const q = state.resultsSearch.toLowerCase();
  const failedCount = state.results.filter((r) => r.status === "error").length;
  const filtered = state.results.filter((r) => {
    if (state.resultsFilter !== "all" && r.status !== state.resultsFilter) return false;
    if (q) return r.id.toLowerCase().includes(q) || r.title.toLowerCase().includes(q) || r.category.toLowerCase().includes(q);
    return true;
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* Sticky header */}
      <div className="bg-card border-b sticky top-0 z-10 flex shrink-0 items-center gap-2 px-5 py-2.25">
        <span className="text-muted-foreground text-xs font-semibold uppercase tracking-[0.12em]">Results</span>
        <Badge variant="secondary" className="text-[13px]">{filtered.length}</Badge>
        <div className="bg-input focus-within:ring-ring/20 relative flex min-w-0 flex-1 items-center overflow-hidden rounded-md">
          <Search className="text-muted-foreground absolute left-2.5 size-3.5" />
          <Input
            value={state.resultsSearch}
            onChange={actions.setSearch}
            placeholder="Search artefacts…"
            className="border-0 bg-transparent pl-8 shadow-none focus-visible:ring-0"
          />
        </div>
        <Select value={state.resultsFilter} onValueChange={(v) => actions.setFilter({ target: { value: v } } as React.ChangeEvent<HTMLSelectElement>)}>
          <SelectTrigger className="text-muted-foreground h-8 w-auto gap-1 text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="done">Done</SelectItem>
            <SelectItem value="processing">Processing</SelectItem>
            <SelectItem value="queued">Queued</SelectItem>
            <SelectItem value="error">Error</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        {failedCount > 0 && (
          <Button onClick={() => void actions.retryAllFailed()} variant="secondary" size="sm">
            <RotateCcw className="size-3" />
            <span>Retry failed</span>
            <Badge variant="secondary" className="text-[12px]">{failedCount}</Badge>
          </Button>
        )}
        <Button onClick={() => void actions.exportResults()} variant="secondary" size="sm">
          <Download className="size-3" />
          <span>Export</span>
        </Button>
      </div>
      {/* Column header */}
      <div className="bg-muted/30 border-border/60 grid grid-cols-[80px_1fr] shrink-0 border-b px-5 py-1.5">
        {["S/N", "Status"].map((h) => (
          <span key={h} className="text-muted-foreground text-xs uppercase tracking-[0.1em]">{h}</span>
        ))}
      </div>

      {state.parseStatus === "idle" ? (
        <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 px-5 py-20 text-center">
          <Package className="size-7" />
          <div className="text-base leading-relaxed">
            Upload files and click <strong className="text-muted-foreground font-medium">Parse</strong><br />to see AI-generated results here
          </div>
        </div>
      ) : (
        filtered.map((row, i) => (
          <ResultRow key={row.uid} row={row} index={i + 1} state={state} actions={actions} convertFileSrc={convertFileSrc} />
        ))
      )}
    </div>
  );
}
