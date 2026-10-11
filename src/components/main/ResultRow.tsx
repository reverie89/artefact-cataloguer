import { Ban, Check, ChevronDown, ChevronUp, Image as ImageIcon, Play, Plus, RotateCcw, Search, Trash2, X, XCircle, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppActions } from "../../app/actions";
import type { AppState } from "../../app/state";
import type { ArtefactRow } from "../../app/types";
import { _ST } from "../../app/defaults";
import { vterms } from "../../app/styles";
import { isImageRoleName, recordValueFor } from "../../lib/spreadsheet";
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
  // Pipeline position for an in-flight run (absent until Rust's first stage
  // event lands); rendered beside the processing label on the strip below.
  const progress = state.catalogueProgress[row.uid];
  const expanded = !!state.expandedRows[row.uid];

  // Track asset-protocol load failures so a blocked/missing image falls back to
  // the "no image" box instead of leaving the raw broken-image glyph on screen.
  const [imgFailed, setImgFailed] = useState(false);

  // Transient per-row lightbox open state — local, not in global AppState.
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // True while this row's delete confirmation is open: the row tints so the
  // user can still tell which record they're deciding about behind the dialog.
  // deleteRow resolves exactly when the dialog closes (either answer).
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const handleDelete = async () => {
    setConfirmingDelete(true);
    try {
      await actions.deleteRow(row.uid);
    } finally {
      setConfirmingDelete(false);
    }
  };

  // Source Record shows every configured column, in configured order — an
  // em-dash marks a cell that is empty in this row's sheet (records are
  // sparse: the parser omits empty cells). The image-role column is excluded
  // (its text never enters the record; the extracted drawing renders in the
  // Image pane), and unconfigured sheet columns don't render at all.
  // Matching mirrors the parser: record keys are the sheet's own header text,
  // compared case-insensitively with whitespace runs collapsed
  // (recordValueFor).
  const record = row.record ?? {};
  const afs = state.settings.artefactFields || [];
  const imageIdx = afs.findIndex((f) => isImageRoleName(f.name));
  const sourceFields = afs
    .filter((_, i) => i !== imageIdx)
    .map((f) => ({ key: f.name || "Untitled column", value: recordValueFor(record, f.name), forAI: f.includeForAI }));

  // The strip's single status-driven action — the record's entire control
  // surface lives on the collapsed row so no expansion is needed to act on it
  // (the expanded body is informational only). Start/Retry queue the row and
  // the drainer runs it automatically (FIFO); Stop cancels the in-flight call
  // or un-queues the row back to `ready`, per its status.
  const rowAction: { icon: React.ReactNode; text: string; label: string; run: () => void } | null =
    row.status === "processing"
      ? { icon: <Ban className="size-3" />, text: "Stop", label: "Stop this record", run: () => void actions.stopRow(row.uid) }
      : row.status === "ready"
        ? { icon: <Play className="size-3" />, text: "Start", label: "Start this record", run: () => actions.queueRow(row.uid) }
        : row.status === "queued"
          ? { icon: <Ban className="size-3" />, text: "Stop", label: "Stop queueing this record", run: () => actions.dequeueRow(row.uid) }
          : row.status === "error" || row.status === "cancelled" || row.status === "done"
            ? { icon: <RotateCcw className="size-3" />, text: "Retry", label: "Retry this record", run: () => actions.queueRow(row.uid) }
            : null;

  return (
    <div className={cn("border-border/60 border-b", confirmingDelete && "bg-destructive/10")}>
      <div
        onClick={() => actions.toggleRow(row.uid)}
        className={cn(
          "grid min-w-0 cursor-pointer grid-cols-[80px_1fr] items-center overflow-hidden px-5 py-2.5",
          // Zebra: tint every 2nd visible row (per group, aligned with S/N) so
          // the eye can track across the wide row. The delete-confirmation
          // tint paints the whole row beneath, so the stripe yields to it.
          !confirmingDelete && index % 2 === 0 && "bg-muted/50"
        )}
      >
        <span className="text-muted-foreground truncate text-sm">{index}</span>
        <div className="flex items-center gap-1.25">
          <span
            className={cn("size-1.5 rounded-full", row.status === "processing" && "animate-pulse")}
            style={{ background: st.clr }}
          />
          <span className="text-muted-foreground text-[13px]">{st.label}</span>
          {row.status === "processing" && progress && (
            <span className="text-muted-foreground text-[11px] tabular-nums">
              · {progress.step}/{progress.total}
            </span>
          )}
          <span className="ml-auto flex items-center">
            {rowAction && (
              <Button
                onClick={(e) => { e.stopPropagation(); rowAction.run(); }}
                variant="outline"
                size="xs"
                aria-label={rowAction.label}
                className="mr-1.5"
              >
                {rowAction.icon}
                <span>{rowAction.text}</span>
              </Button>
            )}
            <Button
              onClick={(e) => { e.stopPropagation(); void handleDelete(); }}
              variant="ghost"
              size="icon-xs"
              aria-label="Delete record"
              className={cn("text-muted-foreground hover:text-destructive mr-0.5", confirmingDelete && "text-destructive")}
            >
              <Trash2 className="size-3" />
            </Button>
            {expanded ? <ChevronUp className="size-3 text-primary" /> : <ChevronDown className="text-muted-foreground size-3" />}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="bg-muted/30 border-l-primary/30 border-border/60 animate-in fade-in border-t border-l-[3px] duration-150">
          {/* Status bars — informational only; the collapsed strip above owns
              the in-flight signal (dot + label + stage counter), so there is
              deliberately no processing bar here. The `done` case has no bar
              either (it renders the Catalogue Fields editor further below). */}
          {row.status === "queued" && (
            <div className="text-muted-foreground px-4.5 py-3.5 text-sm">Queued</div>
          )}
          {row.status === "cancelled" && (
            <div className="text-muted-foreground px-4.5 py-3.5 text-sm">Cancelled</div>
          )}
          {row.status === "error" && (
            <div className="text-destructive flex items-center gap-2 px-4.5 py-3.5 text-sm">
              <XCircle className="size-3.5" />
              <span>Processing failed — check Logs Viewer</span>
            </div>
          )}

          {/* Source record + image. Column widths come from the shared
              --src-label-w / --img-pane-w vars (persisted; see defaults.ts). */}
          <div className="border-border/60 relative grid grid-cols-[1fr_var(--img-pane-w)] border-b">
            <div className="border-border/60 p-3 pr-4.5 border-r">
              <div className="text-muted-foreground mb-2 text-[11px] font-semibold uppercase tracking-[0.12em]">Source Record</div>
              {sourceFields.map((sf) => (
                <div key={sf.key} className="border-border/60 grid grid-cols-[var(--src-label-w)_1fr] gap-1.5 border-b py-1">
                  <span className="text-muted-foreground flex min-w-0 items-center gap-1.25 pt-0.25 text-[11px] uppercase tracking-[0.05em]">
                    <span className="truncate" title={sf.key}>{sf.key}</span>
                    {!sf.forAI && (
                      <Badge variant="secondary" title="Not sent to AI" className="flex shrink-0 select-none items-center gap-1 px-1.5 text-[10px] font-normal normal-case tracking-[0.04em]">
                        <X className="size-2.5" />
                        <span>AI</span>
                      </Badge>
                    )}
                  </span>
                  <span className={cn("text-sm [overflow-wrap:anywhere] [word-break:break-word]", sf.value ? "text-foreground" : "text-muted-foreground")}>{sf.value || "—"}</span>
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
                    className="w-full object-contain max-h-[var(--img-pane-w)]"
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
            {/* Column drag handles: absolute strips centered on each boundary
                (they don't participate in the grid), driving the shared
                --src-label-w / --img-pane-w vars so every expanded row resizes
                together; nothing dispatches until release. */}
            <div
              onMouseDown={actions.onSourceLabelResizeStart}
              title="Drag to resize the column names"
              className="absolute inset-y-0 z-10 flex w-2 -translate-x-1/2 cursor-col-resize items-start justify-center hover:bg-primary/10"
              style={{ left: "calc(0.75rem + var(--src-label-w) + 3px)" }}
            >
              <div className="bg-border mt-2.5 h-6 w-0.5 rounded-full" />
            </div>
            <div
              onMouseDown={actions.onImagePaneResizeStart}
              title="Drag to resize the image pane"
              className="absolute inset-y-0 z-10 flex w-2 -translate-x-1/2 cursor-col-resize items-start justify-center hover:bg-primary/10"
              style={{ left: "calc(100% - var(--img-pane-w))" }}
            >
              <div className="bg-border mt-2.5 h-6 w-0.5 rounded-full" />
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
        <div className="flex items-center gap-1 normal-case tracking-normal">
          <Zap className="size-3 text-primary" />
          <span className="text-muted-foreground text-[11px] font-normal">{activeProvName}</span>
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
  aiSugs: import("../../app/types").AiSuggestion[];
  sel: import("../../app/types").FieldSelection | undefined;
  open: boolean;
  search: string;
  state: AppState;
  actions: AppActions;
}

function FieldControl({ field, fieldKey, aiSugs, sel, open, search, state, actions }: FieldControlProps) {
  const srch = search.toLowerCase();
  // Multi-component fields (maxComponents ≠ 1) accumulate picks; single-pick
  // fields replace the selection and close the dropdown on pick.
  const multi = field.maxComponents !== 1;

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

  // First-appearance order of each kind across the field's suggestions —
  // stable regardless of dropdown search/sort, so a kind's shade never shifts.
  const kindShades = new Map<string, number>();
  for (const s of aiSugs) {
    if (s.kind && !kindShades.has(s.kind)) kindShades.set(s.kind, kindShades.size);
  }

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
      kind: ai ? ai.kind ?? null : null,
      selected: selectedValues.has(lower),
      onPick: () => (ai
        ? actions.toggleFieldValue(fieldKey, vt.term, "ai", vt.listName, ai.similarity ?? null, multi)
        : actions.toggleFieldValue(fieldKey, vt.term, "vocab", vt.listName, null, multi)),
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
        kind: s.kind ?? null,
        selected: selectedValues.has(cleaned.toLowerCase()),
        onPick: () => actions.toggleFieldValue(fieldKey, cleaned, "ai", "AI", s.similarity ?? null, multi),
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
          {field.type === "vocab" ? (multi ? "Controlled Vocab · Multi" : "Controlled Vocab") : "Open-ended"}
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
              kindShades={kindShades}
              showUseTyped={showUseTyped}
              hasSelection={!!sel}
              multi={multi}
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
  /** The component group's phrase this suggestion came from, or `null` for
   *  rows without an AI suggestion — drives the per-kind row shading. */
  kind: string | null;
  selected: boolean;
  onPick: () => void;
}

interface DropdownBodyProps {
  fieldKey: string;
  search: string;
  items: DropdownItem[];
  /** Kind phrase → shade index (first-appearance order across the field's
   *  full suggestion list, built by FieldControl). */
  kindShades: Map<string, number>;
  showUseTyped: boolean;
  hasSelection: boolean;
  /** False for single-pick fields: a typed value replaces the selection. */
  multi: boolean;
  actions: AppActions;
}

/** Hue step between consecutive kinds: the golden angle maximizes hue
 *  separation, so shades never repeat for any practical component count. */
const KIND_HUE_STEP = 137.5;

function kindShade(shadeIndex: number): string {
  return `hsla(${(shadeIndex * KIND_HUE_STEP) % 360}, 65%, 55%, 0.16)`;
}

function DropdownBody({ fieldKey, search, items, kindShades, showUseTyped, hasSelection, multi, actions }: DropdownBodyProps) {
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
        {items.map((it, i) => {
          // Kind tint (data-driven colour — the sanctioned inline-style case):
          // a kind's pick and alternates share one shade; unshaded rows keep
          // the selected background. The tooltip names the group.
          const shadeIndex = it.kind != null ? kindShades.get(it.kind) : undefined;
          const shade = shadeIndex != null ? kindShade(shadeIndex) : undefined;
          return (
            <div
              key={i}
              onClick={it.onPick}
              title={it.kind ?? undefined}
              style={shade != null ? { backgroundColor: shade } : undefined}
              className={cn("border-border/60 flex cursor-pointer items-center gap-2 border-b px-2.5 py-1.75", shade == null && it.selected && "bg-primary/5")}
            >
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
          );
        })}
        {showUseTyped && (
          <div onClick={() => actions.toggleFieldValue(fieldKey, search.trim(), "manual", "", null, multi)} className="border-border/60 text-primary flex cursor-pointer items-center gap-1.5 border-b px-2.5 py-1.75 text-sm">
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
