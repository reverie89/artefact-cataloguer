// All user actions as a single hook, mirroring the reference DCLogic methods.
// Heavy async work (parsing, image extraction, AI) lives here; pure settings
// mutations dispatch PATCH_SETTINGS and the debounced saver persists them.

import { useCallback, useEffect, useRef } from "react";
import ExcelJS from "exceljs";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile, writeFile, readFile } from "@tauri-apps/plugin-fs";

import { useDropZone } from "../hooks/useDropZone";
import type { Action, AppState, ArtefactDraft, EditableArtefactFieldKey, EditableCatalogueFieldKey, EmbeddingProviderDraft, FieldDraft, ProviderDraft, ProviderDraftEntry, VocabDraft } from "./state";
import { artefactDraftFromSettings, embeddingProviderDraftFromSettings, providerDraftFromSettings, vocabDraftFromSettings } from "./state";
import { _DEF_AF, _DEF_ARTEFACT_ANALYSIS_SYSTEM_PROMPT_INSTRUCTION, fmt, gid } from "./defaults";
import type { ApiFormat, AiResults, ArtefactField, ArtefactRow, CatalogueField, EmbeddingApiFormat, EmbeddingProvider, FieldSelection, Provider, Settings, SettingsTab, ThinkingEffort, VocabEmbeddingStatus } from "./types";
import { isTabDirty } from "./drafts";
import { isImageRoleName, parseArtefactFile, recordValueFor } from "../lib/spreadsheet";
import { extractImagesFromXlsx } from "../lib/images";
import { columnWidthChars, fitWithin, imageDimensions, rowHeightPoints } from "../lib/imageMeta";
import { catalogueArtefact, cancelCatalogue, CANCEL_ERROR, testConnection, testEmbeddingConnection, activeProvider, activeEmbeddingProvider, findUnsyncedVocabField, findVocabFieldWithoutEmbedding } from "../lib/ai";
import * as vocabLib from "../lib/vocab";
import type { StagedVocabFile } from "../lib/vocab";
import { pushLog } from "../lib/logs";
import { withDefaultSettings, migrateLegacyVocabularyLists, migrateLegacyVisionPromptKey, stripBuiltinLegacyVocabFields, type DebouncedSaver } from "../lib/store";
import { PersistedSettingsSchema } from "./schema";
import type { ConfirmDeleteOptions } from "../components/common/ConfirmDialog";
import { emptyEmbedding, markStaleIfSynced, newVocabSource, sourceWithAddedFiles, sourceWithRemovedFile, syncInputsChanged, updateVocabSource, withoutVocabSource, withReorderedVocabSources } from "./vocabSettings";

/** Extract a display string from a rejected promise. Tauri commands returning
 *  `Result<T, String>` reject with the bare string; JS failures reject with
 *  Error objects. */
function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export interface AppActions {
  // theme/nav/zoom
  toggleDark(): void;
  /** Leaves Settings for the main screen. If the current settings tab has
   *  unsaved changes, prompts to discard first (returns true on proceed). */
  goMain(): Promise<void>;
  goSettings(tab?: SettingsTab): void;
  /** Switches settings tab. If the current tab has unsaved changes, prompts to
   *  discard first. */
  setTab(t: SettingsTab): Promise<void>;
  zoomIn(): void;
  zoomOut(): void;
  toggleLogs(): void;
  setLogsOpen(open: boolean): void;

  // files
  onUploadClick(): void;
  onDragOver(e: React.DragEvent): void;
  onDragLeave(): void;
  onDrop(e: React.DragEvent): void;
  /** Dismiss a rejected file's error card from the upload panel. */
  removeFile(id: string): void;
  dismissParseError(): void;
  /** Run the catalogue queue: drain every `queued` row in the results panel,
   *  one AI call in flight. Fail-soft — a failing row marks only itself
   *  `error` and the queue continues. Rows imported or requeued mid-run merge
   *  in naturally (the drainer re-reads live state each iteration). */
  startQueue(): Promise<void>;
  /** Stop the queue: cancel every in-flight AI call at the transport level
   *  and exit the drainer. Queued rows stay queued so Start can resume. */
  stopQueue(): Promise<void>;
  /** Requeue every errored/cancelled row at once. Never runs anything — the
    * queue is started separately, so a failing row can't loop. */
  retryFailed(): void;
  /** Put a single row back into the queue (even a `done` one — a manual
   *  re-run). Picked up by the next Start. */
  requeueRow(uid: string): void;
  /** Stop an in-flight `processing` row by cancelling its AI call at the
   *  transport level (the Rust side drops the reqwest future, closing the
   *  socket). The row's awaiting runRow catch turns the cancel sentinel into
   *  a `cancelled` status; the rest of the queue continues. No-op for a row
   *  that isn't processing. */
  stopRow(uid: string): Promise<void>;
  /** Delete one record from the results panel: confirms first, cancels the
   *  row's in-flight AI call if any, then removes the row and all of its
   *  per-row state (selections, AI results, expansion). */
  deleteRow(uid: string): Promise<void>;
  /** Delete every record imported from one artefact file (the results group).
   *  Confirms first, cancels in-flight rows, then removes them all. */
  deleteFileRows(fileId: string): Promise<void>;
  onResizeStart(e: React.MouseEvent): void;

  // results
  toggleRow(uid: string): void;
  setFilter(e: React.ChangeEvent<HTMLSelectElement>): void;
  setSearch(e: React.ChangeEvent<HTMLInputElement>): void;
  /** Toggle an artefact-file column in/out of the results search scope. The
   *  scope may be emptied — searching an empty scope yields no matches. */
  toggleSearchColAf(id: string): void;
  /** Toggle a catalogue-field column in/out of the results search scope. */
  toggleSearchColCat(id: string): void;
  /** Replace the whole AF search-column set (Clear/All in the picker). */
  setSearchColsAf(ids: string[]): void;
  /** Replace the whole catalogue-field search-column set. */
  setSearchColsCat(ids: string[]): void;
  /** Dismiss the transient export warning banner. */
  dismissExportWarning(): void;
  exportResults(): Promise<void>;
  onTriggerClick(key: string): void;
  setFieldSearch(key: string, val: string): void;
  /** Pick a vocab term for a field's selection: single-pick fields replace
   *  the selection (and close the dropdown), multi-component fields toggle
   *  the term in/out. */
  toggleFieldValue(key: string, value: string, source: "ai" | "vocab" | "manual", listName: string, similarity: number | null, multi: boolean): void;
  clearField(key: string): void;
  setOpenFieldValue(key: string, val: string): void;

  // settings: shared across the Fields/Vocab/Artefact File card-list tabs
  /** Bulk-set every given id's expanded state within one of the three
   *  per-tab expanded maps. Backs the shared Expand all/Collapse all controls. */
  setAllExpanded(scope: "settingsFieldExpanded" | "settingsVocabExpanded" | "artefactFieldExpanded", ids: string[], expanded: boolean): void;

  // settings: fields
  toggleSF(id: string): void;
  /** Reorder catalogue fields to the given id sequence (result of a drag). Persists immediately. */
  reorderFields(ids: string[]): Promise<void>;
  toggleProv(id: string): void;
  removeField(id: string): Promise<void>;
  updateField(id: string, key: EditableCatalogueFieldKey, value: string | number | boolean): void;
  addVocabSrc(fId: string, vId: string): void;
  removeVocabSrc(fId: string, sId: string): void;
  /** Persist only this catalogue-field row's content edits to disk. */
  saveFieldCard(id: string): Promise<void>;
  /** Revert only this catalogue-field row's content edits. */
  discardFieldCard(id: string): void;
  /** Append an empty catalogue-field row to the draft (expanded), mirroring the
   *  ProvidersTab add flow. Persisted on the tab-level Save / per-card Save. */
  startAddField(): void;

  // settings: vocab — a source's files/fields/sync state have real Rust-side
  // disk effects and persist immediately (mirrors removeVocabList/reorderVocab
  // below); only the Display Name is draft-buffered per card.
  /** Append an empty vocabulary source (no files yet), expanded, mirroring
   *  startAddField/startAddProv. */
  startAddVocabSource(): void;
  /** Stage one or more files into a source: persists their bytes via Rust,
   *  detects header columns, and merges them into the source's file/field
   *  lists. Marks the source stale if it was previously synced. */
  addFilesToSource(sourceId: string, files: FileList | File[]): Promise<void>;
  /** Remove one staged file from a source. */
  removeFileFromSource(sourceId: string, filename: string): Promise<void>;
  /** Read a staged file's bytes back and save them via a Tauri save dialog. */
  downloadVocabFile(sourceId: string, filename: string): Promise<void>;
  /** Toggle whether a detected column feeds the embedding text / AI-facing
   *  shortlist hint. Marks the source stale if previously synced. */
  toggleSourceFieldAI(sourceId: string, fieldName: string): void;
  /** Set (or clear, with `null`) which detected column supplies the term /
   *  dedup key on next sync. Marks the source stale if previously synced —
   *  changing this changes what every row's identity is. */
  setVocabIngestionField(sourceId: string, fieldName: string | null): void;
  /** Set (or clear, with `null`) which detected column is shown as the
   *  primary label in the main screen's cataloguing dropdown. Purely
   *  cosmetic — never marks the source stale. */
  setVocabLabelField(sourceId: string, fieldName: string | null): void;
  /** Set (or clear, with `null`) which detected column is shown as a badge
   *  chip beside the label in the cataloguing dropdown. Purely cosmetic —
   *  never marks the source stale. */
  setVocabBadgeField(sourceId: string, fieldName: string | null): void;
  /** Run (or resume) an incremental sync for this source against the active
   *  embedding provider. No-op if there's no active embedding provider or no
   *  files. */
  syncVocabSource(sourceId: string): Promise<void>;
  /** Sync every source that has files, sequentially. No-op if there's no
   *  active embedding provider. */
  syncAllVocab(): Promise<void>;
  /** Cancel an in-flight sync for this source. */
  cancelVocabSync(sourceId: string): Promise<void>;
  /** Drop just this source's embedded index (keeps its files). */
  flushVocabSource(sourceId: string): Promise<void>;
  /** Drop every source's embedded index. */
  flushAllVocab(): Promise<void>;
  /** Delete a vocabulary source entirely: its files, embedded index, and
   *  dangling vocabSource references on catalogue fields. */
  removeVocabSource(id: string): Promise<void>;
  /** Fetch and cache a source's full term list (for the manual vocab-picker
   *  dropdown) if not already cached or in flight. No-op otherwise. */
  ensureVocabTermsLoaded(sourceId: string): Promise<void>;
  toggleVocab(id: string): void;
  /** Update a vocab source's display name directly in the draft (like updateField). */
  updateVocabName(id: string, name: string): void;
  /** Reorder vocab sources to the given id sequence (result of a drag). Persists immediately. */
  reorderVocab(ids: string[]): Promise<void>;
  /** Persist only this vocab source's rename to disk. */
  saveVocabCard(id: string): Promise<void>;
  /** Revert only this vocab source's rename. */
  discardVocabCard(id: string): void;

  // settings: vocab retrieval — top-level (not draft-buffered). Persist on change.
  /** Candidates the embedding search returns per vocab field before validation (1–100). */
  setVocabNetCount(n: number): void;
  /** Final picks per vocab field after validation (≤ net count). */
  setVocabShortlistCount(n: number): void;
  /** Whether validation runs. */
  setValidationEnabled(on: boolean): void;

  // settings: providers — content edits accumulate per card and persist on the
  // card's own Save; structural changes (delete, set-active, reorder) persist
  // immediately. Test Connection runs immediately as transient verification.
  startAddProv(): void;
  setProvF(id: string, k: keyof Provider, e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>): void;
  setProvModel(id: string, model: string): void;
  setProvApiFormat(id: string, format: ApiFormat): void;
  /** Set this provider's reasoning effort (`null` = off); persists on its card Save. */
  setProvThinking(id: string, effort: ThinkingEffort | null): void;
  toggleProvKey(): void;
  testConn(id: string): Promise<void>;
  deleteProv(id: string): Promise<void>;
  setActiveProv(id: string): Promise<void>;
  /** Reorder providers to the given id sequence (result of a drag). Persists immediately. */
  reorderProv(ids: string[]): Promise<void>;
  /** Persist only this provider card's content edits to disk. */
  saveProvCard(id: string): Promise<void>;
  /** Revert only this provider card's content edits back to its persisted value. */
  discardProvCard(id: string): void;

  // settings: embedding providers — same per-card draft/save/discard shape as
  // the chat providers above, kept as a separate list/section within the same
  // "modelProviders" tab (see EmbeddingProvidersSection.tsx).
  toggleEmbProv(id: string): void;
  startAddEmbProv(): void;
  setEmbProvF(id: string, k: keyof EmbeddingProvider, e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>): void;
  setEmbProvModel(id: string, model: string): void;
  setEmbProvApiFormat(id: string, format: EmbeddingApiFormat): void;
  toggleEmbProvKey(): void;
  testEmbConn(id: string): Promise<void>;
  deleteEmbProv(id: string): Promise<void>;
  setActiveEmbProv(id: string): Promise<void>;
  /** Reorder embedding providers to the given id sequence (result of a drag). Persists immediately. */
  reorderEmbProv(ids: string[]): Promise<void>;
  saveEmbProvCard(id: string): Promise<void>;
  discardEmbProvCard(id: string): void;

  // settings: artefact fields — content edits accumulate per-card; reorders and
  // deletes persist immediately. Rows expand on click via toggleAF.
  toggleAF(id: string): void;
  /** Reorder artefact columns to the given id sequence (result of a drag). Persists immediately. */
  reorderAF(ids: string[]): Promise<void>;
  updateAF(id: string, key: EditableArtefactFieldKey, value: string): void;
  removeAF(id: string): Promise<void>;
  /** Append an empty artefact-column row to the draft (expanded). Persisted on per-card Save. */
  startAddAF(): void;
  /** Persist only this artefact-column row's content edits to disk. */
  saveArtefactCard(id: string): Promise<void>;
  /** Revert only this artefact-column row's content edits. */
  discardArtefactCard(id: string): void;
  /** Update the unified system prompt (artefact-analysis persona +
   *  output-format preamble) in the draft. */
  updateArtefactAnalysisSystemPromptInstruction(value: string): void;
  /** Persist the unified system prompt to disk. */
  saveArtefactAnalysisSystemPromptInstruction(): Promise<void>;
  /** Revert the unified system prompt to its persisted value. */
  discardArtefactAnalysisSystemPromptInstruction(): void;
  /** Toggle whether the unified system prompt textarea is editable. Backed by a
   *  warning-confirmed Override (it tells the model how to format responses). */
  setPromptEditing(editing: boolean): void;
  /** Gate unlocking the unified system prompt behind a warning confirmation. On
   *  confirm, seeds the draft with the default so editing starts from known-good
   *  text, then unlocks. */
  overridePrompt(): Promise<void>;

  // settings: import/export
  exportSettings(): Promise<void>;
  importSettings(e: React.ChangeEvent<HTMLInputElement>): Promise<void>;
}

