import { Download, Package, RotateCcw, Search, SearchX, SlidersHorizontal } from "lucide-react";
import type { AppActions } from "../../app/actions";
import type { AppState } from "../../app/state";
import { ResultRow } from "./ResultRow";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

interface Props {
  state: AppState;
  actions: AppActions;
  convertFileSrc: (path: string) => string;
}

export function ResultsPanel({ state, actions, convertFileSrc }: Props) {
  const { settings } = state;
  const q = state.resultsSearch.toLowerCase();
  const failedCount = state.results.filter((r) => r.status === "error").length;
  const filtered = state.results.filter((r) => {
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
      .some((f) => {
        const k = Object.keys(record).find((kk) => kk.toLowerCase() === f.name.toLowerCase());
        return !!k && record[k].toLowerCase().includes(q);
      });
    const catHit = settings.fields
      .filter((f) => state.searchColsCat.includes(f.id))
      .some((f) => {
        const sel = state.fieldSelections[`${r.uid}_${f.id}`];
        const ai = state.aiResults[r.uid]?.[f.name]?.[0]?.value || "";
        return (sel?.value || ai).toLowerCase().includes(q);
      });
    return afHit || catHit;
  });

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
        <Badge variant="secondary" className="text-[13px]">{filtered.length}</Badge>
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
      )}
      {/* Column header — table chrome for the rows above; hidden alongside it. */}
      {hasResults && (
      <div className="bg-muted/30 border-border/60 grid grid-cols-[80px_1fr] shrink-0 border-b px-5 py-1.5">
        {["S/N", "Status"].map((h) => (
          <span key={h} className="text-muted-foreground text-xs uppercase tracking-[0.1em]">{h}</span>
        ))}
      </div>
      )}

      {state.parseStatus === "idle" ? (
        <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 px-5 py-20 text-center">
          <Package className="size-7" />
          <div className="text-base leading-relaxed">
            Upload files and click <strong className="text-muted-foreground font-medium">Parse</strong><br />to see AI-generated results here
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 px-5 py-20 text-center">
          <SearchX className="size-7" />
          <div className="text-base leading-relaxed">
            {state.searchColsAf.length + state.searchColsCat.length === 0
              ? <>No matches — <strong className="text-muted-foreground font-medium">select at least one column</strong><br />to search, or clear your search</>
              : <>No matches — try a different search or filter</>}
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
