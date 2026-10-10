import { useCallback, useRef, useState } from "react";
import { AlertTriangle, BookOpen, CheckCircle2, Download, Loader2, Plus, Upload, X, XCircle } from "lucide-react";
import type { AppActions } from "../../app/actions";
import type { AppState } from "../../app/state";
import { displayName } from "../../app/styles";
import type { VocabEmbeddingStatus, VocabSource, VocabSourceFile } from "../../app/types";
import { embeddingModelStale } from "../../app/vocabSettings";
import { activeEmbeddingProvider } from "../../lib/ai";
import { useDropZone } from "../../hooks/useDropZone";
import { CardActions } from "./CardActions";
import { Field, FieldInput, Segmented } from "./FormControls";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SaveState } from "./SaveActions.types";
import { UnsavedBadge } from "./UnsavedBadge";
import { ExpandCollapseAll } from "@/components/common/ExpandCollapseAll";
import { SortableList } from "./SortableList";
import { SortableRow } from "./SortableRow";

interface Props {
  state: AppState;
  actions: AppActions;
}

/** Grid template shared by the header row and each source row (via SortableRow)
 *  so columns align exactly: grip / Name / Status / delete. */
const GRID = "grid-cols-[24px_1fr_170px_36px] gap-2.5 px-3.5";

export function VocabTab({ state, actions }: Props) {
  const { settings } = state;

  // Only `name` is draft-buffered per card — files/fields/embedding have real
  // Rust-side disk effects and persist straight to settings (see addFilesToSource
  // etc. in actions.ts), so once a vocabDraft exists (created by *any* vocab
  // edit, not just a rename), it must not be read wholesale: that would freeze
  // every card's files/fields/embedding at whatever they were when the draft
  // was created, hiding later Add-file(s)/sync/flush results until the draft is
  // cleared (Save/Discard or a reload). Keep the draft's ordering and pending
  // name, but source every other field from settings.
  const live = state.vocabDraft
    ? {
        vocabSources: state.vocabDraft.vocabSources.map((v) => {
          const saved = settings.vocabSources.find((s) => s.id === v.id);
          return saved ? { ...saved, name: v.name } : v;
        }),
      }
    : { vocabSources: settings.vocabSources };

  const anySyncing = Object.keys(state.vocabSyncProgress).length > 0;
  // Derived model-staleness input: a source synced with another model than the
  // active provider shows Stale (see embeddingModelStale) — never persisted.
  const activeModel = activeEmbeddingProvider(settings)?.model ?? null;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-muted-foreground text-sm px-0.5 pb-1.5 leading-relaxed">
        Manage the vocabulary sources fields can draw terms from. A source can hold multiple files; its terms are embedded
        into a local index (configure the embedding model in Settings → Model Providers) so cataloguing sends a short, relevant
        shortlist instead of the whole source. Click a row to rename, add files, or sync.
      </div>

      {/* Retrieval settings — top-level pipeline knobs (persist on change). */}
      <Card className="gap-2 py-3.5">
        <div className="px-4">
          <div className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Retrieval settings</div>
        </div>
        <div className="grid grid-cols-2 gap-2.5 px-4">
          <FieldInput
            label="Initial net count"
            value={String(settings.vocabNetCount)}
            onChange={(e) => actions.setVocabNetCount(Number(e.target.value))}
            type="number"
            desc="Candidates the embedding search returns per field (1–100)."
          />
          <FieldInput
            label="AI shortlist count"
            value={String(settings.vocabShortlistCount)}
            onChange={(e) => actions.setVocabShortlistCount(Number(e.target.value))}
            type="number"
            desc="Final picks per field after validation (≤ net count)."
          />
        </div>
        <Field
          label="Validation"
          desc="Validate the net candidates with the vision model using the image. Turn off to use cosine top-N directly (faster, less accurate)."
          className="px-4"
        >
          <Segmented
            value={settings.validationEnabled ? "on" : "off"}
            onChange={(v) => actions.setValidationEnabled(v === "on")}
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
          />
        </Field>
      </Card>

      <div className="flex items-center justify-between gap-2">
        <ExpandCollapseAll
          onExpandAll={() => actions.setAllExpanded("settingsVocabExpanded", live.vocabSources.map((v) => v.id), true)}
          onCollapseAll={() => actions.setAllExpanded("settingsVocabExpanded", live.vocabSources.map((v) => v.id), false)}
        />
        <div className="flex items-center gap-2">
          <Button
            onClick={() => void actions.syncAllVocab()}
            variant="outline"
            size="sm"
            disabled={anySyncing || !settings.activeEmbeddingProvider || !live.vocabSources.some((v) => v.files.length > 0)}
            title={!settings.activeEmbeddingProvider ? "Add and activate an embedding provider in Settings → Model Providers first" : undefined}
            className="text-muted-foreground"
          >
            Sync all
          </Button>
          <Button
            onClick={() => void actions.flushAllVocab()}
            variant="outline"
            size="sm"
            disabled={anySyncing}
            className="text-muted-foreground"
          >
            Flush all embeddings
          </Button>
        </div>
      </div>

      <Card className="gap-0 overflow-hidden p-0">
        <div className={cn("bg-muted/30 grid border-b py-1.75", GRID)}>
          <span />
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Name</span>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Status</span>
          <span />
        </div>
        <SortableList
          items={live.vocabSources.map((v) => v.id)}
          onReorder={(ids) => void actions.reorderVocab(ids)}
        >
          {live.vocabSources.map((vs) => {
            const saved = settings.vocabSources.find((s) => s.id === vs.id);
            const draftSource = state.vocabDraft?.vocabSources.find((v) => v.id === vs.id);
            const cardDirty = !!state.vocabDraft && (!saved || (draftSource?.name ?? "") !== (saved.name ?? ""));
            return (
              <SortableVocabRow
                key={vs.id}
                vs={vs}
                expanded={!!state.settingsVocabExpanded[vs.id]}
                dirty={cardDirty}
                cardStatus={state.vocabCardSaveStatus[vs.id] ?? null}
                cardError={state.vocabCardError[vs.id]}
                syncProgress={state.vocabSyncProgress[vs.id]}
                liveFields={state.fieldDraft?.fields ?? settings.fields}
                hasEmbeddingProvider={!!settings.activeEmbeddingProvider}
                activeModel={activeModel}
                actions={actions}
              />
            );
          })}
        </SortableList>
        {live.vocabSources.length === 0 && (
          <div className="text-muted-foreground p-5 text-center text-[15px]">No vocabulary sources yet</div>
        )}
      </Card>

      <Button onClick={actions.startAddVocabSource} variant="outline" className="text-muted-foreground w-full border-dashed">
        <Plus className="size-3" /><span>Add vocabulary source</span>
      </Button>
    </div>
  );
}

