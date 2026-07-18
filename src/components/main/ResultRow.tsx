import { Ban, Check, ChevronDown, ChevronUp, Image as ImageIcon, Loader2, Plus, RotateCcw, Search, X, XCircle, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppActions } from "../../app/actions";
import type { AppState } from "../../app/state";
import type { ArtefactRow } from "../../app/types";
import { _ST } from "../../app/defaults";
import { vterms } from "../../app/styles";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ImageLightbox } from "@/components/common/ImageLightbox";
import { cn } from "@/lib/utils";

interface Props {
  row: ArtefactRow;
  index: number;
  state: AppState;
  actions: AppActions;
  convertFileSrc: (path: string) => string;
}

export function ResultRow({ row, index, state, actions, convertFileSrc }: Props) {
  const st = _ST[row.status || "queued"] || _ST.queued;
  const expanded = !!state.expandedRows[row.uid];

  // Track asset-protocol load failures so a blocked/missing image falls back to
  // the "no image" box instead of leaving the raw broken-image glyph on screen.
  const [imgFailed, setImgFailed] = useState(false);

  // Transient per-row lightbox open state — local, not in global AppState.
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // Source record columns: parsed rows expose every configured column via
  // `row.record` (already excluding the image column). A row with no record
  // (e.g. a queued row before parse completed) renders an empty source panel.
  const sourceFields =
    row.record && Object.keys(row.record).length
      ? Object.entries(row.record).map(([k, v]) => ({ key: k, value: String(v) }))
      : [];

  return (
    <div className="border-border/60 border-b">
      <div
        onClick={() => actions.toggleRow(row.uid)}
        className="grid min-w-0 cursor-pointer grid-cols-[80px_1fr] items-center overflow-hidden px-5 py-2.5"
      >
        <span className="text-muted-foreground truncate text-sm">{index}</span>
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
          {/* Progress / error bar — shown above the source record so the row's
              current state is visible before its contents. The `done` case has
              no bar (it renders the Catalogue Fields editor further below). */}
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
                    alt="Artefact image"
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
        </div>
      )}

      {row.imagePath && (
        <ImageLightbox
          src={convertFileSrc(row.imagePath)}
          alt="Artefact image"
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
        const aiSugs = ((state.aiResults[row.uid] || {})[f.name] || []).slice().sort((a, b) => (b.similarity ?? -1) - (a.similarity ?? -1));
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

/** Strip a trailing "(Column: value[; Column2: value2...])" hint suffix —
 *  the shape `format_candidate` (src-tauri/src/ai.rs) appends to a shortlisted
 *  vocab candidate before showing it to the model. The output contract asks
 *  the model to drop this before answering, but it doesn't always comply;
 *  matching against a stripped copy lets the vocab term (and its real label/
 *  badge) still resolve correctly instead of falling back to a raw, badge-less
 *  "AI" row. Only strips parenthetical content containing a colon — the hint
 *  format's signature — so a term that legitimately ends in plain parentheses
 *  is left untouched. */
function stripHintSuffix(value: string): string {
  return value.replace(/\s*\([^()]*:[^()]*\)\s*$/, "").trim();
}

interface FieldControlProps {
  field: import("../../app/types").CatalogueField;
  fieldKey: string;
  aiSugs: { value: string; similarity?: number }[];
  sel: import("../../app/types").FieldSelection | undefined;
  open: boolean;
  search: string;
  state: AppState;
  actions: AppActions;
}

function FieldControl({ field, fieldKey, aiSugs, sel, open, search, state, actions }: FieldControlProps) {
  const srch = search.toLowerCase();

  // Warm the term cache for this field's sources as soon as its dropdown is
  // opened — a defensive fallback for the app-load prefetch in actions.ts
  // (e.g. a source that just finished syncing on another tab). No-ops for
  // sources already cached or mid-fetch.
  useEffect(() => {
    if (!open || field.type !== "vocab") return;
    for (const sid of field.vocabSources || []) void actions.ensureVocabTermsLoaded(sid);
  }, [open, field.type, field.vocabSources, actions]);

  const vocabTerms = field.type === "vocab" ? vterms(field, state.settings.vocabSources, state.vocabTermCache) : [];
  // Keyed by the hint-stripped AI value so a suggestion the model returned
  // with its shortlist hint still intact (e.g. "Ceram (Thesaurus: Getty TGN)")
  // matches the bare vocab term ("Ceram") instead of missing it.
  const aiByLower = new Map(aiSugs.map((s) => [stripHintSuffix(s.value).toLowerCase(), s]));
  const selectedValues = new Set((sel?.values || []).map((v) => stripHintSuffix(v).toLowerCase()));

  const matchedAiLower = new Set<string>();
  const vocabItems = vocabTerms.map((vt) => {
    const lower = vt.term.toLowerCase();
    const ai = aiByLower.get(lower);
    if (ai) matchedAiLower.add(lower);
    return {
      value: vt.term,
      label: vt.label,
      badge: vt.badge,
      aiSimilarity: ai ? ai.similarity ?? null : null,
      selected: selectedValues.has(lower),
      onPick: () => (ai
        ? actions.toggleFieldValue(fieldKey, vt.term, "ai", vt.listName, ai.similarity ?? null)
        : actions.toggleFieldValue(fieldKey, vt.term, "vocab", vt.listName, null)),
    };
  });
  // AI suggestions with no matching vocab term (source not yet synced/cached,
  // or the AI answered outside the list) still get their own row. Cleaned of
  // any hint suffix too, so a stray leftover hint never shows up raw or gets
  // stored if picked.
  const aiOnlyItems = aiSugs
    .filter((s) => !matchedAiLower.has(stripHintSuffix(s.value).toLowerCase()))
    .map((s) => {
      const cleaned = stripHintSuffix(s.value);
      return {
        value: cleaned,
        label: cleaned,
        badge: null as string | null,
        aiSimilarity: s.similarity ?? null,
        selected: selectedValues.has(cleaned.toLowerCase()),
        onPick: () => actions.toggleFieldValue(fieldKey, cleaned, "ai", "AI", s.similarity ?? null),
      };
    });

  const allItems = [...vocabItems, ...aiOnlyItems];
  const items = allItems
    .filter((it) => !srch || it.value.toLowerCase().includes(srch))
    .sort((a, b) => {
      if (a.aiSimilarity != null && b.aiSimilarity != null) return b.aiSimilarity - a.aiSimilarity;
      if (a.aiSimilarity != null) return -1;
      if (b.aiSimilarity != null) return 1;
      return a.value.localeCompare(b.value);
    });

  const hasExact = items.some((i) => i.value.toLowerCase() === search.toLowerCase());
  const showUseTyped = search.trim().length > 0 && !hasExact;
  // Resolve the single selected value's label/badge (unfiltered by search) so
  // the collapsed trigger can mirror the same label+badge layout as the open
  // list, instead of the bare raw term. Multi-select shows the "N selected"
  // count badge instead — no single term's label/badge applies there.
  const selectedEntry = sel && sel.values.length === 1
    ? allItems.find((i) => i.value.toLowerCase() === stripHintSuffix(sel.value).toLowerCase())
    : undefined;
  const selBadge = sel
    ? sel.values.length > 1
      ? `${sel.values.length} selected`
      : sel.source === "ai"
        ? sel.similarity
          ? `${Math.round(sel.similarity * 100)}% match`
          : "AI"
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
            {selectedEntry ? (
              <span className="text-primary flex flex-1 min-w-0 items-center gap-1.5 text-sm">
                <span className="truncate">{selectedEntry.label}</span>
                {selectedEntry.badge && (
                  <Badge variant="secondary" className="shrink-0 text-[10px] font-normal tracking-[0.04em]">{selectedEntry.badge}</Badge>
                )}
              </span>
            ) : (
              <span className={cn("flex-1 truncate text-sm", sel ? "text-primary" : "text-muted-foreground")}>
                {sel ? sel.value : "Select or search…"}
              </span>
            )}
            {sel && (
              <span className="bg-primary/10 text-primary ml-1 shrink-0 rounded-sm px-1.5 py-px text-[11px] whitespace-nowrap">{selBadge}</span>
            )}
            {open ? <ChevronUp className="size-3 text-primary" /> : <ChevronDown className="text-muted-foreground size-3" />}
          </button>
          {open && (
            <DropdownBody
              fieldKey={fieldKey}
              search={search}
              items={items}
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

interface DropdownItem {
  value: string;
  /** Primary display text — the source's configured label column, or the
   *  bare term when unset. */
  label: string;
  /** Secondary badge chip text — the source's configured badge column, or
   *  `null` to show no badge. */
  badge: string | null;
  aiSimilarity: number | null;
  selected: boolean;
  onPick: () => void;
}

interface DropdownBodyProps {
  fieldKey: string;
  search: string;
  items: DropdownItem[];
  showUseTyped: boolean;
  hasSelection: boolean;
  actions: AppActions;
}

function DropdownBody({ fieldKey, search, items, showUseTyped, hasSelection, actions }: DropdownBodyProps) {
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
        {items.map((it, i) => (
          <div key={i} onClick={it.onPick} className={cn("border-border/60 flex cursor-pointer items-center gap-2 border-b px-2.5 py-1.75", it.selected && "bg-primary/5")}>
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              {it.selected && <Check className="text-primary size-3" />}
            </span>
            <span className="flex flex-1 min-w-0 items-center gap-1.5 text-sm">
              <span className="truncate">{it.label}</span>
              {it.badge && (
                <Badge variant="secondary" className="shrink-0 text-[10px] font-normal tracking-[0.04em]">{it.badge}</Badge>
              )}
            </span>
            {it.aiSimilarity != null && (
              <>
                <div className="bg-border h-0.5 w-9 shrink-0 overflow-hidden rounded-full">
                  <div className="bg-primary h-full rounded-full" style={{ width: Math.round(it.aiSimilarity * 100) + "%" }} />
                </div>
                <span className="text-muted-foreground w-14.5 shrink-0 text-right text-[11px]">{Math.round(it.aiSimilarity * 100)}% match</span>
              </>
            )}
          </div>
        ))}
        {showUseTyped && (
          <div onClick={() => actions.toggleFieldValue(fieldKey, search.trim(), "manual", "", null)} className="border-border/60 text-primary flex cursor-pointer items-center gap-1.5 border-b px-2.5 py-1.75 text-sm">
            <Plus className="size-3" /><span>Use &quot;{search.trim()}&quot;</span>
          </div>
        )}
        {items.length === 0 && !showUseTyped && (
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