type Dispatch = (action: Action) => void;
/** Debounced schedule for routine edits; flush() awaits the disk write —
 *  structural vocab ops use it so per-card save status reflects reality. */
type Persist = DebouncedSaver;
type ConfirmDelete = (opts: ConfirmDeleteOptions) => Promise<boolean>;
type AppWindow = Window & { __acFi?: HTMLInputElement };

/**
 * Neutralize CSV formula injection (OWASP guidance). Spreadsheet apps treat a
 * cell whose value begins with `= + - @` (or a TAB/CR) as a formula; a
 * malicious source cell, or an LLM open-field answer, could emit e.g.
 * `=HYPERLINK(...)` and have it execute when the exported CSV is opened. Prefix
 * such values with a single quote — Excel/LibreOffice/Sheets treat the leading
 * quote as a text marker and drop it on display, rendering the cell as text.
 * Exported for unit testing.
 */
export function csvSafeCell(value: string): string {
  const first = value[0];
  if (first === "=" || first === "+" || first === "-" || first === "@" || first === "\t" || first === "\r") {
    return "'" + value;
  }
  return value;
}

/** Derive a human-readable label for a parsed row, for log detail lines.
 *  Reads the most identifying text column from `record` (Object Name or
 *  Title by convention, case-insensitive) since `ArtefactRow` no longer
 *  carries structured id/title fields. Falls back to a positional label so
 *  the log line is never empty. */
function rowLabel(row: ArtefactRow, index?: number): string {
  const record = row.record ?? {};
  const find = (re: RegExp) => {
    const k = Object.keys(record).find((kk) => re.test(kk.trim().toLowerCase()));
    return k ? record[k] : "";
  };
  const name = find(/^(object\s*)?name$/) || find(/^title$/);
  if (name) return name;
  return index != null ? `Row ${index + 1}` : "row";
}

/** Breathing room around embedded images on the exported sheet. The px→chars
 *  width formula is font-approximate, so an exact-fit column lets landscape
 *  photos bleed into the next column; the row pad gives each photo clear air
 *  below before the next row's photo — the photo itself stays flush with the
 *  row's top edge, matching the top-aligned text beside it. */
const IMAGE_COL_PAD_CHARS = 1;
const IMAGE_ROW_PAD_PX = 12;

/** Pure composition of an export table from current state. Returns the headers
 *  and per-row values (strings only — image bytes are embedded separately by
 *  `exportResults` once an ExcelJS workbook exists). Exported so the column
 *  ordering, opt-out filtering, case-insensitive record lookup, and value
 *  resolution can be unit-tested without ExcelJS or Tauri in the loop.
 *
 *  Column order: every `includeInExport` artefact-file column (in configured
 *  order), then every catalogue field (in configured order). AF values read
 *  from the row's parsed `record`; catalogue values fall back through manual
 *  selection → first AI suggestion → empty. Returns `null` when zero AF
 *  columns are selected for export — the caller surfaces the warning. */
export function composeExportTable(
  settings: Settings,
  results: ArtefactRow[],
  aiResults: AiResults,
  fieldSelections: Record<string, FieldSelection>,
): { headers: string[]; rows: string[][]; imageColName: string | null } | null {
  const exportAf = (settings.artefactFields || []).filter((f) => f.includeInExport);
  if (exportAf.length === 0) return null;
  const afHeaders = exportAf.map((f) => f.name);
  const fieldHeaders = settings.fields.map((f) => f.name);
  const headers = [...afHeaders, ...fieldHeaders];
  const imageCol = exportAf.find((f) => isImageRoleName(f.name));
  const rows = results
    .filter((r) => r.status === "done")
    .map((r) => {
      const ai = aiResults[r.uid] || {};
      const record = r.record ?? {};
      const afVals = exportAf.map((f) => recordValueFor(record, f.name));
      const fieldVals = settings.fields.map((f) => {
        const sel = fieldSelections[`${r.uid}_${f.id}`];
        return sel ? sel.value : ai[f.name]?.[0]?.value || "";
      });
      return [...afVals, ...fieldVals];
    });
  return { headers, rows, imageColName: imageCol ? imageCol.name : null };
}

/** Per-column xlsx widths (ExcelJS character units) for the composed table:
 *  the longest of header vs cell text, padded, clamped to [MIN, MAX]. The cap
 *  keeps long descriptions from stretching the sheet — they wrap instead
 *  (wrap alignment is applied by `exportResults`). Exported for unit testing.
 */
export function computeColumnWidths(headers: string[], rows: string[][]): number[] {
  const MIN = 10;
  const MAX = 45;
  return headers.map((h, i) => {
    let longest = h.length;
    for (const row of rows) {
      const len = String(row[i] ?? "").length;
      if (len > longest) longest = len;
    }
    return Math.min(MAX, Math.max(MIN, longest + 2));
  });
}

