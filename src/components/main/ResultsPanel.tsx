import { AlertCircle, Ban, Download, FileSpreadsheet, Package, RotateCcw, Search, SearchX, SlidersHorizontal, Trash2, X, Zap } from "lucide-react";
import { useState } from "react";
import type { AppActions } from "../../app/actions";
import type { AppState } from "../../app/state";
import type { ArtefactRow } from "../../app/types";
import { recordValueFor } from "../../lib/spreadsheet";
import { ResultRow } from "./ResultRow";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface Props {
  state: AppState;
  actions: AppActions;
  convertFileSrc: (path: string) => string;
}

export function ResultsPanel({ state, actions, convertFileSrc }: Props) {
  const { settings } = state;
  const q = state.resultsSearch.toLowerCase();
  // Retryable = rows that never reached `done`: AI failures plus rows the user
  // stopped (a stop leaves them cancelled; Retry sends them back to the queue).
  const failedCount = state.results.filter((r) => r.status === "error" || r.status === "cancelled").length;
  const queuedCount = state.results.filter((r) => r.status === "queued").length;
  const matches = (r: ArtefactRow) => {
    if (state.resultsFilter !== "all" && r.status !== state.resultsFilter) return false;
    if (!q) return true;
    // Search the user-selected columns only: AF columns read from the parsed
    // `record` (case-insensitive header lookup, mirroring the parser/export),
    // catalogue fields read from the manual selection or the first AI
    // suggestion. Both are scoped by the picker — nothing is searched that the
    // user hasn't opted into.
    const record = r.record ?? {};
    const afHit = settings.artefactFields
      .filter((f) => state.searchColsAf.includes(f.id))
      .some((f) => recordValueFor(record, f.name).toLowerCase().includes(q));
    const catHit = settings.fields
      .filter((f) => state.searchColsCat.includes(f.id))
      .some((f) => {
        const sel = state.fieldSelections[`${r.uid}_${f.id}`];
        const ai = state.aiResults[r.uid]?.[f.name]?.[0]?.value || "";
        return (sel?.value || ai).toLowerCase().includes(q);
      });
    return afHit || catHit;
  };

  // Rows grouped by source file, in import order (rows of one import are
  // contiguous in `results`, so consecutive-run grouping is exact). Filtering
  // applies within groups; a group nothing matches disappears from the list.
  const groups: { fileId: string; sourceName: string; rows: ArtefactRow[] }[] = [];
  for (const r of state.results) {
    if (!matches(r)) continue;
    const last = groups[groups.length - 1];
    if (last && last.fileId === r.fileId) last.rows.push(r);
    else groups.push({ fileId: r.fileId, sourceName: r.sourceName, rows: [r] });
  }
  const visibleCount = groups.reduce((n, g) => n + g.rows.length, 0);

  // fileId whose delete-all confirmation is currently open: the whole group
  // tints so the target stays identifiable behind the dialog. deleteFileRows
  // resolves exactly when the dialog closes (either answer).
  const [confirmingDeleteFileId, setConfirmingDeleteFileId] = useState<string | null>(null);
  const handleDeleteGroup = async (fileId: string) => {
    setConfirmingDeleteFileId(fileId);
    try {
      await actions.deleteFileRows(fileId);
    } finally {
      setConfirmingDeleteFileId(null);
    }
  };

  const afAll = settings.artefactFields.length > 0 && state.searchColsAf.length === settings.artefactFields.length;
  const catAll = settings.fields.length > 0 && state.searchColsCat.length === settings.fields.length;
  // The search/filter/export row + the S/N|Status column header only mean
  // something when there are result rows. Gated on the source list (not the
  // filtered one) so the row stays visible when a query hides every row —
  // the user still needs to clear the search.
  const hasResults = state.results.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* Sticky header — only when there are result rows to act on. */}
      {hasResults && (
      <div className="bg-card border-b sticky top-0 z-10 flex shrink-0 items-center gap-2 px-5 py-2.25">
        <span className="text-muted-foreground text-xs font-semibold uppercase tracking-[0.12em]">Results</span>
        <Badge variant="secondary" className="text-[13px]">{visibleCount}</Badge>
        {/* Column picker — multi-select across AF and catalogue columns, scoped
            to the search box. The trigger shows a count of active columns so
            the scope is visible without opening the popover. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5">
              <SlidersHorizontal className="size-3" />
              <span>Columns</span>
              <Badge variant="secondary" className="text-[12px]">{state.searchColsAf.length + state.searchColsCat.length}</Badge>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel className="flex items-center justify-between">
              <span>Artefact File</span>
              <button
                type="button"
                onClick={() => actions.setSearchColsAf(afAll ? [] : settings.artefactFields.map((f) => f.id))}
                className="text-primary hover:text-primary/80 text-[11px] font-medium normal-case tracking-normal"
              >
                {afAll ? "Clear" : "All"}
              </button>
            </DropdownMenuLabel>
            {settings.artefactFields.length === 0 ? (
              <div className="text-muted-foreground px-2 py-1 text-[13px] italic">No columns configured</div>
            ) : settings.artefactFields.map((f) => (
              <DropdownMenuCheckboxItem
                key={f.id}
                checked={state.searchColsAf.includes(f.id)}
                onCheckedChange={() => actions.toggleSearchColAf(f.id)}
                onSelect={(e) => e.preventDefault()}
              >
                {f.name || "Untitled column"}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center justify-between">
              <span>Catalogue Fields</span>
              <button
                type="button"
                onClick={() => actions.setSearchColsCat(catAll ? [] : settings.fields.map((f) => f.id))}
                className="text-primary hover:text-primary/80 text-[11px] font-medium normal-case tracking-normal"
              >
                {catAll ? "Clear" : "All"}
              </button>
            </DropdownMenuLabel>
            {settings.fields.length === 0 ? (
              <div className="text-muted-foreground px-2 py-1 text-[13px] italic">No fields configured</div>
            ) : settings.fields.map((f) => (
              <DropdownMenuCheckboxItem
                key={f.id}
                checked={state.searchColsCat.includes(f.id)}
                onCheckedChange={() => actions.toggleSearchColCat(f.id)}
                onSelect={(e) => e.preventDefault()}
              >
                {f.name || "Untitled field"}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
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
        {state.queueRunning ? (
          <Button onClick={() => void actions.stopQueue()} variant="outline" size="sm">
            <Ban className="size-3" />
            <span>Stop</span>
          </Button>
        ) : queuedCount > 0 && (
          /* Pulses while rows wait for a start, so a fresh import draws the
             eye to the one control needed next. */
          <Button onClick={() => void actions.startQueue()} size="sm" className="animate-pulse">
            <Zap className="size-3" />
            <span>Start</span>
          </Button>
        )}
        {failedCount > 0 && (
          <Button onClick={actions.retryFailed} variant="secondary" size="sm">
            <RotateCcw className="size-3" />
            <span>Retry</span>
            <Badge variant="secondary" className="text-[12px]">{failedCount}</Badge>
          </Button>
        )}
        <Button onClick={() => void actions.exportResults()} variant="secondary" size="sm">
          <Download className="size-3" />
          <span>Export</span>
        </Button>
      </div>
      )}
      {/* Run/export feedback lives here, next to the controls that trigger it:
          queue pre-flight failures (Start) and blocked exports (Export). */}
      {hasResults && state.parseError && (
        <AlertBanner message={state.parseError} onDismiss={actions.dismissParseError} />
      )}
      {hasResults && state.exportWarning && (
        <AlertBanner message={state.exportWarning} onDismiss={actions.dismissExportWarning} />
      )}
      {/* Column header — table chrome for the rows above; hidden alongside it. */}
      {hasResults && (
      <div className="bg-muted/30 border-border/60 grid grid-cols-[80px_1fr] shrink-0 border-b px-5 py-1.5">
        {["S/N", "Status"].map((h) => (
          <span key={h} className="text-muted-foreground text-xs uppercase tracking-[0.1em]">{h}</span>
        ))}
      </div>
      )}

      {!hasResults ? (
        <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 px-5 py-20 text-center">
          <Package className="size-7" />
          <div className="text-base leading-relaxed">
            Import an artefact file above —<br />its records will appear here, grouped by file
          </div>
        </div>
      ) : visibleCount === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 px-5 py-20 text-center">
          <SearchX className="size-7" />
          <div className="text-base leading-relaxed">
            {state.searchColsAf.length + state.searchColsCat.length === 0
              ? <>No matches — <strong className="text-muted-foreground font-medium">select at least one column</strong><br />to search, or clear your search</>
              : <>No matches — try a different search or filter</>}
          </div>
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.fileId} className={cn(confirmingDeleteFileId === g.fileId && "bg-destructive/10")}>
            <div className="bg-muted/30 border-border/60 flex shrink-0 items-center gap-2 border-b px-5 py-1.5">
              <FileSpreadsheet className="text-primary size-3.5 shrink-0" />
              <span className="text-muted-foreground min-w-0 truncate text-[13px] font-medium">{g.sourceName}</span>
              <Badge variant="secondary" className="text-[11px]">{g.rows.length} record{g.rows.length === 1 ? "" : "s"}</Badge>
              <span className="flex-1" />
              <Button
                onClick={() => void handleDeleteGroup(g.fileId)}
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete all records from ${g.sourceName}`}
                className={cn("text-muted-foreground hover:text-destructive", confirmingDeleteFileId === g.fileId && "text-destructive")}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
            {g.rows.map((row, i) => (
              <ResultRow key={row.uid} row={row} index={i + 1} state={state} actions={actions} convertFileSrc={convertFileSrc} />
            ))}
          </div>
        ))
      )}
    </div>
  );
}

/** Blocking, dismissible, destructive notice — the shared treatment for the
    queue pre-flight error and the export warning. */
function AlertBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <Card className="bg-destructive/10 border-destructive/20 mx-5 my-2 rounded-md py-2.5">
      <div className="flex items-start gap-1.25 px-3">
        <AlertCircle className="text-destructive mt-0.5 size-3 shrink-0" />
        <div className="text-destructive flex-1 text-sm">{message}</div>
        <Button
          onClick={onDismiss}
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-destructive -mt-1 -mr-1 size-6"
        >
          <X className="size-3" />
        </Button>
      </div>
    </Card>
  );
}
