import { Ban, Check, ChevronDown, ChevronUp, Image as ImageIcon, Loader2, Plus, RotateCcw, Search, X, XCircle, Zap } from "lucide-react";
import { useState } from "react";
import type { AppActions } from "../app/actions";
import type { AppState } from "../app/state";
import type { ArtefactRow } from "../app/types";
import { _ST } from "../app/defaults";
import { vterms } from "../app/styles";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ImageLightbox } from "@/components/ImageLightbox";
import { cn } from "@/lib/utils";

interface Props {
  row: ArtefactRow;
  state: AppState;
  actions: AppActions;
  convertFileSrc: (path: string) => string;
}

export function ResultRow({ row, state, actions, convertFileSrc }: Props) {
  const st = _ST[row.status || "queued"] || _ST.queued;
  const expanded = !!state.expandedRows[row.uid];

  // Track asset-protocol load failures so a blocked/missing image falls back to
  // the "no image" box instead of leaving the raw broken-image glyph on screen.
  const [imgFailed, setImgFailed] = useState(false);

  // Transient per-row lightbox open state — local, not in global AppState.
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // Source record columns: parsed rows expose every configured column via
  // `row.record` (already excluding the image column). Demo seed rows carry no
  // record, so fall back to their structured props.
  const sourceFields =
    row.record && Object.keys(row.record).length
      ? Object.entries(row.record).map(([k, v]) => ({ key: k, value: String(v) }))
      : [
          { key: "Obj. Number", value: row.id },
          { key: "Title", value: row.title },
          { key: "Category", value: row.category },
          { key: "Alt. Number", value: row.altNo || "—" },
          { key: "Acquired", value: row.acquired || "—" },
          { key: "Dimensions", value: row.dimensions || "—" },
        ];

  return (
    <div className="border-border/60 border-b">
      <div
        onClick={() => actions.toggleRow(row.uid)}
        className="grid min-w-0 cursor-pointer grid-cols-[90px_1fr_150px_115px] items-center overflow-hidden px-5 py-2.5"
      >
        <span className="text-muted-foreground truncate text-sm">{row.id}</span>
        <span className="truncate min-w-0 text-[15px]">{row.title}</span>
        <span className="text-muted-foreground truncate text-sm">{row.category}</span>
        <div className="flex items-center gap-1.25">
          <span
            className={cn("size-1.5 rounded-full", row.status === "processing" && "animate-pulse")}
            style={{ background: st.clr }}
          />
          <span className="text-muted-foreground text-[13px]">{st.label}</span>
          <span className="ml-auto flex items-center">
            {expanded ? <ChevronUp className="size-3 text-primary" /> : <ChevronDown className="text-muted-foreground size-3" />}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="bg-muted/30 border-l-primary/30 border-border/60 animate-in fade-in border-t border-l-[3px] duration-150">
          {/* Source record + image */}
          <div className="border-border/60 grid grid-cols-[1fr_210px] border-b">
            <div className="border-border/60 p-3 pr-4.5 border-r">
              <div className="text-muted-foreground mb-2 text-[11px] font-semibold uppercase tracking-[0.12em]">Source Record</div>
              {sourceFields.map((sf) => (
                <div key={sf.key} className="border-border/60 grid grid-cols-[110px_1fr] gap-1.5 border-b py-1">
                  <span className="text-muted-foreground pt-0.25 text-[11px] uppercase tracking-[0.05em]">{sf.key}</span>
                  <span className="text-foreground text-sm [overflow-wrap:anywhere] [word-break:break-word]">{sf.value}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-1.5 p-3">
              <div className="text-muted-foreground text-[11px] font-semibold uppercase tracking-[0.12em]">Image</div>
              {row.imagePath && !imgFailed ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setLightboxOpen(true); }}
                  aria-label="Open image preview"
                  className="bg-muted hover:bg-accent w-full cursor-zoom-in overflow-hidden rounded-md border transition-colors"
                >
                  <img
                    src={convertFileSrc(row.imagePath)}
                    alt={row.id}
                    className="w-full object-contain max-h-[200px]"
                    onError={() => setImgFailed(true)}
                  />
                </button>
              ) : (
                <div className="bg-muted text-muted-foreground flex min-h-22.5 flex-col items-center justify-center gap-1.25 rounded-md border p-2.5">
                  <ImageIcon className="size-5" />
                  <span className="text-center text-[11px] leading-tight [word-break:break-all]">no image</span>
                </div>
              )}
            </div>
          </div>

          {row.status === "done" && (
            <CatalogueFields row={row} state={state} actions={actions} />
          )}
          {row.status === "processing" && (
            <div className="text-muted-foreground flex items-center gap-2 px-4.5 py-3.5 text-sm">
              <Loader2 className="size-3 animate-spin" />
              <span>Running AI on artefact…</span>
              <Button
                onClick={(e) => { e.stopPropagation(); void actions.stopRow(row.uid); }}
                variant="outline"
                size="xs"
                className="ml-1"
              >
                <Ban className="size-3" />
                <span>Stop</span>
              </Button>
            </div>
          )}
          {row.status === "queued" && (
            <div className="text-muted-foreground px-4.5 py-3.5 text-sm">Queued</div>
          )}
          {row.status === "cancelled" && (
            <div className="text-muted-foreground flex items-center gap-2 px-4.5 py-3.5 text-sm">
              <span>Cancelled</span>
              <Button
                onClick={(e) => { e.stopPropagation(); void actions.retryRow(row.uid); }}
                variant="outline"
                size="xs"
                className="ml-1"
              >
                <RotateCcw className="size-3" />
                <span>Retry</span>
              </Button>
            </div>
          )}
          {row.status === "error" && (
            <div className="text-destructive flex items-center gap-2 px-4.5 py-3.5 text-sm">
              <XCircle className="size-3.5" />
              <span>Processing failed — check Logs Viewer</span>
              <Button
                onClick={(e) => { e.stopPropagation(); void actions.retryRow(row.uid); }}
                variant="outline"
                size="xs"
                className="ml-1"
              >
                <RotateCcw className="size-3" />
                <span>Retry</span>
              </Button>
            </div>
          )}
        </div>
      )}

      {row.imagePath && (
        <ImageLightbox
          src={convertFileSrc(row.imagePath)}
          alt={row.id}
          open={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </div>
  );
}

function CatalogueFields({ row, state, actions }: { row: ArtefactRow; state: AppState; actions: AppActions }) {
  const activeProvName = state.settings.providers.find((p) => p.id === state.settings.activeProvider)?.name || "AI";
  return (
    <div className="flex flex-col gap-3 px-4.5 py-3.5">
      <div className="text-muted-foreground flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.12em]">
        <span>Catalogue Fields</span>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 normal-case tracking-normal">
            <Zap className="size-3 text-primary" />
            <span className="text-muted-foreground text-[11px] font-normal">{activeProvName}</span>
          </div>
          <Button
            onClick={(e) => { e.stopPropagation(); void actions.retryRow(row.uid); }}
            variant="outline"
            size="xs"
          >
            <RotateCcw className="size-3" />
            <span>Retry</span>
          </Button>
        </div>
      </div>
      {state.settings.fields.map((f) => {
        const key = `${row.uid}_${f.id}`;
        const aiSugs = ((state.aiResults[row.uid] || {})[f.name] || []).slice().sort((a, b) => b.confidence - a.confidence);
        const sel = state.fieldSelections[key];
        return (
          <FieldControl
            key={f.id}
            field={f}
            fieldKey={key}
            aiSugs={aiSugs}
            sel={sel}
            open={!!state.fieldDropdownOpen[key]}
            search={state.fieldDropdownSearch[key] || ""}
            state={state}
            actions={actions}
          />
        );
      })}
    </div>
  );
}

interface FieldControlProps {
  field: import("../app/types").CatalogueField;
  fieldKey: string;
  aiSugs: { value: string; confidence: number }[];
  sel: import("../app/types").FieldSelection | undefined;
  open: boolean;
  search: string;
  state: AppState;
  actions: AppActions;
}

function FieldControl({ field, fieldKey, aiSugs, sel, open, search, state, actions }: FieldControlProps) {
  const srch = search.toLowerCase();
  const vocabTerms = field.type === "vocab" ? vterms(field, state.settings.vocabularyLists) : [];
  const vocabTermMap = new Map(vocabTerms.map((vt) => [vt.term.toLowerCase(), vt.listName]));
  const aiValues = new Set(aiSugs.map((s) => s.value.toLowerCase()));
  const selectedValues = new Set((sel?.values || []).map((v) => v.toLowerCase()));

  const aiItems = aiSugs
    .filter((s) => !srch || s.value.toLowerCase().includes(srch))
    .map((s) => ({
      value: s.value,
      pct: Math.round(s.confidence * 100) + "%",
      confidence: s.confidence,
      sourceName: field.type === "vocab" ? vocabTermMap.get(s.value.toLowerCase()) || "" : "AI",
      selected: selectedValues.has(s.value.toLowerCase()),
      onPick: () => actions.toggleFieldValue(fieldKey, s.value, "ai", "AI", s.confidence),
    }));
  const vocabItems = vocabTerms
    .filter((vt) => !aiValues.has(vt.term.toLowerCase()) && (!srch || vt.term.toLowerCase().includes(srch)))
    .sort((a, b) => a.term.localeCompare(b.term))
    .map((vt) => ({
      value: vt.term,
      sourceName: vt.listName,
      selected: selectedValues.has(vt.term.toLowerCase()),
      onPick: () => actions.toggleFieldValue(fieldKey, vt.term, "vocab", vt.listName, null),
    }));

  const hasExact = aiItems.some((i) => i.value.toLowerCase() === search.toLowerCase()) || vocabItems.some((i) => i.value.toLowerCase() === search.toLowerCase());
  const showUseTyped = search.trim().length > 0 && !hasExact;
  const selBadge = sel
    ? sel.values.length > 1
      ? `${sel.values.length} selected`
      : sel.source === "ai"
        ? `AI · ${sel.confidence ? Math.round(sel.confidence * 100) + "%" : ""}`.trim()
        : sel.source === "manual"
          ? "Custom"
          : sel.listName || "Vocab"
    : "";

  return (
    <div>
      <div className="text-muted-foreground mb-1.25 flex items-center gap-1.5 text-[11px] uppercase tracking-[0.08em]">
        <span>{field.name}</span>
        <Badge variant="secondary" className="text-[11px] italic normal-case tracking-normal">
          {field.type === "vocab" ? "Controlled Vocab" : "Open-ended"}
        </Badge>
      </div>

      {field.type === "open" ? (
        <div className="flex flex-col gap-1.25">
          <Textarea
            value={sel ? sel.value : aiSugs[0]?.value || ""}
            onChange={(e) => actions.setOpenFieldValue(fieldKey, e.target.value)}
            rows={3}
            className="min-h-15 text-sm leading-relaxed"
          />
        </div>
      ) : (
        <div onClick={(e) => e.stopPropagation()} className="flex flex-col">
          <button
            type="button"
            onClick={() => actions.onTriggerClick(fieldKey)}
            className={cn(
              "bg-input hover:border-primary/40 flex items-center gap-2 rounded-md border px-2.5 py-1.75 text-left transition-colors",
              open ? "rounded-b-none" : "",
              sel && "bg-primary/10 border-primary/30"
            )}
          >
            <span className={cn("flex-1 truncate text-sm", sel ? "text-primary" : "text-muted-foreground")}>
              {sel ? sel.value : "Select or search…"}
            </span>
            {sel && (
              <span className="bg-primary/10 text-primary ml-1 shrink-0 rounded-sm px-1.5 py-px text-[11px] whitespace-nowrap">{selBadge}</span>
            )}
            {open ? <ChevronUp className="size-3 text-primary" /> : <ChevronDown className="text-muted-foreground size-3" />}
          </button>
          {open && (
            <DropdownBody
              fieldKey={fieldKey}
              search={search}
              aiItems={aiItems}
              vocabItems={vocabItems}
              showUseTyped={showUseTyped}
              hasSelection={!!sel}
              actions={actions}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface DropdownBodyProps {
  fieldKey: string;
  search: string;
  aiItems: { value: string; pct: string; sourceName: string; selected: boolean; onPick: () => void }[];
  vocabItems: { value: string; sourceName: string; selected: boolean; onPick: () => void }[];
  showUseTyped: boolean;
  hasSelection: boolean;
  actions: AppActions;
}

function DropdownBody({ fieldKey, search, aiItems, vocabItems, showUseTyped, hasSelection, actions }: DropdownBodyProps) {
  // Controlled directly by the store-propagated `search` value: typing dispatches
  // setFieldSearch, which flows back as `search`. A controlled input keeps focus
  // across re-renders without a local-state mirror.
  return (
    <div className="bg-card rounded-b-md border border-t-0 overflow-hidden">
      <div className="border-border/60 border-b p-1.5">
        <div className="bg-input focus-within:ring-ring/20 flex items-center rounded">
          <Search className="text-muted-foreground ml-2 size-3" />
          <input
            value={search}
            onChange={(e) => actions.setFieldSearch(fieldKey, e.target.value)}
            placeholder="Search…"
            autoFocus
            className="text-foreground w-full border-0 bg-transparent px-2 py-1.25 text-sm outline-none"
          />
        </div>
      </div>
      <div className="max-h-50 overflow-y-auto">
        {aiItems.length > 0 && (
          <>
            <div className="bg-muted/30 text-muted-foreground flex items-center gap-1 px-2.5 pb-0.75 pt-1 text-[11px] uppercase tracking-[0.08em]">
              <span className="size-2.5 text-primary" />AI Suggestions
            </div>
            {aiItems.map((ai, i) => (
              <div key={i} onClick={ai.onPick} className={cn("border-border/60 flex cursor-pointer items-center gap-2 border-b px-2.5 py-1.75", ai.selected && "bg-primary/5")}>
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  {ai.selected && <Check className="text-primary size-3" />}
                </span>
                <span className="flex-1 text-sm">{ai.value}</span>
                <Badge variant="default" className="text-[10px]">AI</Badge>
                <div className="bg-border h-0.5 w-9 shrink-0 overflow-hidden rounded-full">
                  <div className="bg-primary h-full rounded-full" style={{ width: ai.pct }} />
                </div>
                <span className="text-muted-foreground w-6.5 shrink-0 text-right text-[11px]">{ai.pct}</span>
                <span className="text-muted-foreground max-w-17.5 shrink-0 truncate text-[11px]">{ai.sourceName}</span>
              </div>
            ))}
          </>
        )}
        {vocabItems.length > 0 && (
          <>
            <div className="bg-muted/30 text-muted-foreground px-2.5 pb-0.75 pt-1 text-[11px] uppercase tracking-[0.08em]">Vocabulary</div>
            {vocabItems.map((vi, i) => (
              <div key={i} onClick={vi.onPick} className={cn("border-border/60 flex cursor-pointer items-center gap-2 border-b px-2.5 py-1.75", vi.selected && "bg-primary/5")}>
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  {vi.selected && <Check className="text-primary size-3" />}
                </span>
                <span className="flex-1 text-sm">{vi.value}</span>
                <span className="text-muted-foreground max-w-32.5 shrink-0 truncate text-[11px]">{vi.sourceName}</span>
              </div>
            ))}
          </>
        )}
        {showUseTyped && (
          <div onClick={() => actions.toggleFieldValue(fieldKey, search.trim(), "manual", "", null)} className="border-border/60 text-primary flex cursor-pointer items-center gap-1.5 border-b px-2.5 py-1.75 text-sm">
            <Plus className="size-3" /><span>Use &quot;{search.trim()}&quot;</span>
          </div>
        )}
        {aiItems.length === 0 && vocabItems.length === 0 && !showUseTyped && (
          <div className="text-muted-foreground px-2.5 py-3 text-center text-sm italic">No results</div>
        )}
      </div>
      {hasSelection && (
        <div onClick={() => actions.clearField(fieldKey)} className="border-border/60 text-muted-foreground flex cursor-pointer items-center gap-1.25 border-t px-2.5 py-1.5 text-[13px]">
          <X className="size-2.5" /><span>Clear selection</span>
        </div>
      )}
    </div>
  );
}