export function useActions(state: AppState, dispatch: Dispatch, persist: Persist, confirmDelete: ConfirmDelete, getState: () => AppState): AppActions {
  // Owns the catalogue queue: `running` is the re-entrancy lock (only one
  // drainer can ever be alive), `cancelled` breaks the drainer between rows
  // (set by stopQueue). Mirrored to state.queueRunning for the UI.
  const queueControl = useRef({ running: false, cancelled: false });

  // Helper: dispatch a settings patch then schedule persistence.
  const patch = useCallback(
    (fn: (s: Settings) => Settings) => {
      dispatch({ type: "PATCH_SETTINGS", patch: fn });
      persist.schedule();
    },
    [dispatch, persist]
  );

  // Immediate-persist twin of `patch`: apply a functional settings update, then
  // await the flush so the write lands before the action proceeds. For
  // structural ops and any write that follows a long await (dialogs, IPC,
  // in-flight syncs): flush() reads reducer-current state at call time, so the
  // update composes with anything that committed meanwhile instead of
  // overwriting it — never rebuild a whole-settings snapshot from the render
  // closure after an await and SET_SETTINGS it; that clobbered concurrent
  // writes (browsed files vanished, sync results were erased).
  const patchNow = useCallback(
    async (fn: (s: Settings) => Settings) => {
      patch(fn);
      await persist.flush();
    },
    [patch, persist]
  );

  // Helper: mutate the catalogue-field draft WITHOUT persisting. Edits defer to
  // disk until the user clicks Save (mirrors the providers draft flow).
  const patchDraft = useCallback(
    (fn: (d: FieldDraft) => FieldDraft) => {
      dispatch({ type: "PATCH_FIELD_DRAFT", patch: fn });
    },
    [dispatch]
  );

  // Helper: mutate the providers draft WITHOUT persisting. All provider edits —
  // field changes, add, delete, set-active — accumulate here until Save.
  const patchProvDraft = useCallback(
    (fn: (d: ProviderDraft) => ProviderDraft) => {
      dispatch({ type: "PATCH_PROVIDER_DRAFT", patch: fn });
    },
    [dispatch]
  );

  // Helper: mutate the vocabulary-lists draft WITHOUT persisting. Uploaded,
  // renamed, or deleted lists accumulate here until the tab-level Save.
  const patchVocabDraft = useCallback(
    (fn: (d: VocabDraft) => VocabDraft) => {
      dispatch({ type: "PATCH_VOCAB_DRAFT", patch: fn });
    },
    [dispatch]
  );

  // Helper: mutate the artefact-columns draft WITHOUT persisting. Column
  // edits/adds/deletes accumulate here until the tab-level Save.
  const patchArtefactDraft = useCallback(
    (fn: (d: ArtefactDraft) => ArtefactDraft) => {
      dispatch({ type: "PATCH_ARTEFACT_DRAFT", patch: fn });
    },
    [dispatch]
  );

  /** Map a single draft entry by id (immutably). Used by the per-row edit fns. */
  const mapDraftEntry = useCallback(
    (id: string, fn: (e: ProviderDraftEntry) => ProviderDraftEntry) =>
      (d: ProviderDraft): ProviderDraft => ({ ...d, providers: d.providers.map((e) => (e.id === id ? fn(e) : e)) }),
    []
  );

  // Helper: mutate the embedding-providers draft WITHOUT persisting. Mirrors
  // patchProvDraft for the separate embedding-model list.
  const patchEmbProvDraft = useCallback(
    (fn: (d: EmbeddingProviderDraft) => EmbeddingProviderDraft) => {
      dispatch({ type: "PATCH_EMB_PROVIDER_DRAFT", patch: fn });
    },
    [dispatch]
  );

  /** Map a single embedding-provider draft entry by id. Mirrors mapDraftEntry. */
  const mapEmbDraftEntry = useCallback(
    (id: string, fn: (e: EmbeddingProviderDraft["providers"][number]) => EmbeddingProviderDraft["providers"][number]) =>
      (d: EmbeddingProviderDraft): EmbeddingProviderDraft => ({ ...d, providers: d.providers.map((e) => (e.id === id ? fn(e) : e)) }),
    []
  );

  // --- theme / nav / zoom ---
  const toggleDark = useCallback(() => {
    dispatch({ type: "SET_DARK", darkMode: !state.darkMode });
    persist.schedule();
  }, [state.darkMode, dispatch, persist]);

  /** Discard the whole-tab draft for the given settings tab (mirrors each tab's
   *  "Discard all"). Used by the navigation guard so "discard changes" actually
   *  clears what the user is being warned about. */
  const discardTabDraft = useCallback((tab: SettingsTab) => {
    switch (tab) {
      case "fields": dispatch({ type: "CLEAR_FIELD_DRAFT" }); break;
      case "vocab": dispatch({ type: "CLEAR_VOCAB_DRAFT" }); break;
      case "modelProviders":
        dispatch({ type: "CLEAR_PROVIDER_DRAFT" });
        dispatch({ type: "CLEAR_EMB_PROVIDER_DRAFT" });
        break;
      case "artefactFile": dispatch({ type: "CLEAR_ARTEFACT_DRAFT" }); break;
      case "about": break;
    }
  }, [dispatch]);

  /** Prompt to discard the current tab's unsaved changes before navigating
   *  away. Returns true when navigation may proceed (no changes, or the user
   *  confirmed discard); false when the user cancelled. */
  const guardLeave = useCallback(async (): Promise<boolean> => {
    const tab = state.settingsTab;
    if (!isTabDirty(state, tab)) return true;
    const ok = await confirmDelete({
      title: "Discard changes?",
      message: "This tab has unsaved changes. Discard them and leave?",
      confirmLabel: "Discard",
    });
    if (!ok) return false;
    discardTabDraft(tab);
    return true;
  }, [state, confirmDelete, discardTabDraft]);

  const goMain = useCallback(async () => {
    if (!(await guardLeave())) return;
    dispatch({ type: "SET_SCREEN", screen: "main" });
  }, [guardLeave, dispatch]);
  const goSettings = useCallback((tab: SettingsTab = "fields") => {
    dispatch({ type: "SET_SCREEN", screen: "settings" });
    dispatch({ type: "SET_TAB", tab });
  }, [dispatch]);
  const setTab = useCallback(async (t: SettingsTab) => {
    if (t === state.settingsTab) return;
    if (!(await guardLeave())) return;
    dispatch({ type: "SET_TAB", tab: t });
  }, [state.settingsTab, guardLeave, dispatch]);
  const zoomIn = useCallback(() => {
    const z = Math.min(1.5, +(state.zoom + 0.05).toFixed(2));
    dispatch({ type: "SET_ZOOM", zoom: z });
    persist.schedule();
  }, [state.zoom, dispatch, persist]);
  const zoomOut = useCallback(() => {
    const z = Math.max(0.7, +(state.zoom - 0.05).toFixed(2));
    dispatch({ type: "SET_ZOOM", zoom: z });
    persist.schedule();
  }, [state.zoom, dispatch, persist]);
  const toggleLogs = useCallback(() => dispatch({ type: "SET_LOGS_OPEN", open: !state.logsOpen }), [state.logsOpen, dispatch]);
  const setLogsOpen = useCallback((open: boolean) => dispatch({ type: "SET_LOGS_OPEN", open }), [dispatch]);

  // Hidden file inputs (created lazily, reused).
  const ensureInput = useCallback(
    (accept: string, onFiles: (files: FileList) => void) => {
      const appWindow = window as AppWindow;
      let el = appWindow.__acFi;
      if (!el) {
        el = document.createElement("input");
        el.type = "file";
        el.multiple = true;
        el.style.display = "none";
        document.body.appendChild(el);
        appWindow.__acFi = el;
      }
      el.accept = accept;
      el.onchange = () => {
        if (el!.files && el!.files.length) onFiles(el!.files);
        el!.value = "";
      };
      el.click();
    },
    []
  );

  // --- files (import = validate + parse in one step) ---
  // A valid file's records land in the results panel immediately (status
  // "queued", grouped by the file they came from); an invalid one fails loudly
  // with a per-file error card. There is no separate Parse click.
  const addFiles = useCallback(
    async (list: FileList | File[]) => {
      const all = Array.from(list);
      // Fail loudly on non-.xlsx files — silently skipping them left users
      // guessing why nothing appeared.
      for (const f of all.filter((cand) => !/\.xlsx$/i.test(cand.name))) {
        dispatch({
          type: "SET_FILES",
          files: [{ id: gid(), name: f.name, size: f.size, sizeLabel: fmt(f.size), status: "invalid" as const, errors: [{ message: "Not an .xlsx file — only .xlsx artefact files can be imported." }] }],
        });
        pushLog({ status: "fail", label: "File rejected", detail: `${f.name}: only .xlsx artefact files can be imported` });
      }

      for (const file of all.filter((f) => /\.xlsx$/i.test(f.name))) {
        const id = gid();
        dispatch({ type: "SET_FILES", files: [{ id, name: file.name, size: file.size, sizeLabel: fmt(file.size), status: "validating" as const, errors: [] }] });
        try {
          const parsed = await parseArtefactFile(file, state.settings);
          const errs = [
            ...parsed.missingColumns.map((c) => ({ message: `Missing required column: ${c}` })),
            ...parsed.columnProblems.map((m) => ({ message: m })),
          ];
          if (errs.length) {
            dispatch({ type: "SET_FILE_STATUS", id, status: "invalid", errors: errs });
            pushLog({
              status: "fail",
              label: "Import failed",
              detail: `${file.name}: ${errs.length} column problem${errs.length === 1 ? "" : "s"}`,
              verbose: { error: errs.map((e) => e.message).join("; ") },
            });
            continue;
          }

          // Valid — promote straight into the results panel as queued rows.
          const rows = parsed.rows.map((r) => ({ ...r, status: "queued" as const, fileId: id, sourceName: file.name }));
          dispatch({ type: "REMOVE_FILE", id });
          dispatch({ type: "PARSE_FILES", rows });
          const discarded = Object.keys(parsed.discardedColumns);
          pushLog({
            status: "ok",
            label: `Imported ${rows.length} record${rows.length === 1 ? "" : "s"}`,
            detail: `${file.name}${discarded.length ? ` · ${discarded.length} discarded field${discarded.length === 1 ? "" : "s"}` : ""}`,
            verbose: { discardedColumns: parsed.discardedColumns },
          });

          // Extract embedded images to disk beside the binary, then attach
          // paths. Best-effort: a row without an image continues imageless (the
          // failure is logged so it's diagnosable rather than silent).
          try {
            const res = await extractImagesFromXlsx(file, parsed.imageRowIndices, parsed.sheetRowToDataRow, gid());
            res.rowIndexToFileId.forEach((absPath, rowIdx) => {
              const row = rows[rowIdx];
              if (row) dispatch({ type: "SET_ROW_IMAGE", uid: row.uid, imagePath: absPath });
            });
          } catch (e) {
            pushLog({
              status: "fail",
              jobId: "extract",
              label: "Image extraction failed",
              detail: `${file.name}: rows will catalogue without an embedded image.`,
              verbose: { error: String((e as Error)?.message || e) },
            });
          }
        } catch (e) {
          const message = String((e as Error)?.message || e);
          dispatch({ type: "SET_FILE_STATUS", id, status: "invalid", errors: [{ message: `Could not read file: ${message}` }] });
          pushLog({ status: "fail", label: "Import failed", detail: file.name, verbose: { error: message } });
        }
      }
    },
    [dispatch, state.settings]
  );

  const onUploadClick = useCallback(() => ensureInput(".xlsx", (fl) => void addFiles(fl)), [ensureInput, addFiles]);

  const setUploadDrag = useCallback((drag: boolean) => dispatch({ type: "SET_UPLOAD_DRAG", drag }), [dispatch]);
  const { onDragOver, onDragLeave, onDrop } = useDropZone(setUploadDrag, (fl) => void addFiles(fl));

  const removeFile = useCallback((id: string) => dispatch({ type: "REMOVE_FILE", id }), [dispatch]);

  // --- catalogue queue ---
  // Run one row's AI call and write its terminal status. Fail-soft: an error
  // marks only this row and the drainer continues (the row's log entry carries
  // the reason); a transport cancel (per-row Stop or queue Stop) marks it
  // `cancelled`.
  const runRow = useCallback(async (row: ArtefactRow, prov: Provider) => {
    const jobId = `row-${row.uid}`;
    dispatch({ type: "SET_ROW_STATUS", uid: row.uid, status: "processing" });
    const record = row.record ?? {};
    pushLog({
      status: "busy",
      jobId,
      label: "Now cataloguing",
      detail: rowLabel(row),
      verbose: { record },
    });

    const start = performance.now();
    try {
      const ai = await catalogueArtefact(prov, state.settings.fields, record, row.imagePath, state.settings, `row-${row.uid}`);
      dispatch({ type: "SET_ROW_STATUS", uid: row.uid, status: "done", ai });
      pushLog({
        status: "ok",
        jobId,
        label: "Populated into cataloguing fields",
        detail: `${Object.keys(ai).length} fields`,
        elapsedMs: Math.round(performance.now() - start),
        verbose: {
          record: Object.fromEntries(
            Object.entries(ai).map(([k, v]) => [k, (v || []).map((s) => `${s.value}${s.similarity != null ? ` (${Math.round(s.similarity * 100)}%)` : ""}`).join(" · ")])
          ),
        },
      });
    } catch (e) {
      const message = String((e as Error)?.message || e);
      // A cancel is a user action, not a failure: mark the row cancelled and
      // stay quiet in the logs (Stop has no error to surface).
      if (message === CANCEL_ERROR) {
        dispatch({ type: "SET_ROW_STATUS", uid: row.uid, status: "cancelled" });
        pushLog({ status: "ok", jobId, label: "Row cancelled", detail: rowLabel(row), elapsedMs: Math.round(performance.now() - start) });
        return;
      }
      dispatch({ type: "SET_ROW_STATUS", uid: row.uid, status: "error" });
      pushLog({ status: "fail", jobId, label: "Row failed", detail: message, elapsedMs: Math.round(performance.now() - start), verbose: { error: message } });
    }
  }, [state.settings, dispatch]);

  // Drain every `queued` row, one AI call in flight. The next row is taken
  // from live state each iteration, so rows imported or requeued mid-run
  // merge into the drain naturally.
  const startQueue = useCallback(async () => {
    if (queueControl.current.running) return;
    const preflightError = parsePreFlightError(state.settings);
    if (preflightError) {
      dispatch({ type: "SET_PARSE_ERROR", error: preflightError });
      return;
    }
    // parsePreFlightError guarantees an active provider from here on.
    const prov = activeProvider(state.settings);
    if (!prov) return;
    // A previous run's banner is stale once Start succeeds.
    dispatch({ type: "SET_PARSE_ERROR", error: null });

    queueControl.current = { running: true, cancelled: false };
    dispatch({ type: "SET_QUEUE_RUNNING", running: true });
    try {
      for (;;) {
        if (queueControl.current.cancelled) break;
        const row = getState().results.find((r) => r.status === "queued");
        if (!row) break;
        await runRow(row, prov);
        await delay(300 + Math.random() * 300);
      }
    } finally {
      queueControl.current.running = false;
      dispatch({ type: "SET_QUEUE_RUNNING", running: false });
    }
  }, [state.settings, dispatch, getState, runRow]);

  const stopQueue = useCallback(async () => {
    if (!queueControl.current.running) return;
    queueControl.current.cancelled = true;
    // Transport-cancel every in-flight row; the awaiting runRow catch is the
    // single writer of the resulting `cancelled` status.
    for (const r of getState().results.filter((r) => r.status === "processing")) {
      try {
        await cancelCatalogue(`row-${r.uid}`);
      } catch (e) {
        // Cancelling an already-finished job can fail; the row's own status is
        // the truth, so keep stopping the rest.
        pushLog({ status: "fail", label: "Stop failed", detail: String((e as Error)?.message || e) });
      }
    }
    // Wait briefly for settlement so the header doesn't flip back to Start
    // while a row is still finishing.
    for (let i = 0; i < 100; i++) {
      if (!getState().results.some((r) => r.status === "processing")) break;
      await delay(100);
    }
    pushLog({ status: "ok", label: "Queue stopped", detail: "Queued rows remain queued — press Start to resume" });
  }, [getState]);

  // Pure requeue: Retry never runs anything itself, so a failing row can't
  // loop — the user starts the queue again when ready.
  const retryFailed = useCallback(() => {
    const uids = getState().results.filter((r) => r.status === "error" || r.status === "cancelled").map((r) => r.uid);
    if (uids.length === 0) return;
    dispatch({ type: "REQUEUE_ROWS", uids });
    pushLog({ status: "busy", label: "Retry failed rows", detail: `${uids.length} row${uids.length === 1 ? "" : "s"} requeued` });
  }, [dispatch, getState]);

  const requeueRow = useCallback((uid: string) => {
    dispatch({ type: "REQUEUE_ROWS", uids: [uid] });
  }, [dispatch]);

  const dismissParseError = useCallback(() => dispatch({ type: "SET_PARSE_ERROR", error: null }), [dispatch]);

  // Delete one record: confirm, cancel any in-flight AI call, then remove the
  // row plus all of its per-row state (REMOVE_ROWS prunes the uid-keyed maps).
  const deleteRow = useCallback(async (uid: string) => {
    const row = getState().results.find((r) => r.uid === uid);
    if (!row) return;
    const ok = await confirmDelete({
      title: "Delete record?",
      message: "This removes the record and its AI results from the list. This cannot be undone.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    // Re-check live: the dialog paused the user, not the app.
    if (getState().results.find((r) => r.uid === uid)?.status === "processing") {
      try {
        await cancelCatalogue(`row-${uid}`);
      } catch {
        // The removal below is authoritative; a failed cancel on an
        // already-settled job doesn't block the delete.
      }
    }
    dispatch({ type: "REMOVE_ROWS", uids: [uid] });
    pushLog({ status: "ok", label: "Record deleted", detail: rowLabel(row) });
  }, [confirmDelete, dispatch, getState]);

  // Stop a single in-flight row by cancelling its transport-level AI call. The
  // awaiting runRow catch then transitions the row to `cancelled`.
  // No status change here: the row is `processing`, and flipping it preemptively
  // would race the catch (which is the single owner of the terminal status).
  const stopRow = useCallback(async (uid: string) => {
    const row = getState().results.find((r) => r.uid === uid);
    if (!row || row.status !== "processing") return; // nothing to stop
    await cancelCatalogue(`row-${uid}`);
  }, [getState]);

  // Delete every record imported from one artefact file (a results group):
  // confirm, cancel any in-flight calls, then remove them all.
  const deleteFileRows = useCallback(async (fileId: string) => {
    const rows = getState().results.filter((r) => r.fileId === fileId);
    if (rows.length === 0) return;
    const name = rows[0].sourceName;
    const ok = await confirmDelete({
      title: "Delete all records from this file?",
      message: `This removes all ${rows.length} record${rows.length === 1 ? "" : "s"} imported from "${name}", including their AI results. This cannot be undone.`,
      confirmLabel: "Delete all",
    });
    if (!ok) return;
    // Re-snapshot live: rows kept moving while the dialog was open.
    const live = getState().results.filter((r) => r.fileId === fileId);
    if (live.length === 0) return;
    for (const r of live) {
      if (r.status === "processing") {
        try {
          await cancelCatalogue(`row-${r.uid}`);
        } catch {
          // The removal below is authoritative.
        }
      }
    }
    dispatch({ type: "REMOVE_ROWS", uids: live.map((r) => r.uid) });
    pushLog({ status: "ok", label: "Records deleted", detail: `${live.length} record${live.length === 1 ? "" : "s"} from ${name}` });
  }, [confirmDelete, dispatch, getState]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--split-h")) || 180;
    const mv = (ev: MouseEvent) =>
      document.documentElement.style.setProperty("--split-h", Math.max(120, Math.min(420, startH + (ev.clientY - startY))) + "px");
    const up = () => {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
  }, []);

  // --- results interaction ---
  const toggleRow = useCallback((uid: string) => dispatch({ type: "TOGGLE_ROW", uid }), [dispatch]);
  const setFilter = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => dispatch({ type: "SET_FILTER", filter: e.target.value }), [dispatch]);
  const setSearch = useCallback((e: React.ChangeEvent<HTMLInputElement>) => dispatch({ type: "SET_SEARCH", search: e.target.value }), [dispatch]);
  // Search column scope (multi-select in the Results column picker). The
  // scope may be emptied; an empty scope returns no matches when searched.
  const toggleSearchColAf = useCallback((id: string) => dispatch({ type: "TOGGLE_SEARCH_COL_AF", id }), [dispatch]);
  const toggleSearchColCat = useCallback((id: string) => dispatch({ type: "TOGGLE_SEARCH_COL_CAT", id }), [dispatch]);
  const setSearchColsAf = useCallback((ids: string[]) => dispatch({ type: "SET_SEARCH_COLS_AF", ids }), [dispatch]);
  const setSearchColsCat = useCallback((ids: string[]) => dispatch({ type: "SET_SEARCH_COLS_CAT", ids }), [dispatch]);
  const dismissExportWarning = useCallback(() => dispatch({ type: "SET_EXPORT_WARNING", message: null }), [dispatch]);

  const exportResults = useCallback(async () => {
    const { results, settings, aiResults, fieldSelections } = state;
    const table = composeExportTable(settings, results, aiResults, fieldSelections);
    if (!table) {
      // Zero artefact-file columns selected — surface as a dismissable warning
      // in the same panel as parse errors, instead of silently writing a
      // header-only file. Catalogue fields alone are never exported without a
      // leading AF column to anchor the row.
      dispatch({ type: "SET_EXPORT_WARNING", message: "No artefact-file columns are selected for export. Enable at least one column's export toggle in Settings → Artefact File." });
      return;
    }
    dispatch({ type: "SET_EXPORT_WARNING", message: null });
    const { headers, rows, imageColName } = table;
    const doneRows = results.filter((r) => r.status === "done");

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Catalogue");
    ws.columns = headers.map((h) => ({ header: h, key: h }));
    ws.getRow(1).font = { bold: true };
    // Light indigo shade over the catalogue-field header cells so the leading
    // artefact-file columns read as a distinct block in the exported sheet.
    // Concrete ARGB (indigo-50) — a workbook artifact, like the status-dot hex.
    const afCount = headers.length - settings.fields.length;
    for (let c = afCount + 1; c <= headers.length; c++) {
      ws.getRow(1).getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF2FF" } };
    }
    rows.forEach((vals) => {
      // Prefix formula-injection triggers (= + - @ \t \r) with a single quote
      // so spreadsheet apps render these as text — same guard the old CSV
      // exporter applied via csvSafeCell, now applied per cell as the row is
      // added. Keeps the protection in lockstep with the value resolution.
      const safe = vals.map((c) => csvSafeCell(String(c)));
      ws.addRow(Object.fromEntries(headers.map((h, i) => [h, safe[i]])));
    });

    // Sheet geometry: size every column to its content and wrap data cells,
    // so headers and values are fully readable. Widths are clamped
    // (see computeColumnWidths); wrapped text grows rows via Excel's
    // auto-height unless the row gets an explicit image height below.
    computeColumnWidths(headers, rows).forEach((w, i) => {
      ws.getColumn(i + 1).width = w;
    });
    for (let r = 2; r <= ws.rowCount; r++) {
      ws.getRow(r).eachCell({ includeEmpty: true }, (cell) => {
        cell.alignment = { wrapText: true, vertical: "top" };
      });
    }

    // Embed the actual image bytes for any toggled-on image column. The image
    // column carries no text (its bytes go to artefact analysis separately at parse), so
    // its cell above is empty; this anchors the extracted image to that cell.
    if (imageColName) {
      const colIdx = headers.indexOf(imageColName); // 0-based
      let maxImageWidth = 0;
      await Promise.all(doneRows.map(async (r, rowIdx) => {
        if (!r.imagePath) {
          // No extracted image for this row (source sheet had none, or
          // extraction failed at parse) — leave the cell empty but say so.
          pushLog({
            status: "fail",
            label: "Export image skipped",
            detail: `Row ${rowIdx + 1}: no extracted image for this row`,
          });
          return;
        }
        try {
          // Image bytes live on disk beside the binary (written by
          // extract_images at parse). Read them back and embed pinned to this
          // row's image cell. ExcelJS accepts Uint8Array/ArrayBuffer at
          // runtime for the buffer — its bundled TS types lag the runtime
          // (they want Buffer), so we feed it the shape the docs document.
          const bytes = await readFile(r.imagePath);
          const lower = r.imagePath.toLowerCase();
          const extension: "png" | "jpeg" = lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "jpeg" : "png";
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const id = wb.addImage({ buffer: bytes as any, extension });
          // One-cell anchor with explicit pixel extents: a range-string
          // anchor ("B2:B2") stretches the image to the cell box — a ~19px
          // sliver at default row height. `tl` is 0-based; data rows start at
          // sheet row 2, hence rowIdx + 1.
          const dims = imageDimensions(bytes);
          const { width, height } = fitWithin(dims.width, dims.height);
          ws.addImage(id, { tl: { col: colIdx, row: rowIdx + 1 }, ext: { width, height }, editAs: "oneCell" });
          // Default ~20px rows would leave a 200px photo spilling over the
          // rows below — give the row an explicit height fitting the photo
          // plus bottom pad (and the wrapped text beside it). The photo
          // anchors flush to the row's top, like the text. Imageless rows
          // keep auto-height.
          ws.getRow(rowIdx + 2).height = rowHeightPoints(height + IMAGE_ROW_PAD_PX);
          if (width > maxImageWidth) maxImageWidth = width;
        } catch (e) {
          // Missing/unreadable image — leave the cell empty rather than abort
          // the whole export; surface it so gaps are diagnosable in the Logs
          // Viewer.
          const message = String((e as Error)?.message || e);
          pushLog({
            status: "fail",
            label: "Export image skipped",
            detail: `Row ${rowIdx + 1}: ${message}`,
            verbose: { error: message },
          });
        }
      }));
      // Photos sit in the Image column: widen it past its text width so a
      // 200px image doesn't spill across the neighbouring columns.
      if (maxImageWidth > 0) {
        const col = ws.getColumn(colIdx + 1);
        col.width = Math.max(col.width ?? 0, columnWidthChars(maxImageWidth) + IMAGE_COL_PAD_CHARS);
      }
    }

    try {
      const target = await save({ defaultPath: "artefact_catalogue.xlsx", filters: [{ name: "Excel", extensions: ["xlsx"] }] });
      if (target) {
        const buf = await wb.xlsx.writeBuffer();
        await writeFile(target, new Uint8Array(buf));
      }
    } catch {
      // Fallback: data URL download (e.g. if the dialog plugin is unavailable).
      // xlsx is binary; fall back to a CSV dump of the text cells (images are
      // lost) so the user at least gets the catalogue content out.
      const csv = [headers, ...rows]
        .map((r) => r.map((c) => `"${csvSafeCell(String(c)).replace(/"/g, '""')}"`).join(","))
        .join("\n");
      const a = document.createElement("a");
      a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
      a.download = "artefact_catalogue.csv";
      a.click();
    }
  }, [state, dispatch]);

  const onTriggerClick = useCallback(
    (key: string) => {
      if (state.fieldDropdownOpen[key]) {
        dispatch({ type: "CLOSE_ALL_DD" });
        return;
      }
      dispatch({ type: "OPEN_DD", key });
      // Outside-click close.
      const close = () => {
        dispatch({ type: "CLOSE_ALL_DD" });
        document.removeEventListener("click", close);
      };
      setTimeout(() => document.addEventListener("click", close), 0);
    },
    [state.fieldDropdownOpen, dispatch]
  );
  const setFieldSearch = useCallback((key: string, val: string) => dispatch({ type: "SET_FIELD_SEARCH", key, value: val }), [dispatch]);
  const toggleFieldValue = useCallback(
    (key: string, value: string, source: "ai" | "vocab" | "manual", listName: string, similarity: number | null, multi: boolean) =>
      dispatch({ type: "TOGGLE_FIELD_VALUE", key, value, source, listName, similarity, multi }),
    [dispatch]
  );
  const clearField = useCallback((key: string) => dispatch({ type: "CLEAR_FIELD", key }), [dispatch]);
  const setOpenFieldValue = useCallback((key: string, val: string) => dispatch({ type: "SET_OPEN_VALUE", key, value: val }), [dispatch]);

  // --- settings: shared across card-list tabs ---
  const setAllExpanded = useCallback(
    (scope: "settingsFieldExpanded" | "settingsVocabExpanded" | "artefactFieldExpanded", ids: string[], expanded: boolean) =>
      dispatch({ type: "SET_ALL_EXPANDED", scope, ids, expanded }),
    [dispatch]
  );

  // --- settings: fields ---
  const toggleSF = useCallback((id: string) => dispatch({ type: "TOGGLE_SF", id }), [dispatch]);
  const toggleProv = useCallback((id: string) => dispatch({ type: "TOGGLE_PROV", id }), [dispatch]);
  const reorderFields = useCallback(async (ids: string[]) => {
    // Only reorder persisted rows; skip any draft-only ids (new unsaved rows).
    // The guard runs inside the functional updater so it judges the reducer's
    // current fields, not this render's snapshot.
    try {
      await patchNow((s) => {
        const savedById = new Map(s.fields.map((f) => [f.id, f] as const));
        const reorderedSavedIds = ids.filter((id) => savedById.has(id));
        if (reorderedSavedIds.length !== s.fields.length) return s;
        return { ...s, fields: reorderedSavedIds.map((id) => savedById.get(id)!) };
      });
      // Mirror reorder into draft using draft values, preserving content edits.
      patchDraft((d) => {
        const draftById = new Map(d.fields.map((f) => [f.id, f] as const));
        const reorderedDraft = ids.map((id) => draftById.get(id)).filter((f): f is CatalogueField => !!f);
        return reorderedDraft.length === d.fields.length ? { ...d, fields: reorderedDraft } : d;
      });
    } catch { console.error("[artefact] reorderFields: save failed"); }
  }, [patchNow, patchDraft]);
  const removeField = useCallback(async (id: string) => {
    const liveFields = state.fieldDraft?.fields ?? state.settings.fields;
    const label = liveFields.find((f) => f.id === id)?.name || "this field";
    const ok = await confirmDelete({
      title: "Delete catalogue field?",
      message: `Delete "${label}"? This immediately removes the field from all artefacts.`,
    });
    if (!ok) return;
    try {
      // The dialog await can outlast other writes — prune via reducer-current
      // settings, not a snapshot (mirrors removeVocabSource).
      await patchNow((s) => ({ ...s, fields: s.fields.filter((f) => f.id !== id) }));
      if (state.fieldDraft) {
        patchDraft((d) => ({ ...d, fields: d.fields.filter((f) => f.id !== id) }));
      }
    } catch { console.error("[artefact] removeField: save failed"); }
  }, [state.fieldDraft, state.settings, patchNow, patchDraft, confirmDelete]);
  const updateField = useCallback((id: string, key: EditableCatalogueFieldKey, value: string | number | boolean) => {
    patchDraft((d) => ({ ...d, fields: d.fields.map((f) => (f.id === id ? { ...f, [key]: value } : f)) }));
  }, [patchDraft]);
  const addVocabSrc = useCallback((fId: string, vId: string) => {
    patchDraft((d) => ({ ...d, fields: d.fields.map((f) => (f.id === fId ? { ...f, vocabSources: [...f.vocabSources, vId] } : f)) }));
  }, [patchDraft]);
  const removeVocabSrc = useCallback((fId: string, sId: string) => {
    patchDraft((d) => ({ ...d, fields: d.fields.map((f) => (f.id === fId ? { ...f, vocabSources: f.vocabSources.filter((id) => id !== sId) } : f)) }));
  }, [patchDraft]);

  // --- per-card save/discard (catalogue fields) ---
  // Each card persists/reverts only its own slice, while structural changes
  // (add/delete/reorder) stay buffered for the tab-level Apply. A card Save
  // writes `settings` with only that card's draft slice applied, then syncs
  // the draft entry to its new persisted value in place so other pending
  // entries are untouched.
  const saveFieldCard = useCallback(async (id: string) => {
    const draft = state.fieldDraft;
    if (!draft) return;
    const cardField = draft.fields.find((f) => f.id === id);
    if (!cardField) return;
    dispatch({ type: "SET_FIELD_CARD_STATUS", id, status: "saving" });
    try {
      // Upsert: replace if the field still persists, else append (a newly-added
      // field isn't in settings yet — its per-card Save persists it in place).
      // Judged against reducer-current fields so the Save composes with any
      // write that landed while the card was being edited.
      await patchNow((s) => {
        const fields = s.fields.some((f) => f.id === id)
          ? s.fields.map((f) => (f.id === id ? { ...cardField } : f))
          : [...s.fields, { ...cardField }];
        return { ...s, fields };
      });
      // Sync the draft entry to its now-persisted value so this card reads as
      // clean while any other pending cards/structural changes stay buffered.
      dispatch({ type: "PATCH_FIELD_DRAFT", patch: (d) => ({ ...d, fields: d.fields.map((f) => (f.id === id ? { ...cardField } : f)) }) });
      dispatch({ type: "SET_FIELD_CARD_STATUS", id, status: "ok" });
    } catch {
      dispatch({ type: "SET_FIELD_CARD_STATUS", id, status: "err" });
    }
  }, [state.fieldDraft, patchNow, dispatch]);

  const discardFieldCard = useCallback((id: string) => {
    const draft = state.fieldDraft;
    if (!draft) return;
    const saved = state.settings.fields.find((f) => f.id === id);
    dispatch({ type: "SET_FIELD_CARD_STATUS", id, status: null });
    if (!saved) {
      // Newly-added field has no persisted value to revert to — drop it.
      dispatch({ type: "PATCH_FIELD_DRAFT", patch: (d) => ({ ...d, fields: d.fields.filter((f) => f.id !== id) }) });
      return;
    }
    dispatch({ type: "PATCH_FIELD_DRAFT", patch: (d) => ({ ...d, fields: d.fields.map((f) => (f.id === id ? { ...saved, vocabSources: [...saved.vocabSources] } : f)) }) });
  }, [state.fieldDraft, state.settings.fields, dispatch]);

  // Append an empty catalogue-field row directly into the draft and expand it,
  // mirroring startAddProv — the user fills it in inline rather than via a
  // separate "New Field" form. CataloguingFieldsTab scrolls the new row into view.
  const startAddField = useCallback(() => {
    const id = gid();
    patchDraft((d) => ({ ...d, fields: [...d.fields, { id, name: "", type: "open", layout: "row", prompt: "", vocabSources: [], maxComponents: 1 }] }));
    dispatch({ type: "TOGGLE_SF", id });
  }, [patchDraft, dispatch]);

  // --- settings: vocab ---
  // A source's files/fields/embedding status have real Rust-side disk effects
  // (staged bytes, a LanceDB table) and persist immediately, mirroring
  // removeVocabList's old "no banner" structural-change pattern — buffering
  // them in a draft would let Discard desync the UI from what's already on
  // disk. Only the Display Name is draft-buffered per card (unchanged from
  // before). Reorders and deletes also persist immediately.
  //
  // Every mutation below applies its change through a functional PATCH_SETTINGS
  // updater (patch/updateVocabSource) so it composes onto the reducer's
  // *current* settings. Several of these interleave slow awaits (file staging,
  // confirm dialogs, flush IPC); rebuilding whole-settings snapshots from the
  // render-time closure after those awaits clobbered any write that committed
  // meanwhile — browsed files silently vanished from the card once collapsed.
  const startAddVocabSource = useCallback(() => {
    const id = gid();
    patchVocabDraft((d) => ({ ...d, vocabSources: [...d.vocabSources, newVocabSource(id)] }));
    // Also seed persisted settings immediately (structural add, like startAddField
    // does for its own draft) so the source exists on disk for the very first
    // addFilesToSource call, which needs a real sourceId to stage files under.
    patch((s) => ({ ...s, vocabSources: [...s.vocabSources, newVocabSource(id)] }));
    dispatch({ type: "TOGGLE_VOCAB", id });
  }, [patchVocabDraft, patch, dispatch]);

  const addFilesToSource = useCallback(async (sourceId: string, list: FileList | File[]) => {
    // Existence pre-check against this render's settings is for fast-fail only
    // (sources are created synchronously and removed via confirm-gated deletes,
    // so this can't false-positive); the merge itself runs reducer-current.
    if (!state.settings.vocabSources.some((v) => v.id === sourceId)) {
      dispatch({ type: "SET_VOCAB_CARD_ERROR", id: sourceId, error: "This vocabulary source no longer exists." });
      dispatch({ type: "SET_VOCAB_CARD_STATUS", id: sourceId, status: "err" });
      return;
    }
    const ok = Array.from(list).filter((f) => /\.(xlsx|xls|csv)$/i.test(f.name));
    if (!ok.length) return;
    dispatch({ type: "SET_VOCAB_CARD_ERROR", id: sourceId, error: null });
    dispatch({ type: "SET_VOCAB_CARD_STATUS", id: sourceId, status: "saving" });
    try {
      const staged: StagedVocabFile[] = [];
      try {
        for (const f of ok) {
          const bytes = new Uint8Array(await f.arrayBuffer());
          staged.push(await vocabLib.stageVocabFile(sourceId, f.name, bytes));
        }
      } catch (stageErr) {
        // Roll back whatever already staged so disk never holds half a batch.
        await Promise.allSettled(staged.map((f) => vocabLib.removeVocabFile(sourceId, f.filename)));
        throw stageErr;
      }
      await patchNow((s) => updateVocabSource(s, sourceId, (v) => sourceWithAddedFiles(v, staged)));
      dispatch({ type: "SET_VOCAB_CARD_STATUS", id: sourceId, status: "ok" });
    } catch (e) {
      console.error("[artefact] addFilesToSource failed:", e);
      dispatch({ type: "SET_VOCAB_CARD_ERROR", id: sourceId, error: (e as Error)?.message || String(e) });
      dispatch({ type: "SET_VOCAB_CARD_STATUS", id: sourceId, status: "err" });
    }
  }, [state.settings, patchNow, dispatch]);

  const removeFileFromSource = useCallback(async (sourceId: string, filename: string) => {
    try {
      await vocabLib.removeVocabFile(sourceId, filename);
      await patchNow((s) => updateVocabSource(s, sourceId, (v) => sourceWithRemovedFile(v, filename)));
    } catch {
      console.error("[artefact] removeFileFromSource failed");
    }
  }, [patchNow]);

  const downloadVocabFile = useCallback(async (sourceId: string, filename: string) => {
    const bytes = await vocabLib.downloadVocabFile(sourceId, filename);
    try {
      const target = await save({ defaultPath: filename });
      if (target) await writeFile(target, bytes);
    } catch {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([bytes as BlobPart]));
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }, []);

  const toggleSourceFieldAI = useCallback((sourceId: string, fieldName: string) => {
    // Toggling includeForAI changes embed_text, so a synced index is now stale
    // regardless of whether the underlying file content changed (see M2 diff-
    // key nuance: the fields-config version is part of the effective row hash).
    patch((s) =>
      updateVocabSource(s, sourceId, (v) => ({
        ...v,
        fields: v.fields.map((f) => (f.name === fieldName ? { ...f, includeForAI: !f.includeForAI } : f)),
        embedding: markStaleIfSynced(v.embedding),
      }))
    );
  }, [patch]);

  const setVocabIngestionField = useCallback((sourceId: string, fieldName: string | null) => {
    // Changing which column supplies the term changes every row's identity,
    // so a synced index is stale regardless of whether file bytes changed —
    // mirrors toggleSourceFieldAI's stale-marking above.
    patch((s) => updateVocabSource(s, sourceId, (v) => ({ ...v, ingestionField: fieldName, embedding: markStaleIfSynced(v.embedding) })));
  }, [patch]);

  const setVocabLabelField = useCallback((sourceId: string, fieldName: string | null) => {
    // Purely cosmetic — never marks the source stale. A column can only be
    // Label or Badge, not both, so picking it as Label clears it from Badge.
    patch((s) =>
      updateVocabSource(s, sourceId, (v) => {
        const badgeField = fieldName && v.badgeField === fieldName ? null : v.badgeField;
        return { ...v, labelField: fieldName, badgeField };
      })
    );
  }, [patch]);

  const setVocabBadgeField = useCallback((sourceId: string, fieldName: string | null) => {
    // Mirror of setVocabLabelField's exclusivity rule.
    patch((s) =>
      updateVocabSource(s, sourceId, (v) => {
        const labelField = fieldName && v.labelField === fieldName ? null : v.labelField;
        return { ...v, badgeField: fieldName, labelField };
      })
    );
  }, [patch]);

  const ensureVocabTermsLoaded = useCallback(async (sourceId: string) => {
    if (state.vocabTermCache[sourceId] || state.vocabTermCacheLoading[sourceId]) return;
    dispatch({ type: "SET_VOCAB_TERMS_LOADING", id: sourceId });
    try {
      const terms = await vocabLib.listVocabTerms(sourceId);
      dispatch({ type: "SET_VOCAB_TERMS", id: sourceId, terms });
    } catch (e) {
      console.error("[artefact] ensureVocabTermsLoaded failed:", e);
      dispatch({ type: "SET_VOCAB_TERMS", id: sourceId, terms: [] });
    }
  }, [state.vocabTermCache, state.vocabTermCacheLoading, dispatch]);

  // Warm the term cache for every already-synced source once persisted
  // settings have loaded, so the manual vocab-picker dropdown has its full
  // list ready without waiting for a first dropdown-open fetch.
  useEffect(() => {
    if (!state.loaded) return;
    for (const v of state.settings.vocabSources) {
      if (v.embedding.status === "synced") void ensureVocabTermsLoaded(v.id);
    }
  }, [state.loaded, state.settings.vocabSources, ensureVocabTermsLoaded]);

  // Sync reads its per-source inputs via getState() rather than the render
  // closure: a sync outlives the render that started it (and syncAllVocab
  // chains several), so each pass must start from the reducer's *current*
  // settings. Every write goes through patchNow — functional updates compose
  // onto reducer-current settings, so a file added to any source mid-sync
  // survives the start/completion writes instead of being wiped by a
  // whole-settings snapshot from before the sync began.
  const syncOneVocabSource = useCallback(async (sourceId: string, provider: EmbeddingProvider): Promise<void> => {
    const source = getState().settings.vocabSources.find((v) => v.id === sourceId);
    if (!source || !source.files.length) return;
    const markStatus = async (embedding: VocabEmbeddingStatus) => {
      try {
        await patchNow((s) => updateVocabSource(s, sourceId, (v) => ({ ...v, embedding })));
      } catch (e) {
        // A failed status save must not kill the sync: the Rust-side index
        // update proceeds regardless and the next successful flush persists.
        console.error("[artefact] vocab sync status save failed:", e);
      }
    };
    await markStatus({ ...source.embedding, status: "syncing", providerId: provider.id, model: provider.model });
    dispatch({ type: "SET_VOCAB_SYNC_PROGRESS", id: sourceId, rowsDone: 0, rowsTotal: 0 });
    // An index built with another model is invalid in the new model's vector
    // space — rebuild drops the table so every row re-embeds (run_sync).
    const rebuild = !!source.embedding.model && source.embedding.model !== provider.model;
    try {
      const result = await vocabLib.syncVocabSource(sourceId, provider, source.fields, source.ingestionField, rebuild, (ev) => {
        dispatch({ type: "SET_VOCAB_SYNC_PROGRESS", id: sourceId, rowsDone: ev.rowsDone, rowsTotal: ev.rowsTotal, fileProgress: ev.fileProgress });
      });
      await patchNow((s) =>
        updateVocabSource(s, sourceId, (v) => {
          // Count rows over the source's *current* files: files added mid-sync
          // have no entry in the result and simply weren't part of this pass.
          const files = v.files.map((f) => {
            const rowCountLast = result.fileRowCounts[f.filename];
            const rowCountSyncedLast = result.fileSyncedCounts[f.filename];
            return { ...f, ...(rowCountLast !== undefined && { rowCountLast }), ...(rowCountSyncedLast !== undefined && { rowCountSyncedLast }) };
          });
          const synced = {
            status: "synced" as const, providerId: provider.id, model: provider.model,
            lastSyncedAt: new Date().toISOString(), rowsEmbedded: result.totalRows, lastError: null,
          };
          // If the sync-relevant inputs drifted mid-pass (a file added or
          // removed, the ingestion column or an includeForAI flag flipped),
          // this embed doesn't describe the source as it now stands — land
          // stale so the badge doesn't claim "Up to date" over rows that were
          // never embedded.
          const embedding = syncInputsChanged(source, v) ? { ...synced, status: "stale" as const } : synced;
          return { ...v, files, embedding };
        })
      );
      pushLog({ status: "ok", label: "Vocabulary source synced", detail: `${source.name || "Untitled source"} · ${result.rowsEmbedded} embedded, ${result.rowsReused} reused, ${result.rowsDeleted} removed` });
      // Refresh the cached full term list immediately so the dropdown
      // reflects the newly-synced content rather than waiting for next open.
      try {
        const terms = await vocabLib.listVocabTerms(sourceId);
        dispatch({ type: "SET_VOCAB_TERMS", id: sourceId, terms });
      } catch (e) {
        console.error("[artefact] post-sync listVocabTerms failed:", e);
      }
    } catch (e) {
      const message = String((e as Error)?.message || e);
      await markStatus({ ...source.embedding, status: "error", lastError: message });
      pushLog({ status: "fail", label: "Vocabulary sync failed", detail: source.name || "Untitled source", verbose: { error: message } });
    } finally {
      dispatch({ type: "CLEAR_VOCAB_SYNC_PROGRESS", id: sourceId });
    }
  }, [getState, patchNow, dispatch]);

  const syncVocabSource = useCallback(async (sourceId: string) => {
    const provider = activeEmbeddingProvider(state.settings);
    if (!provider) return;
    await syncOneVocabSource(sourceId, provider);
  }, [state.settings, syncOneVocabSource]);

  const syncAllVocab = useCallback(async () => {
    const provider = activeEmbeddingProvider(state.settings);
    if (!provider) return;
    const ids = state.settings.vocabSources.filter((v) => v.files.length > 0).map((v) => v.id);
    for (const id of ids) {
      await syncOneVocabSource(id, provider);
    }
  }, [state.settings, syncOneVocabSource]);

  const cancelVocabSync = useCallback(async (sourceId: string) => {
    await vocabLib.cancelVocabSync(sourceId);
  }, []);

  const flushVocabSource = useCallback(async (sourceId: string) => {
    const source = state.settings.vocabSources.find((v) => v.id === sourceId);
    if (!source) return;
    const ok = await confirmDelete({
      title: "Flush embeddings?",
      message: `This permanently deletes the embedded vector index for "${source.name || "this source"}". Uploaded files are kept; cataloguing falls back to an unconstrained answer for fields using it until it's re-synced.`,
      confirmLabel: "Flush",
    });
    if (!ok) return;
    await vocabLib.flushVocabSource(sourceId);
    // The dialog/IPC awaits can outlast other writes (e.g. an Add-files
    // landing meanwhile) — reset via reducer-current settings, not a snapshot.
    try {
      await patchNow((s) => updateVocabSource(s, sourceId, (v) => ({ ...v, embedding: emptyEmbedding() })));
    } catch {
      console.error("[artefact] flushVocabSource: save failed");
    }
    dispatch({ type: "CLEAR_VOCAB_TERMS", id: sourceId });
  }, [state.settings, patchNow, dispatch, confirmDelete]);

  const flushAllVocab = useCallback(async () => {
    const ok = await confirmDelete({
      title: "Flush all vocabulary embeddings?",
      message: "This permanently deletes every embedded vector for every vocabulary source. Cataloguing will fall back to full-list vocab prompts (or unconstrained answers) until each source is re-synced — which can take a long time and re-incurs embedding-API cost for large sources. Uploaded files are NOT deleted; only the embedded index.",
      confirmLabel: "Flush All",
    });
    if (!ok) return;
    await vocabLib.flushAllVocab();
    try {
      await patchNow((s) => ({ ...s, vocabSources: s.vocabSources.map((v) => ({ ...v, embedding: emptyEmbedding() })) }));
    } catch {
      console.error("[artefact] flushAllVocab: save failed");
    }
    dispatch({ type: "CLEAR_ALL_VOCAB_TERMS" });
  }, [patchNow, dispatch, confirmDelete]);

  const removeVocabSource = useCallback(async (id: string) => {
    const live = state.vocabDraft ?? vocabDraftFromSettings(state.settings);
    const label = live.vocabSources.find((v) => v.id === id)?.name || "this vocabulary source";
    const ok = await confirmDelete({
      title: "Delete vocabulary source?",
      message: `Delete "${label}"? This immediately removes its files and embedded index.`,
    });
    if (!ok) return;
    try {
      await vocabLib.deleteVocabSourceFiles(id);
    } catch { /* best-effort — settings removal below still proceeds */ }
    // Prune source + dangling field references through reducer-current
    // settings — the confirm await can outlast concurrent writes.
    try {
      await patchNow((s) => withoutVocabSource(s, id));
      // Mirror into drafts so any pending edits stay consistent.
      if (state.vocabDraft) {
        patchVocabDraft((d) => ({ ...d, vocabSources: d.vocabSources.filter((v) => v.id !== id) }));
      }
      dispatch({ type: "PATCH_FIELD_DRAFT", patch: (d) => ({ ...d, fields: d.fields.map((f) => ({ ...f, vocabSources: f.vocabSources.filter((sid) => sid !== id) })) }) });
      dispatch({ type: "CLEAR_VOCAB_TERMS", id });
    } catch {
      console.error("[artefact] removeVocabSource: save failed");
    }
  }, [state.vocabDraft, state.settings, patchNow, patchVocabDraft, dispatch, confirmDelete]);
  const toggleVocab = useCallback((id: string) => dispatch({ type: "TOGGLE_VOCAB", id }), [dispatch]);
  const updateVocabName = useCallback((id: string, name: string) => {
    patchVocabDraft((d) => ({ ...d, vocabSources: d.vocabSources.map((v) => (v.id === id ? { ...v, name } : v)) }));
  }, [patchVocabDraft]);
  const reorderVocab = useCallback(async (ids: string[]) => {
    // Only reorder persisted rows; skip any draft-only ids (new unsaved sources).
    const savedIds = state.settings.vocabSources.map((v) => v.id);
    const reorderedSavedIds = ids.filter((id) => savedIds.includes(id));
    if (reorderedSavedIds.length !== savedIds.length) return;
    try {
      await patchNow((s) => withReorderedVocabSources(s, ids));
      // Mirror reorder into draft using draft values, preserving pending renames.
      patchVocabDraft((d) => {
        const draftById = new Map(d.vocabSources.map((v) => [v.id, v] as const));
        const reorderedDraft = ids.map((id) => draftById.get(id)).filter((v): v is (typeof d.vocabSources)[number] => !!v);
        return reorderedDraft.length === d.vocabSources.length ? { ...d, vocabSources: reorderedDraft } : d;
      });
    } catch { console.error("[artefact] reorderVocab: save failed"); }
  }, [state.settings.vocabSources, patchNow, patchVocabDraft]);

  // --- per-card save/discard (vocab inline editor) ---
  // A single source's rename is committed/reverted in isolation; every other
  // vocab action above already persists immediately (no banner).
  const saveVocabCard = useCallback(async (id: string) => {
    const draft = state.vocabDraft;
    if (!draft) return;
    const card = draft.vocabSources.find((v) => v.id === id);
    if (!card) return;
    dispatch({ type: "SET_VOCAB_CARD_ERROR", id, error: null });
    dispatch({ type: "SET_VOCAB_CARD_STATUS", id, status: "saving" });
    // Upsert: replace if the source already persists, else append (a freshly
    // added source isn't in settings yet — startAddVocabSource seeds it
    // immediately, but this stays defensive for that invariant). Applied via a
    // functional updater so it can't clobber files added mid-await.
    try {
      await patchNow((s) =>
        s.vocabSources.some((v) => v.id === id)
          ? updateVocabSource(s, id, (v) => ({ ...v, name: card.name }))
          : { ...s, vocabSources: [...s.vocabSources, card] }
      );
      dispatch({ type: "PATCH_VOCAB_DRAFT", patch: (d) => ({ ...d, vocabSources: d.vocabSources.map((v) => (v.id === id ? { ...v, name: card.name } : v)) }) });
      dispatch({ type: "SET_VOCAB_CARD_STATUS", id, status: "ok" });
    } catch {
      dispatch({ type: "SET_VOCAB_CARD_STATUS", id, status: "err" });
    }
  }, [state.vocabDraft, patchNow, dispatch]);

  const discardVocabCard = useCallback((id: string) => {
    const draft = state.vocabDraft;
    if (!draft) return;
    const saved = state.settings.vocabSources.find((v) => v.id === id);
    dispatch({ type: "SET_VOCAB_CARD_ERROR", id, error: null });
    dispatch({ type: "SET_VOCAB_CARD_STATUS", id, status: null });
    if (!saved) {
      // A freshly added source has no persisted value — drop it.
      dispatch({ type: "PATCH_VOCAB_DRAFT", patch: (d) => ({ ...d, vocabSources: d.vocabSources.filter((v) => v.id !== id) }) });
      return;
    }
    dispatch({ type: "PATCH_VOCAB_DRAFT", patch: (d) => ({ ...d, vocabSources: d.vocabSources.map((v) => (v.id === id ? { ...v, name: saved.name } : v)) }) });
  }, [state.vocabDraft, state.settings.vocabSources, dispatch]);

  // --- vocab retrieval settings (top-level, persist on change) ---
  const setVocabNetCount = useCallback((n: number) => {
    const clamped = Math.max(1, Math.min(100, Math.round(n) || 1));
    patch((s) => ({ ...s, vocabNetCount: clamped, vocabShortlistCount: Math.min(s.vocabShortlistCount, clamped) }));
  }, [patch]);
  const setVocabShortlistCount = useCallback((n: number) => {
    patch((s) => ({ ...s, vocabShortlistCount: Math.max(1, Math.min(s.vocabNetCount, Math.round(n) || 1)) }));
  }, [patch]);
  const setValidationEnabled = useCallback((on: boolean) => {
    patch((s) => ({ ...s, validationEnabled: on }));
  }, [patch]);

  // --- settings: providers ---
  // Per-card content edits accumulate in `providerDraft` and persist on the
  // card's own Save; structural changes (delete, set-active, reorder) persist
  // immediately. Test Connection runs as transient verification (stored in
  // `provStatus`), not part of the draft.
  const startAddProv = useCallback(() => {
    // Generate the id once so the new card can be auto-expanded (and scrolled
    // into view by ProvidersTab) the moment it's added.
    const id = gid();
    patchProvDraft((d) => ({
      ...d,
      // Append an empty standard entry; the user fills it in, then Test → pick model.
      providers: [...d.providers, { id, name: "", baseUrl: "", apiKey: "", model: "", apiFormat: "openai", modelOptions: [], connStatus: "untested", thinking: null }],
    }));
    dispatch({ type: "TOGGLE_PROV", id });
  }, [patchProvDraft, dispatch]);

  // Editing credentials (baseUrl/apiKey) or API format changes the transport,
  // so any prior successful connection test is no longer valid.
  // Editing name/model is downstream and must NOT clear the test/model list.
  const setProvF = useCallback((id: string, k: keyof Provider, e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    dispatch({ type: "SET_PROV_CARD_STATUS", id, status: null });
    dispatch({ type: "SET_PROV_CARD_ERROR", id, error: null });
    const value = e.target.value;
    patchProvDraft(mapDraftEntry(id, (entry) => ({ ...entry, [k]: value })));
    if (k === "baseUrl" || k === "apiKey") {
      // Revert the model list to the saved provider's (if any) since the endpoint may differ now.
      const saved = state.settings.providers.find((p) => p.id === id);
      // Editing credentials invalidates any prior test: clear the transient
      // status and reset the draft's persisted connStatus (committed on Save).
      patchProvDraft(mapDraftEntry(id, (entry) => ({ ...entry, modelOptions: saved?.modelOptions ? [...saved.modelOptions] : [], connStatus: "untested" })));
      dispatch({ type: "CLEAR_PROV_STATUS", id });
    }
  }, [patchProvDraft, mapDraftEntry, dispatch, state.settings.providers]);

  const setProvApiFormat = useCallback((id: string, format: ApiFormat) => {
    dispatch({ type: "SET_PROV_CARD_STATUS", id, status: null });
    dispatch({ type: "SET_PROV_CARD_ERROR", id, error: null });
    patchProvDraft(mapDraftEntry(id, (entry) => ({ ...entry, apiFormat: format, connStatus: "untested" })));
    dispatch({ type: "CLEAR_PROV_STATUS", id });
  }, [patchProvDraft, mapDraftEntry, dispatch]);

  // Model is downstream of baseUrl/apiKey/apiFormat (it only populates
  // after a successful Test Connection), so selecting it must NOT clear the test
  // status or model list. Takes a string value directly (the shadcn Select
  // exposes onValueChange(value) rather than a change event).
  const setProvModel = useCallback((id: string, model: string) => {
    dispatch({ type: "SET_PROV_CARD_STATUS", id, status: null });
    dispatch({ type: "SET_PROV_CARD_ERROR", id, error: null });
    patchProvDraft(mapDraftEntry(id, (entry) => ({ ...entry, model })));
  }, [patchProvDraft, mapDraftEntry, dispatch]);

  // Thinking effort is a request-body knob, not a transport change, so — like
  // model edits — it must NOT clear the test status or model list. `null` = off
  // (the Segmented control's "Off" pill; no thinking fields are sent).
  const setProvThinking = useCallback((id: string, effort: ThinkingEffort | null) => {
    dispatch({ type: "SET_PROV_CARD_STATUS", id, status: null });
    dispatch({ type: "SET_PROV_CARD_ERROR", id, error: null });
    patchProvDraft(mapDraftEntry(id, (entry) => ({ ...entry, thinking: effort })));
  }, [patchProvDraft, mapDraftEntry, dispatch]);

  const toggleProvKey = useCallback(() => dispatch({ type: "SET_SHOW_PROV_KEY", show: !state.showProvKey }), [state.showProvKey, dispatch]);

  const testConn = useCallback(async (id: string) => {
    // Read the live draft entry (settings fallback so an unedited row is testable).
    const live = state.providerDraft ?? providerDraftFromSettings(state.settings);
    const entry = live.providers.find((e) => e.id === id);
    if (!entry) return;
    const { name, baseUrl, apiKey, model, apiFormat } = entry;
    if (!baseUrl || !apiKey) {
      // Missing credentials is a failure: flag it transiently and persist the
      // outcome onto the draft entry so Save records it (mirrors modelOptions).
      dispatch({ type: "SET_PROV_STATUS", id, test: "err", error: "Needs a base URL and an API key" });
      patchProvDraft(mapDraftEntry(id, (entry2) => ({ ...entry2, connStatus: "err" })));
      return;
    }
    dispatch({ type: "SET_PROV_STATUS", id, test: "testing" });
    try {
      const res = await testConnection({ id: "", name, baseUrl, apiKey, model, apiFormat });
      // Reconcile the model against the freshly-fetched list: keep it only if the
      // endpoint advertises it, else blank it so the user picks from the live
      // dropdown before Save. Store modelOptions AND the test outcome in the
      // draft entry (not separate state) so both survive Save + restart; the
      // dropdown stays populated across edits and the Status column reflects the
      // last verified result.
      const nextModel = res.models.includes(model) ? model : "";
      patchProvDraft(mapDraftEntry(id, (entry2) => ({ ...entry2, model: nextModel, modelOptions: res.models, connStatus: "ok" })));
      dispatch({ type: "SET_PROV_STATUS", id, test: "ok" });
    } catch (e) {
      console.error("[artefact] test connection failed", e);
      patchProvDraft(mapDraftEntry(id, (entry2) => ({ ...entry2, connStatus: "err" })));
      dispatch({ type: "SET_PROV_STATUS", id, test: "err", error: errText(e) });
    }
  }, [state.providerDraft, state.settings, patchProvDraft, mapDraftEntry, dispatch]);

  // --- per-card save/discard (providers) ---
  // One provider's content (name/baseUrl/apiKey/model/format) persists or
  // reverts on its own; delete, set-active, and reorder persist immediately
  // (delete after its confirm).
  const saveProvCard = useCallback(async (id: string) => {
    const draft = state.providerDraft;
    if (!draft) return;
    const entry = draft.providers.find((e) => e.id === id);
    if (!entry) return;
    // Validate just this entry — a missing name/url/key blocks its own Save
    // without affecting other cards. Surface the specific reason via the
    // card's status so the failure isn't a vague "Not saved".
    let validationError: string | null = null;
    if (!entry.name.trim()) validationError = "Needs a name";
    else if (!entry.baseUrl.trim()) validationError = "Needs a base URL";
    else if (!entry.apiKey.trim()) validationError = "Needs an API key";
    if (validationError) {
      dispatch({ type: "SET_PROV_CARD_ERROR", id, error: validationError });
      dispatch({ type: "SET_PROV_CARD_STATUS", id, status: "err" });
      return;
    }
    dispatch({ type: "SET_PROV_CARD_ERROR", id, error: null });
    dispatch({ type: "SET_PROV_CARD_STATUS", id, status: "saving" });
    // Upsert this card's entry, computed from the reducer's LATEST settings
    // (not a render snapshot) and flushed: "Set Active" may land mid-await,
    // and both writes must compose rather than overwrite (mirrors the vocab
    // side's patch+flush pattern).
    const persistedEntry: Provider = {
      id: entry.id, name: entry.name, baseUrl: entry.baseUrl, apiKey: entry.apiKey,
      model: entry.model, apiFormat: entry.apiFormat, modelOptions: entry.modelOptions,
      connStatus: entry.connStatus, thinking: entry.thinking ?? undefined,
    };
    try {
      await patchNow((s) => ({
        ...s,
        providers: s.providers.some((p) => p.id === id)
          ? s.providers.map((p) => (p.id === id ? persistedEntry : p))
          : [...s.providers, persistedEntry],
      }));
      dispatch({ type: "PATCH_PROVIDER_DRAFT", patch: mapDraftEntry(id, (e) => ({ ...e })) });
      dispatch({ type: "SET_PROV_CARD_STATUS", id, status: "ok" });
    } catch (e) {
      // Surface the concrete failure (e.g. disk write) rather than a bare err.
      dispatch({ type: "SET_PROV_CARD_ERROR", id, error: `Could not save: ${(e as Error)?.message || "unknown error"}` });
      dispatch({ type: "SET_PROV_CARD_STATUS", id, status: "err" });
    }
  }, [state.providerDraft, patchNow, mapDraftEntry, dispatch]);

  const discardProvCard = useCallback((id: string) => {
    const draft = state.providerDraft;
    if (!draft) return;
    const saved = state.settings.providers.find((p) => p.id === id);
    dispatch({ type: "SET_PROV_CARD_STATUS", id, status: null });
    dispatch({ type: "SET_PROV_CARD_ERROR", id, error: null });
    // Revert this card's content. For a newly-added provider (no persisted
    // match) "Discard" means clearing its edits back to the empty new-card
    // state — NOT removing it. Removing is what "Delete" is for; conflating the
    // two made Discard indistinguishable from Delete on new providers.
    if (!saved) {
      dispatch({
        type: "PATCH_PROVIDER_DRAFT",
        patch: mapDraftEntry(id, () => ({
          id, name: "", baseUrl: "", apiKey: "", model: "", apiFormat: "openai", modelOptions: [], connStatus: "untested", thinking: null,
        })),
      });
      return;
    }
    // Revert this card's content only. "Set Active" persists immediately, so
    // there's no buffered active-flip to restore here.
    dispatch({
      type: "PATCH_PROVIDER_DRAFT",
      patch: (d) => ({
        ...d,
        providers: d.providers.map((e) => (e.id === id ? {
          id: saved.id, name: saved.name, baseUrl: saved.baseUrl, apiKey: saved.apiKey,
          model: saved.model, apiFormat: saved.apiFormat ?? "openai",
          modelOptions: [...(saved.modelOptions ?? [])],
          connStatus: saved.connStatus ?? "untested",
          thinking: saved.thinking ?? null,
        } : e)),
      }),
    });
  }, [state.providerDraft, state.settings.providers, mapDraftEntry, dispatch]);

  const deleteProv = useCallback(async (id: string) => {
    // Label from the live draft (or settings) so the confirm matches the screen.
    const live = state.providerDraft ?? providerDraftFromSettings(state.settings);
    const label = live.providers.find((e) => e.id === id)?.name || "this provider";
    const ok = await confirmDelete({
      title: "Delete provider?",
      message: `Delete "${label}"? This permanently removes the provider and cannot be undone.`,
    });
    if (!ok) return;
    // Persist the deletion immediately (after the warning confirm), rather than
    // buffering it for a tab-level Apply — the Providers tab has no banner, so
    // deletion is its own commit. If the deleted provider was active, fall back
    // to any remaining provider in the persisted set. Patched onto the reducer's
    // latest settings and flushed so a card Save landing mid-await composes
    // instead of being overwritten.
    try {
      await patchNow((s) => {
        const remaining = s.providers.filter((p) => p.id !== id);
        return { ...s, providers: remaining, activeProvider: s.activeProvider === id ? (remaining[0]?.id ?? null) : s.activeProvider };
      });
      // Mirror the deletion into any pending draft so the UI matches disk state
      // without dropping other buffered per-card edits.
      if (state.providerDraft) {
        patchProvDraft((d) => ({
          ...d,
          providers: d.providers.filter((e) => e.id !== id),
          activeProvider: d.activeProvider === id ? (d.providers.find((e) => e.id !== id)?.id ?? null) : d.activeProvider,
        }));
      }
      dispatch({ type: "CLEAR_PROV_STATUS", id });
    } catch {
      dispatch({ type: "SET_PROV_CARD_STATUS", id, status: "err" });
    }
  }, [state.providerDraft, state.settings, patchNow, patchProvDraft, dispatch, confirmDelete]);

  const setActiveProv = useCallback(async (id: string) => {
    // "Set Active" persists immediately rather than buffering for the row's Save
    // — the active selection is a single-field structural change, not per-card
    // content. patchNow composes onto the reducer's latest settings so a card
    // Save landing mid-await isn't overwritten.
    try {
      await patchNow((s) => ({ ...s, activeProvider: id }));
      if (state.providerDraft) {
        patchProvDraft((d) => ({ ...d, activeProvider: id }));
      }
    } catch {
      // The button stays clickable and the row surfaces the error, matching
      // deleteProv's catch. A failed flush leaves the in-memory patch in place;
      // the next successful persist writes it.
      dispatch({ type: "SET_PROV_CARD_STATUS", id, status: "err" });
    }
  }, [state.providerDraft, patchNow, patchProvDraft, dispatch]);

  const reorderProv = useCallback(async (ids: string[]) => {
    // Only reorder persisted rows; skip any draft-only ids (new unsaved rows).
    // The guard runs inside the functional updater so it judges the reducer's
    // current providers, not this render's snapshot.
    try {
      await patchNow((s) => {
        const savedById = new Map(s.providers.map((p) => [p.id, p] as const));
        const reorderedSavedIds = ids.filter((id) => savedById.has(id));
        if (reorderedSavedIds.length !== s.providers.length) return s;
        return { ...s, providers: reorderedSavedIds.map((id) => savedById.get(id)!) };
      });
      // Mirror reorder into draft using draft values, preserving content edits.
      patchProvDraft((d) => {
        const draftById = new Map(d.providers.map((p) => [p.id, p] as const));
        const reorderedDraft = ids.map((id) => draftById.get(id)).filter((p): p is (typeof d.providers)[number] => !!p);
        return reorderedDraft.length === d.providers.length ? { ...d, providers: reorderedDraft } : d;
      });
    } catch { console.error("[artefact] reorderProv: save failed"); }
  }, [patchNow, patchProvDraft]);

  // --- settings: embedding providers ---
  // Same per-card draft/save/discard shape as chat providers above, just a
  // separate list — see EmbeddingProvidersSection.tsx.
  const toggleEmbProv = useCallback((id: string) => dispatch({ type: "TOGGLE_EMB_PROV", id }), [dispatch]);

  const startAddEmbProv = useCallback(() => {
    const id = gid();
    patchEmbProvDraft((d) => ({
      ...d,
      providers: [...d.providers, { id, name: "", baseUrl: "", apiKey: "", model: "", apiFormat: "openai", modelOptions: [], imageInputModels: null, connStatus: "untested" }],
    }));
    dispatch({ type: "TOGGLE_EMB_PROV", id });
  }, [patchEmbProvDraft, dispatch]);

  const setEmbProvF = useCallback((id: string, k: keyof EmbeddingProvider, e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    dispatch({ type: "SET_EMB_PROV_CARD_STATUS", id, status: null });
    dispatch({ type: "SET_EMB_PROV_CARD_ERROR", id, error: null });
    const value = e.target.value;
    patchEmbProvDraft(mapEmbDraftEntry(id, (entry) => ({ ...entry, [k]: value })));
    if (k === "baseUrl" || k === "apiKey") {
      // Editing credentials invalidates any prior test, same as chat providers.
      const saved = state.settings.embeddingProviders.find((p) => p.id === id);
      patchEmbProvDraft(mapEmbDraftEntry(id, (entry) => ({
        ...entry,
        modelOptions: saved?.modelOptions ? [...saved.modelOptions] : [],
        imageInputModels: saved?.imageInputModels ? [...saved.imageInputModels] : null,
        connStatus: "untested",
      })));
      dispatch({ type: "CLEAR_EMB_PROV_STATUS", id });
    }
  }, [patchEmbProvDraft, mapEmbDraftEntry, dispatch, state.settings.embeddingProviders]);

  const setEmbProvApiFormat = useCallback((id: string, format: EmbeddingApiFormat) => {
    dispatch({ type: "SET_EMB_PROV_CARD_STATUS", id, status: null });
    dispatch({ type: "SET_EMB_PROV_CARD_ERROR", id, error: null });
    patchEmbProvDraft(mapEmbDraftEntry(id, (entry) => ({ ...entry, apiFormat: format, connStatus: "untested" })));
    dispatch({ type: "CLEAR_EMB_PROV_STATUS", id });
  }, [patchEmbProvDraft, mapEmbDraftEntry, dispatch]);

  const setEmbProvModel = useCallback((id: string, model: string) => {
    dispatch({ type: "SET_EMB_PROV_CARD_STATUS", id, status: null });
    dispatch({ type: "SET_EMB_PROV_CARD_ERROR", id, error: null });
    patchEmbProvDraft(mapEmbDraftEntry(id, (entry) => ({ ...entry, model })));
  }, [patchEmbProvDraft, mapEmbDraftEntry, dispatch]);


  const toggleEmbProvKey = useCallback(() => dispatch({ type: "SET_SHOW_EMB_PROV_KEY", show: !state.showEmbProvKey }), [state.showEmbProvKey, dispatch]);

  const testEmbConn = useCallback(async (id: string) => {
    const live = state.embProviderDraft ?? embeddingProviderDraftFromSettings(state.settings);
    const entry = live.providers.find((e) => e.id === id);
    if (!entry) return;
    const { name, baseUrl, apiKey, model, apiFormat } = entry;
    if (!baseUrl || !apiKey) {
      dispatch({ type: "SET_EMB_PROV_STATUS", id, test: "err", error: "Needs a base URL and an API key" });
      patchEmbProvDraft(mapEmbDraftEntry(id, (entry2) => ({ ...entry2, connStatus: "err" })));
      return;
    }
    dispatch({ type: "SET_EMB_PROV_STATUS", id, test: "testing" });
    try {
      const res = await testEmbeddingConnection({ id: "", name, baseUrl, apiKey, model, apiFormat });
      const nextModel = res.models.includes(model) ? model : "";
      patchEmbProvDraft(mapEmbDraftEntry(id, (entry2) => ({
        ...entry2,
        model: nextModel,
        modelOptions: res.models,
        imageInputModels: res.image_input ?? null,
        connStatus: "ok",
      })));
      dispatch({ type: "SET_EMB_PROV_STATUS", id, test: "ok" });
    } catch (e) {
      console.error("[artefact] test embedding connection failed", e);
      patchEmbProvDraft(mapEmbDraftEntry(id, (entry2) => ({ ...entry2, connStatus: "err" })));
      dispatch({ type: "SET_EMB_PROV_STATUS", id, test: "err", error: errText(e) });
    }
  }, [state.embProviderDraft, state.settings, patchEmbProvDraft, mapEmbDraftEntry, dispatch]);

  const saveEmbProvCard = useCallback(async (id: string) => {
    const draft = state.embProviderDraft;
    if (!draft) return;
    const entry = draft.providers.find((e) => e.id === id);
    if (!entry) return;
    let validationError: string | null = null;
    if (!entry.name.trim()) validationError = "Needs a name";
    else if (!entry.baseUrl.trim()) validationError = "Needs a base URL";
    else if (!entry.apiKey.trim()) validationError = "Needs an API key";
    if (validationError) {
      dispatch({ type: "SET_EMB_PROV_CARD_ERROR", id, error: validationError });
      dispatch({ type: "SET_EMB_PROV_CARD_STATUS", id, status: "err" });
      return;
    }
    dispatch({ type: "SET_EMB_PROV_CARD_ERROR", id, error: null });
    dispatch({ type: "SET_EMB_PROV_CARD_STATUS", id, status: "saving" });
    // Upsert this card's entry, computed from the reducer's LATEST settings and
    // flushed — "Set Active" may land mid-await, and both writes must compose
    // rather than overwrite (mirrors saveProvCard / the vocab side).
    const persistedEntry: EmbeddingProvider = {
      id: entry.id, name: entry.name, baseUrl: entry.baseUrl, apiKey: entry.apiKey,
      model: entry.model, apiFormat: entry.apiFormat,
      modelOptions: entry.modelOptions, imageInputModels: entry.imageInputModels ?? undefined,
      connStatus: entry.connStatus,
    };
    try {
      await patchNow((s) => ({
        ...s,
        embeddingProviders: s.embeddingProviders.some((p) => p.id === id)
          ? s.embeddingProviders.map((p) => (p.id === id ? persistedEntry : p))
          : [...s.embeddingProviders, persistedEntry],
      }));
      dispatch({ type: "PATCH_EMB_PROVIDER_DRAFT", patch: mapEmbDraftEntry(id, (e) => ({ ...e })) });
      dispatch({ type: "SET_EMB_PROV_CARD_STATUS", id, status: "ok" });
    } catch (e) {
      dispatch({ type: "SET_EMB_PROV_CARD_ERROR", id, error: `Could not save: ${(e as Error)?.message || "unknown error"}` });
      dispatch({ type: "SET_EMB_PROV_CARD_STATUS", id, status: "err" });
    }
  }, [state.embProviderDraft, patchNow, mapEmbDraftEntry, dispatch]);

  const discardEmbProvCard = useCallback((id: string) => {
    const draft = state.embProviderDraft;
    if (!draft) return;
    const saved = state.settings.embeddingProviders.find((p) => p.id === id);
    dispatch({ type: "SET_EMB_PROV_CARD_STATUS", id, status: null });
    dispatch({ type: "SET_EMB_PROV_CARD_ERROR", id, error: null });
    if (!saved) {
      dispatch({
        type: "PATCH_EMB_PROVIDER_DRAFT",
        patch: mapEmbDraftEntry(id, () => ({
          id, name: "", baseUrl: "", apiKey: "", model: "", apiFormat: "openai", modelOptions: [], imageInputModels: null, connStatus: "untested",
        })),
      });
      return;
    }
    dispatch({
      type: "PATCH_EMB_PROVIDER_DRAFT",
      patch: (d) => ({
        ...d,
        providers: d.providers.map((e) => (e.id === id ? {
          id: saved.id, name: saved.name, baseUrl: saved.baseUrl, apiKey: saved.apiKey,
          model: saved.model, apiFormat: saved.apiFormat ?? "openai",
          modelOptions: [...(saved.modelOptions ?? [])],
          imageInputModels: saved.imageInputModels ? [...saved.imageInputModels] : null,
          connStatus: saved.connStatus ?? "untested",
        } : e)),
      }),
    });
  }, [state.embProviderDraft, state.settings.embeddingProviders, mapEmbDraftEntry, dispatch]);

  const deleteEmbProv = useCallback(async (id: string) => {
    const live = state.embProviderDraft ?? embeddingProviderDraftFromSettings(state.settings);
    const label = live.providers.find((e) => e.id === id)?.name || "this embedding provider";
    const ok = await confirmDelete({
      title: "Delete embedding provider?",
      message: `Delete "${label}"? This permanently removes the provider and cannot be undone. Vocabulary sources synced with it will need a different embedding provider before their next sync.`,
    });
    if (!ok) return;
    // Persist the deletion immediately, patched onto the reducer's latest
    // settings and flushed so a card Save landing mid-await composes instead of
    // being overwritten (mirrors deleteProv).
    try {
      await patchNow((s) => {
        const remaining = s.embeddingProviders.filter((p) => p.id !== id);
        return {
          ...s,
          embeddingProviders: remaining,
          activeEmbeddingProvider: s.activeEmbeddingProvider === id ? (remaining[0]?.id ?? null) : s.activeEmbeddingProvider,
        };
      });
      if (state.embProviderDraft) {
        patchEmbProvDraft((d) => ({
          ...d,
          providers: d.providers.filter((e) => e.id !== id),
          activeProvider: d.activeProvider === id ? (d.providers.find((e) => e.id !== id)?.id ?? null) : d.activeProvider,
        }));
      }
      dispatch({ type: "CLEAR_EMB_PROV_STATUS", id });
    } catch {
      dispatch({ type: "SET_EMB_PROV_CARD_STATUS", id, status: "err" });
    }
  }, [state.embProviderDraft, state.settings, patchNow, patchEmbProvDraft, dispatch, confirmDelete]);

  const setActiveEmbProv = useCallback(async (id: string) => {
    // "Set Active" persists immediately — patched onto the reducer's latest
    // settings and flushed so a card Save landing mid-await composes instead of
    // being overwritten (mirrors setActiveProv).
    try {
      await patchNow((s) => ({ ...s, activeEmbeddingProvider: id }));
      if (state.embProviderDraft) {
        patchEmbProvDraft((d) => ({ ...d, activeProvider: id }));
      }
    } catch {
      dispatch({ type: "SET_EMB_PROV_CARD_STATUS", id, status: "err" });
    }
  }, [state.embProviderDraft, patchNow, patchEmbProvDraft, dispatch]);

  const reorderEmbProv = useCallback(async (ids: string[]) => {
    // Only reorder persisted rows; skip any draft-only ids (new unsaved rows).
    // The guard runs inside the functional updater so it judges the reducer's
    // current embedding providers, not this render's snapshot.
    try {
      await patchNow((s) => {
        const savedById = new Map(s.embeddingProviders.map((p) => [p.id, p] as const));
        const reorderedSavedIds = ids.filter((id) => savedById.has(id));
        if (reorderedSavedIds.length !== s.embeddingProviders.length) return s;
        return { ...s, embeddingProviders: reorderedSavedIds.map((id) => savedById.get(id)!) };
      });
      // Mirror reorder into draft using draft values, preserving content edits.
      patchEmbProvDraft((d) => {
        const draftById = new Map(d.providers.map((p) => [p.id, p] as const));
        const reorderedDraft = ids.map((id) => draftById.get(id)).filter((p): p is (typeof d.providers)[number] => !!p);
        return reorderedDraft.length === d.providers.length ? { ...d, providers: reorderedDraft } : d;
      });
    } catch { console.error("[artefact] reorderEmbProv: save failed"); }
  }, [patchNow, patchEmbProvDraft]);

  // --- settings: artefact fields ---
  // The required-column config is one deferred draft (mirrors the catalogue-
  // fields draft): edits, adds, and deletes accumulate here and persist only on
  // the tab-level Save. Rows expand on click via toggleAF.
  const toggleAF = useCallback((id: string) => dispatch({ type: "TOGGLE_AF", id }), [dispatch]);
  const reorderAF = useCallback(async (ids: string[]) => {
    // Only reorder persisted rows; skip any draft-only ids (new unsaved columns).
    // The guard runs inside the functional updater so it judges the reducer's
    // current columns, not this render's snapshot.
    try {
      await patchNow((s) => {
        const savedById = new Map((s.artefactFields || _DEF_AF).map((f) => [f.id, f] as const));
        const reorderedSavedIds = ids.filter((id) => savedById.has(id));
        const savedFields = s.artefactFields || _DEF_AF;
        if (reorderedSavedIds.length !== savedFields.length) return s;
        return { ...s, artefactFields: reorderedSavedIds.map((id) => savedById.get(id)!) };
      });
      // Mirror reorder into draft using draft values, preserving content edits.
      patchArtefactDraft((d) => {
        const draftById = new Map(d.artefactFields.map((f) => [f.id, f] as const));
        const reorderedDraft = ids.map((id) => draftById.get(id)).filter((f): f is ArtefactField => !!f);
        return reorderedDraft.length === d.artefactFields.length ? { ...d, artefactFields: reorderedDraft } : d;
      });
    } catch { console.error("[artefact] reorderAF: save failed"); }
  }, [patchNow, patchArtefactDraft]);
  const updateAF = useCallback((id: string, key: EditableArtefactFieldKey, value: string) => {
    // The Include-for-AI / Include-in-Export / use-column-letter booleans are
    // persisted on ArtefactField, but the Segmented toggles emit the string
    // "true"/"false" — coerce here so the draft carries the typed value. The
    // column letter is normalized to the canonical uppercase form;
    // name/description/prompt stay string passthroughs.
    const coerced =
      key === "includeForAI" || key === "includeInExport" || key === "useColumnLetter" ? value === "true"
      : key === "column" ? value.trim().toUpperCase()
      : value;
    patchArtefactDraft((d) => ({ ...d, artefactFields: d.artefactFields.map((f) => (f.id === id ? { ...f, [key]: coerced } : f)) }));
  }, [patchArtefactDraft]);
  const removeAF = useCallback(async (id: string) => {
    const live = state.artefactDraft ?? artefactDraftFromSettings(state.settings);
    const label = live.artefactFields.find((f) => f.id === id)?.name || "this column";
    const ok = await confirmDelete({
      title: "Delete column?",
      message: `Delete "${label}"? This immediately removes the column.`,
    });
    if (!ok) return;
    try {
      // The dialog await can outlast other writes — prune via reducer-current
      // settings, not a snapshot (mirrors removeField).
      await patchNow((s) => ({ ...s, artefactFields: (s.artefactFields || _DEF_AF).filter((f) => f.id !== id) }));
      if (state.artefactDraft) {
        patchArtefactDraft((d) => ({ ...d, artefactFields: d.artefactFields.filter((f) => f.id !== id) }));
      }
    } catch { console.error("[artefact] removeAF: save failed"); }
  }, [state.artefactDraft, state.settings, patchNow, patchArtefactDraft, confirmDelete]);
  const startAddAF = useCallback(() => {
    const id = gid();
    patchArtefactDraft((d) => ({ ...d, artefactFields: [...d.artefactFields, { id, name: "", description: "", prompt: "", includeForAI: true, includeInExport: true, useColumnLetter: false, column: "" }] }));
    dispatch({ type: "TOGGLE_AF", id });
  }, [patchArtefactDraft, dispatch]);

  // --- per-card save/discard (artefact columns) ---
  // One column's content (name/description/prompt) persists or reverts on its
  // own; adds/deletes/reorders stay buffered for the tab-level Apply.
  const saveArtefactCard = useCallback(async (id: string) => {
    const draft = state.artefactDraft;
    if (!draft) return;
    const card = draft.artefactFields.find((f) => f.id === id);
    if (!card) return;
    dispatch({ type: "SET_ARTEFACT_CARD_STATUS", id, status: "saving" });
    try {
      // Upsert: replace if the column still persists, else append (a newly
      // added column isn't in settings yet). Coalesce optional keys to "" so a
      // missing key never survives into persisted settings. Judged against
      // reducer-current columns so the Save composes with any write that
      // landed while the card was being edited.
      const normalize = (f: ArtefactField) => ({ ...f, description: f.description ?? "", prompt: f.prompt ?? "", useColumnLetter: f.useColumnLetter ?? false, column: f.column ?? "" });
      await patchNow((s) => {
        const base = s.artefactFields || _DEF_AF;
        const artefactFields = base.some((f) => f.id === id)
          ? base.map((f) => (f.id === id ? normalize({ ...card }) : f))
          : [...base, normalize({ ...card })];
        return { ...s, artefactFields };
      });
      dispatch({ type: "PATCH_ARTEFACT_DRAFT", patch: (d) => ({ ...d, artefactFields: d.artefactFields.map((f) => (f.id === id ? { ...card } : f)) }) });
      dispatch({ type: "SET_ARTEFACT_CARD_STATUS", id, status: "ok" });
    } catch {
      dispatch({ type: "SET_ARTEFACT_CARD_STATUS", id, status: "err" });
    }
  }, [state.artefactDraft, patchNow, dispatch]);

  const discardArtefactCard = useCallback((id: string) => {
    const draft = state.artefactDraft;
    if (!draft) return;
    const saved = (state.settings.artefactFields || _DEF_AF).find((f) => f.id === id);
    dispatch({ type: "SET_ARTEFACT_CARD_STATUS", id, status: null });
    if (!saved) {
      // Newly-added column has no persisted value — drop it.
      dispatch({ type: "PATCH_ARTEFACT_DRAFT", patch: (d) => ({ ...d, artefactFields: d.artefactFields.filter((f) => f.id !== id) }) });
      return;
    }
    dispatch({ type: "PATCH_ARTEFACT_DRAFT", patch: (d) => ({ ...d, artefactFields: d.artefactFields.map((f) => (f.id === id ? { ...saved, description: saved.description ?? "", prompt: saved.prompt ?? "" } : f)) }) });
  }, [state.artefactDraft, state.settings.artefactFields, dispatch]);

  // --- artefact-analysis system instruction (artefact tab, artefact-analysis
  // stage of the threaded pipeline). Deferred draft + per-card save,
  // mirroring the catalogue tab's System Instructions trio.
  const updateArtefactAnalysisSystemPromptInstruction = useCallback((value: string) => {
    patchArtefactDraft((d) => ({ ...d, artefactAnalysisSystemPromptInstruction: value }));
  }, [patchArtefactDraft]);
  const saveArtefactAnalysisSystemPromptInstruction = useCallback(async () => {
    const draft = state.artefactDraft;
    if (!draft) return;
    dispatch({ type: "SET_ARTEFACT_CARD_STATUS", id: "artefact-analysis-instruction", status: "saving" });
    try {
      await patchNow((s) => ({ ...s, artefactAnalysisSystemPromptInstruction: draft.artefactAnalysisSystemPromptInstruction }));
      dispatch({ type: "SET_ARTEFACT_CARD_STATUS", id: "artefact-analysis-instruction", status: "ok" });
    } catch {
      dispatch({ type: "SET_ARTEFACT_CARD_STATUS", id: "artefact-analysis-instruction", status: "err" });
    }
  }, [state.artefactDraft, patchNow, dispatch]);
  const discardArtefactAnalysisSystemPromptInstruction = useCallback(() => {
    const draft = state.artefactDraft;
    if (!draft) return;
    dispatch({ type: "SET_ARTEFACT_CARD_STATUS", id: "artefact-analysis-instruction", status: null });
    dispatch({ type: "PATCH_ARTEFACT_DRAFT", patch: (d) => ({ ...d, artefactAnalysisSystemPromptInstruction: state.settings.artefactAnalysisSystemPromptInstruction ?? "" }) });
  }, [state.artefactDraft, state.settings.artefactAnalysisSystemPromptInstruction, dispatch]);

  // Override gating for the unified System Prompt. Disabled by default (the
  // prompt's preamble tells the model how to format responses); editing is
  // unlocked by a warning-confirmed Override, and Reset restores the default.
  const setPromptEditing = useCallback((editing: boolean) => dispatch({ type: "SET_CONTRACT_EDITING", editing }), [dispatch]);
  const overridePrompt = useCallback(async () => {
    const ok = await confirmDelete({
      title: "Override system prompt?",
      message: "This prompt tells the AI how to format its answer so the app can read it. Editing it can stop responses from being parsed. Only continue if you know what you're doing.",
      confirmLabel: "Override",
    });
    if (!ok) return;
    // Seed the draft with the default so editing starts from known-good text.
    const current = state.artefactDraft?.artefactAnalysisSystemPromptInstruction ?? state.settings.artefactAnalysisSystemPromptInstruction ?? "";
    if (!current) updateArtefactAnalysisSystemPromptInstruction(_DEF_ARTEFACT_ANALYSIS_SYSTEM_PROMPT_INSTRUCTION);
    setPromptEditing(true);
  }, [confirmDelete, state.artefactDraft, state.settings.artefactAnalysisSystemPromptInstruction, updateArtefactAnalysisSystemPromptInstruction, setPromptEditing]);

  // --- settings import/export ---
  const exportSettings = useCallback(async () => {
    const json = JSON.stringify(state.settings, null, 2);
    try {
      const target = await save({ defaultPath: "ac-settings.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (target) await writeTextFile(target, json);
    } catch {
      const a = document.createElement("a");
      a.href = "data:application/json;charset=utf-8," + encodeURIComponent(json);
      a.download = "ac-settings.json";
      a.click();
    }
  }, [state.settings]);

  const importSettings = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    // Reset the input so selecting the same file again re-fires onChange.
    e.target.value = "";
    let text: string;
    try {
      text = await f.text();
    } catch {
      alert("Could not read the selected file.");
      return;
    }
    // Validate the untrusted import payload before trusting it as Settings.
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      alert(`Invalid settings file: not valid JSON.\n${(err as Error).message}`);
      return;
    }
    // Migrate a pre-VocabSource export (old `vocabularyLists` key) and the
    // pre-rename `visionSystemPromptInstruction` prompt key, then validate
    // with the same tolerant schema loadState uses — an imported
    // file can be just as old/partial as a persisted one, and
    // withDefaultSettings fills any gaps (e.g. a pre-embeddings export
    // missing `embeddingProviders`/`activeEmbeddingProvider` entirely).
    const migrated = migrateLegacyVisionPromptKey(stripBuiltinLegacyVocabFields(migrateLegacyVocabularyLists(raw)));
    const parsed = PersistedSettingsSchema.safeParse(migrated);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first.path.length ? ` at ${first.path.join(".")}` : "";
      alert(`Invalid settings file${path}: ${first.message}`);
      return;
    }
    const imp = parsed.data as Settings;
    patch(() => withDefaultSettings(imp));
  }, [patch]);

  return {
    setAllExpanded,
    toggleDark, goMain, goSettings, setTab, zoomIn, zoomOut, toggleLogs, setLogsOpen,
    onUploadClick, onDragOver, onDragLeave, onDrop, removeFile, dismissParseError, startQueue, stopQueue, retryFailed, requeueRow, stopRow, deleteRow, deleteFileRows, onResizeStart,
    toggleRow, setFilter, setSearch, toggleSearchColAf, toggleSearchColCat, setSearchColsAf, setSearchColsCat, dismissExportWarning, exportResults, onTriggerClick, setFieldSearch, toggleFieldValue, clearField, setOpenFieldValue,
    toggleSF, reorderFields, removeField, updateField, addVocabSrc, removeVocabSrc, saveFieldCard, discardFieldCard, startAddField, toggleProv,
    startAddVocabSource, addFilesToSource, removeFileFromSource, downloadVocabFile, toggleSourceFieldAI, setVocabIngestionField, setVocabLabelField, setVocabBadgeField, syncVocabSource, syncAllVocab, cancelVocabSync, flushVocabSource, flushAllVocab, removeVocabSource, toggleVocab, updateVocabName, reorderVocab, saveVocabCard, discardVocabCard, ensureVocabTermsLoaded, setVocabNetCount, setVocabShortlistCount, setValidationEnabled,
    startAddProv, setProvF, setProvModel, setProvApiFormat, setProvThinking, toggleProvKey, testConn, reorderProv, deleteProv, setActiveProv, saveProvCard, discardProvCard,
    toggleEmbProv, startAddEmbProv, setEmbProvF, setEmbProvModel, setEmbProvApiFormat, toggleEmbProvKey, testEmbConn, reorderEmbProv, deleteEmbProv, setActiveEmbProv, saveEmbProvCard, discardEmbProvCard,
    toggleAF, reorderAF, updateAF, removeAF, startAddAF, saveArtefactCard, discardArtefactCard, updateArtefactAnalysisSystemPromptInstruction, saveArtefactAnalysisSystemPromptInstruction, discardArtefactAnalysisSystemPromptInstruction, setPromptEditing, overridePrompt,
    exportSettings, importSettings,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Shared pre-flight for every AI run (Parse, per-row retry, retry-all): the
// config problems that would otherwise silently produce wrong results mid-run.
// Returns the banner message to show, or null when the run may proceed.
export function parsePreFlightError(settings: Settings): string | null {
  if (!activeProvider(settings)) {
    return "An active AI provider is required — add one in Settings → Model Providers.";
  }
  // A vocab field whose source isn't ready resolves to neither the full list
  // nor a shortlist — it would silently prompt as unconstrained free text
  // (see findUnsyncedVocabField). Fail the whole run up front rather than
  // producing quietly-wrong results.
  const unsynced = findUnsyncedVocabField(settings);
  if (unsynced) {
    if (unsynced.reason === "model-changed") {
      return `Vocabulary source "${unsynced.sourceName}" (used by "${unsynced.fieldName}") was embedded with ${unsynced.embeddedModel ?? "an unknown model"}, but the active embedding model is ${unsynced.activeModel ?? "none"} — re-sync it in Settings → Vocabulary Lists (or switch the embedding model back) before parsing.`;
    }
    return `Vocabulary source "${unsynced.sourceName}" (used by "${unsynced.fieldName}") is not yet embedded — sync it in Settings → Vocabulary Lists before parsing, or remove it from this field.`;
  }
  // Vocab fields are resolved purely by embedding search (no LLM), so they
  // need an active embedding provider — without one they'd silently come
  // back empty. Fail loudly with a pointer to Settings → Model Providers.
  const noEmbed = findVocabFieldWithoutEmbedding(settings);
  if (noEmbed) {
    return `Controlled-vocabulary fields (e.g. "${noEmbed.fieldName}") are resolved by embedding search and need an active embedding provider — add one in Settings → Model Providers before parsing.`;
  }
  return null;
}