interface SortableVocabRowProps {
  vs: VocabSource;
  expanded: boolean;
  dirty: boolean;
  cardStatus: SaveState;
  cardError?: string;
  syncProgress?: { rowsDone: number; rowsTotal: number; fileProgress?: Record<string, { rowsDone: number; rowsTotal: number }> };
  liveFields: { id: string; name: string; vocabSources?: string[] }[];
  hasEmbeddingProvider: boolean;
  /** Model of the currently-active embedding provider — drives the derived
   *  model-staleness state (badge + summary). */
  activeModel: string | null;
  actions: AppActions;
}

function SortableVocabRow({ vs, expanded, dirty, cardStatus, cardError, syncProgress, liveFields, hasEmbeddingProvider, activeModel, actions }: SortableVocabRowProps) {
  const usedBy = liveFields.filter((f) => (f.vocabSources || []).includes(vs.id)).map((f) => f.name).join(", ") || null;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const syncing = !!syncProgress;

  const [isDropTarget, setIsDropTarget] = useState(false);
  const addFiles = useCallback((fl: FileList) => void actions.addFilesToSource(vs.id, fl), [actions, vs.id]);
  const { onDragOver, onDragLeave, onDrop } = useDropZone(setIsDropTarget, addFiles);

  return (
    <SortableRow
      id={vs.id}
      expanded={expanded}
      onToggle={() => actions.toggleVocab(vs.id)}
      grid={GRID}
      label={
        <>
          <BookOpen className="size-3.5 shrink-0" />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-medium">{displayName(vs)}</div>
            <div className="text-muted-foreground truncate text-[11px]">
              {`${vs.files.length} file${vs.files.length === 1 ? "" : "s"}`}
            </div>
          </div>
          <UnsavedBadge dirty={dirty} />
        </>
      }
      cells={
        <>
          <EmbeddingStatusBadge source={vs} progress={syncProgress} activeModel={activeModel} />
          <Button
            onClick={(e) => { e.stopPropagation(); void actions.removeVocabSource(vs.id); }}
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-destructive size-6"
            title="Delete"
          >
            <span className="text-[13px] leading-none">×</span>
          </Button>
        </>
      }
    >
      {expanded && (
        <div className="bg-muted/30 flex flex-col gap-3 border-t px-3.5 pt-2.5 pb-3.5 animate-in fade-in slide-in-from-top-1 duration-100">
          <FieldInput
            label="Display Name"
            value={vs.name ?? ""}
            onChange={(e) => actions.updateVocabName(vs.id, e.target.value)}
            placeholder="Untitled source"
            desc="Shown wherever this source appears — the sources list and field configuration."
          />

          <div className="flex flex-col gap-1.25">
            <div className="text-muted-foreground text-xs uppercase tracking-[0.08em]">Files</div>
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              className={cn(
                "cursor-pointer rounded-md border border-dashed transition-colors",
                isDropTarget ? "bg-primary/5 border-primary" : "hover:bg-muted/50"
              )}
            >
              {vs.files.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-1 py-4 text-center">
                  <Upload className="text-muted-foreground size-3.5" />
                  <div className="text-muted-foreground text-[13px]">
                    Drop files here or <span className="text-primary">browse</span>. Accepted: .xlsx, .xls, .csv
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5 p-1.5" onClick={(e) => e.stopPropagation()}>
                  {vs.files.map((f) => {
                    const fp = syncing ? syncProgress?.fileProgress?.[f.filename] : undefined;
                    return (
                      <div key={f.filename} className="bg-card flex items-center gap-2 rounded border px-2.5 py-1.5 text-[13px]">
                        <span className="min-w-0 flex-1 truncate">{f.filename}</span>
                        {fp ? (
                          <div className="flex w-[220px] shrink-0 flex-col gap-1">
                            <div className="bg-muted h-1 w-full overflow-hidden rounded-full">
                              <div
                                className="bg-primary h-full transition-all"
                                style={{ width: fp.rowsTotal ? `${Math.round((fp.rowsDone / fp.rowsTotal) * 100)}%` : "100%" }}
                              />
                            </div>
                            <div className="text-muted-foreground text-[11px]">
                              {fmtBytes(f.sizeBytes)}{fmtFileProgress(fp)}
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted-foreground shrink-0">
                            {fmtBytes(f.sizeBytes)}
                            {fmtRowCounts(f, vs.embedding.status)}
                            {" "}· added {f.addedDate}
                          </span>
                        )}
                        <Button
                          onClick={() => void actions.downloadVocabFile(vs.id, f.filename)}
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground size-6 shrink-0"
                          title="Download"
                        >
                          <Download className="size-3" />
                        </Button>
                        <Button
                          onClick={() => void actions.removeFileFromSource(vs.id, f.filename)}
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-destructive size-6 shrink-0"
                          title="Remove"
                        >
                          <X className="size-3" />
                        </Button>
                      </div>
                    );
                  })}
                  <Button onClick={() => fileInputRef.current?.click()} variant="outline" size="sm" className="text-muted-foreground w-fit border-dashed">
                    <Plus className="size-3" /><span>Add file(s) to this source</span>
                  </Button>
                </div>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) void actions.addFilesToSource(vs.id, e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          {vs.fields.length > 0 && (
            <div className="flex flex-col gap-1.25">
              <div className="text-muted-foreground text-xs uppercase tracking-[0.08em]">Fields</div>
              <div className="text-muted-foreground text-[12px] leading-relaxed">
                Each row of your files becomes one term — hover the column headers for what each control does.
              </div>
              <div className="overflow-hidden rounded border">
                <div className="bg-card grid grid-cols-[1fr_110px_170px_140px] gap-2.5 border-b px-2.5 py-1.5">
                  <span className="text-muted-foreground text-[11px] uppercase tracking-[0.08em]">Column Name</span>
                  <span
                    className="text-muted-foreground text-[11px] uppercase tracking-[0.08em]"
                    title="Which column names the term (one term per row, deduped across files). Defaults to the first column. Changing it re-embeds the source on the next sync."
                  >
                    Ingestion
                  </span>
                  <span
                    className="text-muted-foreground text-[11px] uppercase tracking-[0.08em]"
                    title="How each term reads in the picker on the main screen — label is the main text, badge the secondary chip. Display-only; applies immediately, no re-sync."
                  >
                    Label/Badge
                  </span>
                  <span
                    className="text-muted-foreground text-[11px] uppercase tracking-[0.08em]"
                    title="Fold this column's text into the term's embedding so cataloguing can match on it (e.g. synonyms, scope notes). The AI itself only ever sees the term. Changing it re-embeds the source on the next sync."
                  >
                    Include for AI
                  </span>
                </div>
                {vs.fields.map((f) => {
                  const effectiveIngestion = vs.ingestionField ?? vs.fields[0]?.name ?? null;
                  const isIngestion = effectiveIngestion === f.name;
                  const role = vs.labelField === f.name ? "label" : vs.badgeField === f.name ? "badge" : "none";
                  return (
                    <div key={f.name} className="bg-card grid grid-cols-[1fr_110px_170px_140px] items-center gap-2.5 border-b px-2.5 py-1.5 last:border-b-0">
                      <span className="truncate text-[13px]">{f.name}</span>
                      <Segmented
                        value={isIngestion ? "yes" : "no"}
                        onChange={(v) => {
                          if (v === "yes" && !isIngestion) actions.setVocabIngestionField(vs.id, f.name);
                          if (v === "no" && isIngestion) actions.setVocabIngestionField(vs.id, null);
                        }}
                        options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]}
                      />
                      <Segmented
                        value={role}
                        onChange={(v) => {
                          if (v === "label") actions.setVocabLabelField(vs.id, f.name);
                          else if (v === "badge") actions.setVocabBadgeField(vs.id, f.name);
                          else {
                            if (vs.labelField === f.name) actions.setVocabLabelField(vs.id, null);
                            if (vs.badgeField === f.name) actions.setVocabBadgeField(vs.id, null);
                          }
                        }}
                        options={[{ value: "none", label: "–" }, { value: "label", label: "Label" }, { value: "badge", label: "Badge" }]}
                      />
                      <Segmented
                        value={f.includeForAI ? "yes" : "no"}
                        onChange={(v) => { if ((v === "yes") !== f.includeForAI) actions.toggleSourceFieldAI(vs.id, f.name); }}
                        options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="text-muted-foreground text-[12px] leading-relaxed">
            {embeddingSummary(vs, activeModel)}
            {usedBy && <> · Used by: {usedBy}</>}
          </div>

          {syncing && (
            <div className="flex flex-col gap-1">
              <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
                <div
                  className="bg-primary h-full transition-all"
                  style={{ width: syncProgress.rowsTotal ? `${Math.round((syncProgress.rowsDone / syncProgress.rowsTotal) * 100)}%` : "100%" }}
                />
              </div>
              <div className="text-muted-foreground text-[11px]">
                {syncProgress.rowsTotal ? `Embedding ${syncProgress.rowsDone}/${syncProgress.rowsTotal}…` : "Diffing files…"}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            {syncing ? (
              <Button onClick={() => void actions.cancelVocabSync(vs.id)} variant="outline" size="sm">Cancel Sync</Button>
            ) : (
              <Button
                onClick={() => void actions.syncVocabSource(vs.id)}
                variant="secondary"
                size="sm"
                disabled={!vs.files.length || !hasEmbeddingProvider}
                title={!hasEmbeddingProvider ? "Add and activate an embedding provider in Settings → Model Providers first" : !vs.files.length ? "Add at least one file first" : undefined}
              >
                Sync now
              </Button>
            )}
            <Button
              onClick={() => void actions.flushVocabSource(vs.id)}
              variant="outline"
              size="sm"
              disabled={syncing || vs.embedding.status === "never"}
            >
              Flush embeddings
            </Button>
          </div>

          <CardActions
            dirty={dirty}
            status={cardStatus}
            errorMessage={cardError}
            onSave={() => void actions.saveVocabCard(vs.id)}
            onDiscard={() => actions.discardVocabCard(vs.id)}
            onDelete={() => void actions.removeVocabSource(vs.id)}
            deleteLabel="Delete Source"
          />
        </div>
      )}
    </SortableRow>
  );
}

function embeddingSummary(vs: VocabSource, activeModel: string | null): string {
  const e = vs.embedding;
  switch (e.status) {
    case "never": return "Never embedded — add files and Sync to enable shortlisted retrieval.";
    case "stale": return `Stale — ${e.model ? `last embedded with ${e.model}, ` : ""}files or fields changed since. Sync to update.`;
    case "syncing": return "Syncing…";
    case "error": return `Sync failed${e.lastError ? `: ${e.lastError}` : ""}.`;
    case "synced":
      // Derived staleness: synced, but with a different model than the active
      // provider — its vectors live in the old model's space. Distinct copy
      // from content-stale so the user knows why.
      if (embeddingModelStale(e, activeModel)) {
        return `Stale — last embedded with ${e.model}, but the active embedding model is ${activeModel}. Re-sync to re-embed.`;
      }
      return `Embedded with ${e.model} · ${e.rowsEmbedded ?? 0} terms · synced ${e.lastSyncedAt?.slice(0, 10) ?? ""}`;
  }
}

function EmbeddingStatusBadge({ source, progress, activeModel }: { source: VocabSource; progress?: { rowsDone: number; rowsTotal: number }; activeModel: string | null }) {
  if (progress) {
    const pct = progress.rowsTotal ? Math.round((progress.rowsDone / progress.rowsTotal) * 100) : null;
    return <Badge variant="secondary" className="w-fit gap-1 tracking-[0.04em]"><Loader2 className="size-2.5 animate-spin" />Syncing{pct !== null ? ` ${pct}%` : "…"}</Badge>;
  }
  if (source.embedding.status === "synced") {
    if (embeddingModelStale(source.embedding, activeModel)) {
      return <Badge variant="secondary" className="w-fit gap-1 text-amber-600 tracking-[0.04em] dark:text-amber-400"><AlertTriangle className="size-2.5" />Stale</Badge>;
    }
    return <Badge variant="default" className="w-fit gap-1 tracking-[0.04em]"><CheckCircle2 className="size-2.5" />Up to date</Badge>;
  }
  switch (source.embedding.status) {
    case "stale": return <Badge variant="secondary" className="w-fit gap-1 text-amber-600 tracking-[0.04em] dark:text-amber-400"><AlertTriangle className="size-2.5" />Stale</Badge>;
    case "error": return <Badge variant="destructive" className="w-fit gap-1 tracking-[0.04em]"><XCircle className="size-2.5" />Error</Badge>;
    default: return <Badge variant="secondary" className="w-fit tracking-[0.04em]">Never embedded</Badge>;
  }
}

function fmtBytes(b: number): string {
  return b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`;
}

/** " · N found" before a first sync (only the raw parse count is known yet),
 *  or " · N found / M synced" once the source has an actually-embedded index —
 *  `synced` can be lower than `found` (empty terms, or a term_key collapsed
 *  into another file by cross-file dedup), so both are worth showing once we
 *  know both. Gated on the source's live `embedding.status` rather than just
 *  the presence of `rowCountSyncedLast`: that per-file count is a cache that
 *  reflects whatever the last completed sync wrote, and a status of "never"
 *  (e.g. right after Flush embeddings) means it no longer describes reality
 *  even though the stale number is still sitting on the file record. */
function fmtRowCounts(f: VocabSourceFile, embeddingStatus: VocabEmbeddingStatus["status"]): string {
  if (f.rowCountLast === undefined) return "";
  if (embeddingStatus === "never" || f.rowCountSyncedLast === undefined) return ` · ${f.rowCountLast} found`;
  return ` · ${f.rowCountLast} found / ${f.rowCountSyncedLast} synced`;
}

/** Live per-file sync text shown in place of `fmtRowCounts` while a sync is in
 *  flight. `rowsTotal` is how many of the file's rows need a fresh embed this
 *  pass (post-reuse-diff), so 0 means the file was fully reused and needs no
 *  new embeddings. */
function fmtFileProgress(p: { rowsDone: number; rowsTotal: number }): string {
  if (p.rowsTotal === 0) return " · no new rows";
  const pct = Math.round((p.rowsDone / p.rowsTotal) * 100);
  return ` · Embedding ${p.rowsDone}/${p.rowsTotal} · ${pct}%`;
}
