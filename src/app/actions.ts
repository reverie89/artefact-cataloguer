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
import { _DEF_AF, _DEF_VISION_SYSTEM_PROMPT_INSTRUCTION, fmt, gid } from "./defaults";
import type { ApiFormat, AiResults, ArtefactField, ArtefactRow, CatalogueField, EmbeddingApiFormat, EmbeddingProvider, FieldSelection, FieldType, Provider, Settings, SettingsTab } from "./types";
import { isTabDirty } from "./drafts";
import { parseArtefactFile } from "../lib/spreadsheet";
import { extractImagesFromXlsx } from "../lib/images";
import { catalogueArtefact, cancelCatalogue, CANCEL_ERROR, testConnection, testEmbeddingConnection, activeProvider, activeEmbeddingProvider, findUnsyncedVocabField, findVocabFieldWithoutEmbedding } from "../lib/ai";
import * as vocabLib from "../lib/vocab";
import { pushLog } from "../lib/logs";
import { saveState, withDefaultSettings, migrateLegacyVocabularyLists, stripBuiltinLegacyVocabFields } from "../lib/store";
import { PersistedSettingsSchema } from "./schema";
import type { ConfirmDeleteOptions } from "../components/common/ConfirmDialog";

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
  addAnotherFile(e: React.MouseEvent): void;
  onDragOver(e: React.DragEvent): void;
  onDragLeave(): void;
  onDrop(e: React.DragEvent): void;
  removeFile(id: string): void;
  startParse(): void;
  /** Pause scheduling of further rows. The in-flight AI call (if any) finishes;
   *  no new rows start while paused. No-op unless a run is active. */
  pauseParse(): void;
  /** Resume scheduling from where a pause halted it. No-op unless paused. */
  resumeParse(): void;
  /** Stop the whole run: the in-flight row finishes, then every not-yet-started
   *  row is marked `cancelled` and the loop exits. Terminal — re-running needs
   *  Reset + Parse. Gives instant button feedback via parseStatus. */
  cancelParse(): void;
  dismissParseError(): void;
  /** Clear the whole upload + parse + results flow back to a fresh state:
   *  uploaded files, parsed rows, AI suggestions, per-field selections and the
   *  in-memory parsed cache (window.__acParsed) are all dropped. Prompts to
   *  confirm first, mirroring removeField/deleteProv. */
  resetUpload(): Promise<void>;
  /** Re-run the AI cataloguing call for a single failed row. No re-extraction:
   *  the row already carries its `record` + `imagePath`. Failures stay scoped
   *  to the row (no global banner) except a missing active provider. */
  retryRow(uid: string): Promise<void>;
  /** Stop an in-flight `processing` row by cancelling its AI call at the
   *  transport level (the Rust side drops the reqwest future, closing the
   *  socket). The row's awaiting `catalogueArtefact` rejects with the cancel
   *  sentinel, which the caller turns into a `cancelled` status; the rest of
   *  the run continues. No-op for a row that isn't processing. */
  stopRow(uid: string): Promise<void>;
  /** Sequentially retryRow() every errored row. Useful after a fail-fast Parse
   *  marked several never-attempted rows as error. */
  retryAllFailed(): Promise<void>;
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
  /** Toggle a vocab term in/out of a field's selection set (multi-select). */
  toggleFieldValue(key: string, value: string, source: "ai" | "vocab" | "manual", listName: string, similarity: number | null): void;
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
  updateField(id: string, key: EditableCatalogueFieldKey, value: string | FieldType): void;
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

  // settings: providers — edits accumulate in a unified draft and persist only
  // on the tab-level Save (see saveProviders). Test Connection is the one
  // exception: it runs immediately as transient verification.
  startAddProv(): void;
  setProvF(id: string, k: keyof Provider, e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>): void;
  setProvModel(id: string, model: string): void;
  setProvApiFormat(id: string, format: ApiFormat): void;
  toggleProvKey(): void;
  testConn(id: string): Promise<void>;
  saveProviders(): Promise<void>;
  discardProviders(): void;
  deleteProv(id: string): Promise<void>;
  setActiveProv(id: string): Promise<void>;
  /** Persist only this provider card's content edits to disk (independent of
   *  any pending structural changes buffered for the tab-level Apply). */
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
  /** Update the unified system prompt (vision-analysis persona +
   *  output-format preamble) in the draft. */
  updateVisionSystemPromptInstruction(value: string): void;
  /** Persist the unified system prompt to disk. */
  saveVisionSystemPromptInstruction(): Promise<void>;
  /** Revert the unified system prompt to its persisted value. */
  discardVisionSystemPromptInstruction(): void;
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
type Persist = () => void;
type ConfirmDelete = (opts: ConfirmDeleteOptions) => Promise<boolean>;
type ParsedStore = Record<string, { rows: ArtefactRow[]; imageRowIndices: number[]; sheetRowToDataRow: number[]; discardedColumns: Record<string, string>; file: File }>;
type AppWindow = Window & { __acFi?: HTMLInputElement; __acParsed?: ParsedStore };

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

/** Convert a 0-based column index to an Excel column letter (0 → A, 26 → AA).
 *  Used to build the range string for image anchoring in xlsx export. */
function colIndexToLetter(index: number): string {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** The image role column name regex — kept here (and re-checked against export
 *  settings) so export doesn't have to import from spreadsheet.ts's
 *  parse-only `roleFieldNames`. Mirrors the parser's image-column match. */
const IMAGE_COL_RE = /^images?$/;

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
  const imageCol = exportAf.find((f) => IMAGE_COL_RE.test(f.name.trim().toLowerCase()));
  const rows = results
    .filter((r) => r.status === "done")
    .map((r) => {
      const ai = aiResults[r.uid] || {};
      const record = r.record ?? {};
      const afVals = exportAf.map((f) => {
        // Case-insensitive lookup against the sheet's actual header casing,
        // mirroring parseArtefactFile's reader — record keys come from the
        // sheet's headers, af.name is the configured casing.
        const k = Object.keys(record).find((kk) => kk.toLowerCase() === f.name.toLowerCase());
        return k ? record[k] : "";
      });
      const fieldVals = settings.fields.map((f) => {
        const sel = fieldSelections[`${r.uid}_${f.id}`];
        return sel ? sel.value : ai[f.name]?.[0]?.value || "";
      });
      return [...afVals, ...fieldVals];
    });
  return { headers, rows, imageColName: imageCol ? imageCol.name : null };
}

export function useActions(state: AppState, dispatch: Dispatch, persist: Persist, confirmDelete: ConfirmDelete): AppActions {
  // Coarse control flags polled by the startParse loop. One shared ref is safe
  // because only one loop can ever be alive: startParse early-returns unless
  // parseStatus === "idle", and the loop drives parseStatus to a terminal state
  // before exiting. A fresh ref is created at the start of each run (startParse
  // resets both flags), so a previous run's cancel/pause can't bleed into the
  // next one.
  const parseControl = useRef({ paused: false, cancelled: false });

  // Helper: dispatch a settings patch then persist.
  const patch = useCallback(
    (fn: (s: Settings) => Settings) => {
      dispatch({ type: "PATCH_SETTINGS", patch: fn });
      persist();
    },
    [dispatch, persist]
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
    persist();
  }, [state.darkMode, dispatch, persist]);

  /** Discard the whole-tab draft for the given settings tab (mirrors each tab's
   *  "Discard all"). Used by the navigation guard so "discard changes" actually
   *  clears what the user is being warned about. */
  const discardTabDraft = useCallback((tab: SettingsTab) => {
    switch (tab) {
      case "fields": dispatch({ type: "CLEAR_FIELD_DRAFT" }); break;
      case "vocab": dispatch({ type: "CLEAR_VOCAB_DRAFT" }); break;
      case "modelProviders":
        dispatch({ type: "CLEAR_PROVIDER_DRAFT" }); dispatch({ type: "SET_PROV_SAVE_STATUS", status: null });
        dispatch({ type: "CLEAR_EMB_PROVIDER_DRAFT" }); dispatch({ type: "SET_EMB_PROV_SAVE_STATUS", status: null });
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
    persist();
  }, [state.zoom, dispatch, persist]);
  const zoomOut = useCallback(() => {
    const z = Math.max(0.7, +(state.zoom - 0.05).toFixed(2));
    dispatch({ type: "SET_ZOOM", zoom: z });
    persist();
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

  // --- files ---
  const addFiles = useCallback(
    async (list: FileList | File[]) => {
      const ok = Array.from(list).filter((f) => /\.xlsx$/i.test(f.name));
      if (!ok.length) {
        return;
      }

      const items = ok.map((f) => ({ id: gid(), file: f }));
      const stored = items.map(({ file }) => ({
        id: items.find((i) => i.file === file)!.id,
        name: file.name,
        size: file.size,
        sizeLabel: fmt(file.size),
        status: "validating" as const,
        errors: [] as { message: string }[],
      }));
      dispatch({ type: "SET_FILES", files: stored });
      pushLog({
        status: "ok",
        label: "Artefact file uploaded",
        detail: stored.map((f) => f.name).join(", "),
        verbose: { record: Object.fromEntries(stored.map((f) => [f.name, f.sizeLabel])) },
      });

      // Validate each file by actually parsing it; stash results for parse().
      const appWindow = window as AppWindow;
      const store = appWindow.__acParsed ?? {};
      appWindow.__acParsed = store;

      for (const it of items) {
        try {
          const parsed = await parseArtefactFile(it.file, state.settings);
          const errs = parsed.missingColumns.length
            ? parsed.missingColumns.map((c) => ({ message: `Missing required column: ${c}` }))
            : [];
          store[it.id] = { rows: parsed.rows, imageRowIndices: parsed.imageRowIndices, sheetRowToDataRow: parsed.sheetRowToDataRow, discardedColumns: parsed.discardedColumns, file: it.file };
          dispatch({ type: "SET_FILE_STATUS", id: it.id, status: errs.length ? "invalid" : "valid", errors: errs, validationErrors: [] });
        } catch (e) {
          dispatch({ type: "SET_FILE_STATUS", id: it.id, status: "invalid", errors: [{ message: `Could not read file: ${(e as Error).message}` }], validationErrors: [] });
        }
      }

      const anyValid = items.some((it) => store[it.id]);
      const validEntries = items.map((it) => store[it.id]).filter(Boolean);
      const dataRows = validEntries.reduce((n, e) => n + e.rows.length, 0);
      const discarded = validEntries.reduce<Record<string, string>>((acc, e) => {
        for (const [k, v] of Object.entries(e.discardedColumns)) acc[k] = v;
        return acc;
      }, {});
      pushLog({
        status: anyValid ? "ok" : "fail",
        label: "Fields validated, ready to parse",
        detail: anyValid ? `${dataRows} data row${dataRows === 1 ? "" : "s"}${Object.keys(discarded).length ? ` · ${Object.keys(discarded).length} discarded field${Object.keys(discarded).length === 1 ? "" : "s"}` : ""}` : undefined,
        verbose: anyValid ? { discardedColumns: discarded } : { error: "No readable artefact file" },
      });
    },
    [dispatch, state.settings]
  );

  const onUploadClick = useCallback(() => ensureInput(".xlsx", (fl) => void addFiles(fl)), [ensureInput, addFiles]);

  const addAnotherFile = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    ensureInput(".xlsx", (fl) => void addFiles(fl));
  }, [ensureInput, addFiles]);

  const setUploadDrag = useCallback((drag: boolean) => dispatch({ type: "SET_UPLOAD_DRAG", drag }), [dispatch]);
  const { onDragOver, onDragLeave, onDrop } = useDropZone(setUploadDrag, (fl) => void addFiles(fl));

  const removeFile = useCallback((id: string) => dispatch({ type: "REMOVE_FILE", id }), [dispatch]);

  // --- parse ---
  const startParse = useCallback(async () => {
    if (!state.files.some((f) => f.status === "valid")) return;
    // Defense-in-depth: UploadPanel already gates Parse on parseStatus === "idle",
    // but startParse is on the public AppActions surface, so guard here too — a
    // run is already active (or terminal; Reset re-enables Parse).
    if (state.parseStatus !== "idle") return;

    // Take the first valid file's parsed rows (one batch per parse).
    const store = (window as AppWindow).__acParsed ?? {};
    const firstValid = state.files.find((f) => f.status === "valid");
    const entry = firstValid ? store[firstValid.id] : undefined;
    if (!entry) return; // nothing to catalogue without a real spreadsheet

    const rows = entry.rows.map((r) => ({ ...r, status: "queued" as const }));
    const imageRowIndices = entry.imageRowIndices;
    const sheetRowToDataRow = entry.sheetRowToDataRow;
    const file = entry.file;

    // A single active provider catalogues each artefact in one multimodal prompt.
    const prov = activeProvider(state.settings);
    if (!prov) {
      dispatch({ type: "SET_PARSE_ERROR", error: "An active AI provider is required — add one in Settings → Model Providers." });
      return;
    }
    // A vocab field whose source hasn't been synced yet resolves to neither
    // the full list nor a shortlist — it would silently prompt as
    // unconstrained free text (see findUnsyncedVocabField). Fail the whole
    // run up front rather than producing quietly-wrong results.
    const unsynced = findUnsyncedVocabField(state.settings);
    if (unsynced) {
      dispatch({ type: "SET_PARSE_ERROR", error: `Vocabulary source "${unsynced.sourceName}" (used by "${unsynced.fieldName}") is not yet embedded — sync it in Settings → Vocabulary Lists before parsing, or remove it from this field.` });
      return;
    }
    // Vocab fields are resolved purely by embedding search (no LLM), so they
    // need an active embedding provider — without one they'd silently come
    // back empty. Fail loudly with a pointer to Settings → Model Providers.
    const noEmbed = findVocabFieldWithoutEmbedding(state.settings);
    if (noEmbed) {
      dispatch({ type: "SET_PARSE_ERROR", error: `Controlled-vocabulary fields (e.g. "${noEmbed.fieldName}") are resolved by embedding search and need an active embedding provider — add one in Settings → Model Providers before parsing.` });
      return;
    }

    // Fresh control flags for this run: a previous run's cancel/pause can't
    // bleed in. Polled at the top of each loop iteration (see below).
    parseControl.current = { paused: false, cancelled: false };

    dispatch({ type: "START_PARSE", results: rows });

    // Extract embedded images to disk beside the binary, then attach paths.
    if (file) {
      try {
        const sessionId = gid();
        const res = await extractImagesFromXlsx(file, imageRowIndices, sheetRowToDataRow, sessionId);
        res.rowIndexToFileId.forEach((absPath, rowIdx) => {
          const row = rows[rowIdx];
          if (row) {
            row.imagePath = absPath;
            dispatch({ type: "SET_ROW_IMAGE", uid: row.uid, imagePath: absPath });
          }
        });
      } catch (e) {
        // Image extraction is best-effort; rows without an image continue. Log
        // the failure so a missing image is diagnosable in the Logs Viewer
        // rather than failing silently to the "no image" placeholder.
        pushLog({
          status: "fail",
          jobId: "extract",
          label: "Image extraction failed",
          detail: "Rows will catalogue without an embedded image.",
          verbose: { error: String((e as Error)?.message || e) },
        });
      }
    }

    // Fail-fast: on the first AI error, abort the whole batch and surface it.
    // Remaining rows (current + queued) are marked errored; no demo data.
    let cancelled = false;
    for (let i = 0; i < rows.length; i++) {
      // Pause/Cancel gate, checked at the top of each iteration — so the
      // in-flight row always finishes before either takes effect (there is no
      // transport-level abort on the Rust side). Pause holds here cheaply;
      // cancel overrides pause and drops straight through to the cancel break.
      while (parseControl.current.paused && !parseControl.current.cancelled) await delay(100);
      if (parseControl.current.cancelled) {
        // Mark every not-yet-started row as cancelled. By construction rows
        // 0..i-1 are done/error and rows[i..] are all still queued here, so no
        // status filter is needed. Cancel is terminal: re-running needs Reset.
        const remaining = rows.slice(i);
        for (const r of remaining) dispatch({ type: "SET_ROW_STATUS", uid: r.uid, status: "cancelled" });
        if (remaining.length) {
          pushLog({
            status: "fail",
            jobId: "cancel",
            label: "Parse cancelled",
            detail: `${remaining.length} row${remaining.length > 1 ? "s" : ""} skipped`,
          });
        }
        cancelled = true;
        break;
      }

      const row = rows[i];
      // One group per row so the "now parsing" busy dot resolves to this row's
      // terminal outcome (populated/failed).
      const jobId = `row-${row.uid}`;
      dispatch({ type: "SET_ROW_STATUS", uid: row.uid, status: "processing" });
      const record = row.record ?? {};
      pushLog({
        status: "busy",
        jobId,
        label: `Now parsing row ID ${i + 1}`,
        detail: rowLabel(row, i),
        verbose: { record },
      });
      await delay(200); // brief tick so the UI shows processing

      const rowStart = performance.now();
      let ai: Record<string, { value: string; similarity?: number }[]>;
      try {
        ai = await catalogueArtefact(prov, state.settings.fields, record, row.imagePath, state.settings, `row-${row.uid}`);
      } catch (e) {
        const message = String((e as Error)?.message || e);
        // A per-row Stop cancels only this row: mark it cancelled and carry on
        // to the remaining queued rows. (Distinct from a whole-run cancel, which
        // is fail-stop on the loop itself.) Any other error stays fail-fast.
        if (message === CANCEL_ERROR) {
          dispatch({ type: "SET_ROW_STATUS", uid: row.uid, status: "cancelled" });
          pushLog({ status: "ok", jobId, label: `Row ${i + 1} cancelled`, detail: rowLabel(row, i), elapsedMs: Math.round(performance.now() - rowStart) });
          continue;
        }
        pushLog({ status: "fail", jobId, label: `Row ${i + 1} failed`, detail: message, elapsedMs: Math.round(performance.now() - rowStart), verbose: { error: message } });
        // Mark this row and all not-yet-processed rows as errored.
        for (let j = i; j < rows.length; j++) {
          dispatch({ type: "SET_ROW_STATUS", uid: rows[j].uid, status: "error" });
        }
        dispatch({ type: "SET_PARSE_ERROR", error: message });
        // The run terminated (via error); the parseError banner carries the why.
        dispatch({ type: "SET_PARSE_STATUS", status: "completed" });
        return;
      }

      dispatch({ type: "SET_ROW_STATUS", uid: row.uid, status: "done", ai });
      const rowElapsed = Math.round(performance.now() - rowStart);
      pushLog({
        status: "ok",
        jobId,
        label: "Populated into cataloguing fields",
        detail: `${i + 1}/${rows.length} · ${Object.keys(ai).length} fields`,
        elapsedMs: rowElapsed,
        verbose: {
          record: Object.fromEntries(
            Object.entries(ai).map(([k, v]) => [k, (v || []).map((s) => `${s.value}${s.similarity != null ? ` (${Math.round(s.similarity * 100)}%)` : ""}`).join(" · ")])
          ),
        },
      });
      if (i < rows.length - 1) await delay(300 + Math.random() * 300);
    }
    // Normal end of the run. parseStatus is already "cancelled" when the user
    // cancelled (cancelParse sets it for instant feedback) — don't clobber it.
    if (!cancelled) dispatch({ type: "SET_PARSE_STATUS", status: "completed" });
  }, [state.files, state.settings, state.parseStatus, dispatch]);

  // Pause/Resume/Cancel flip the shared control ref that startParse polls at
  // the top of each iteration, and update parseStatus so the button row
  // reflects the new state immediately (independent of where the loop is in
  // its current await). No-ops outside an active run are guarded on the caller
  // side (UploadPanel only renders Pause/Resume/Cancel while active/paused).
  const pauseParse = useCallback(() => {
    parseControl.current.paused = true;
    dispatch({ type: "SET_PARSE_STATUS", status: "paused" });
  }, [dispatch]);
  const resumeParse = useCallback(() => {
    parseControl.current.paused = false;
    dispatch({ type: "SET_PARSE_STATUS", status: "running" });
  }, [dispatch]);
  const cancelParse = useCallback(() => {
    parseControl.current.cancelled = true;
    dispatch({ type: "SET_PARSE_STATUS", status: "cancelled" });
  }, [dispatch]);

  const dismissParseError = useCallback(() => dispatch({ type: "SET_PARSE_ERROR", error: null }), [dispatch]);

  // Clear the whole upload + parse + results flow. Confirms first (mirrors the
  // settings delete flow), then drops the in-memory parsed cache so stale rows
  // can't leak into a subsequent parse, and dispatches the reset.
  const resetUpload = useCallback(async () => {
    const ok = await confirmDelete({
      title: "Reset upload?",
      message: "This clears all uploaded files, parsed results and selections. This cannot be undone.",
      confirmLabel: "Reset",
    });
    if (!ok) return;
    delete (window as AppWindow).__acParsed;
    dispatch({ type: "RESET_UPLOAD" });
    pushLog({ status: "ok", label: "Upload reset", detail: "Cleared files, results and selections" });
  }, [confirmDelete, dispatch]);

  // Retry a single row's AI call. Reuses catalogueArtefact with the row's own
  // record + imagePath (already on state.results, so no image re-extraction).
  // Failures stay scoped to the row — no global banner — except a missing
  // active provider, which is a pre-flight config error like startParse.
  const retryRow = useCallback(async (uid: string) => {
    const row = state.results.find((r) => r.uid === uid);
    if (!row || row.status === "processing") return; // missing or already retrying

    const prov = activeProvider(state.settings);
    if (!prov) {
      dispatch({ type: "SET_PARSE_ERROR", error: "An active AI provider is required — add one in Settings → Model Providers." });
      return;
    }
    const unsynced = findUnsyncedVocabField(state.settings);
    if (unsynced) {
      dispatch({ type: "SET_PARSE_ERROR", error: `Vocabulary source "${unsynced.sourceName}" (used by "${unsynced.fieldName}") is not yet embedded — sync it in Settings → Vocabulary Lists before parsing, or remove it from this field.` });
      return;
    }
    const noEmbed = findVocabFieldWithoutEmbedding(state.settings);
    if (noEmbed) {
      dispatch({ type: "SET_PARSE_ERROR", error: `Controlled-vocabulary fields (e.g. "${noEmbed.fieldName}") are resolved by embedding search and need an active embedding provider — add one in Settings → Model Providers before parsing.` });
      return;
    }

    // Clear the stale batch banner from the original Parse; a retry outcome is
    // reflected on the row itself, not the global error.
    dispatch({ type: "SET_PARSE_ERROR", error: null });

    const jobId = `row-${row.uid}`;
    dispatch({ type: "SET_ROW_STATUS", uid: row.uid, status: "processing" });
    const record = row.record ?? {};
    pushLog({
      status: "busy",
      jobId,
      label: "Retrying row",
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
            (Object.entries(ai) as [string, { value: string; similarity?: number }[]][]).map(([k, v]) => [k, (v || []).map((s) => `${s.value}${s.similarity != null ? ` (${Math.round(s.similarity * 100)}%)` : ""}`).join(" · ")])
          ),
        },
      });
    } catch (e) {
      const message = String((e as Error)?.message || e);
      // A cancel is a user action, not a failure: mark the row cancelled and
      // stay quiet in the logs (Stop has no error to surface).
      if (message === CANCEL_ERROR) {
        dispatch({ type: "SET_ROW_STATUS", uid: row.uid, status: "cancelled" });
        pushLog({ status: "ok", jobId, label: "Row cancelled", detail: rowLabel(row) });
        return;
      }
      dispatch({ type: "SET_ROW_STATUS", uid: row.uid, status: "error" });
      pushLog({ status: "fail", jobId, label: "Retry failed", detail: message, elapsedMs: Math.round(performance.now() - start), verbose: { error: message } });
    }
  }, [state.results, state.settings, dispatch]);

  // Stop a single in-flight row by cancelling its transport-level AI call. The
  // awaiting retryRow/startParse catch then transitions the row to `cancelled`.
  // No status change here: the row is `processing`, and flipping it preemptively
  // would race the catch (which is the single owner of the terminal status).
  const stopRow = useCallback(async (uid: string) => {
    const row = state.results.find((r) => r.uid === uid);
    if (!row || row.status !== "processing") return; // nothing to stop
    await cancelCatalogue(`row-${uid}`);
  }, [state.results]);

  const retryAllFailed = useCallback(async () => {
    // Snapshot the failed rows up front so rows that fail again (or newly fail)
    // during the loop aren't re-queued in the same pass — one attempt each,
    // sequentially, matching batch pacing.
    const failed = state.results.filter((r) => r.status === "error");
    for (const r of failed) await retryRow(r.uid);
  }, [state.results, retryRow]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--split-h")) || 250;
    const mv = (ev: MouseEvent) =>
      document.documentElement.style.setProperty("--split-h", Math.max(120, Math.min(520, startH + (ev.clientY - startY))) + "px");
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
    rows.forEach((vals) => {
      // Prefix formula-injection triggers (= + - @ \t \r) with a single quote
      // so spreadsheet apps render these as text — same guard the old CSV
      // exporter applied via csvSafeCell, now applied per cell as the row is
      // added. Keeps the protection in lockstep with the value resolution.
      const safe = vals.map((c) => csvSafeCell(String(c)));
      ws.addRow(Object.fromEntries(headers.map((h, i) => [h, safe[i]])));
    });

    // Embed the actual image bytes for any toggled-on image column. The image
    // column carries no text (its bytes go to vision separately at parse), so
    // its cell above is empty; this anchors the extracted image to that cell.
    if (imageColName) {
      const colIdx = headers.indexOf(imageColName); // 0-based
      const colLetter = colIndexToLetter(colIdx);
      await Promise.all(doneRows.map(async (r, rowIdx) => {
        if (!r.imagePath) return;
        try {
          // Image bytes live on disk beside the binary (written by
          // extract_images at parse). Read them back and embed anchored to
          // this row's image cell. ExcelJS accepts Uint8Array/ArrayBuffer at
          // runtime for the buffer and a range string for the anchor — its
          // bundled TS types lag the runtime (they want Buffer + Anchor
          // instances), so we feed it the simpler shapes the docs document.
          const bytes = await readFile(r.imagePath);
          const lower = r.imagePath.toLowerCase();
          const extension: "png" | "jpeg" = lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "jpeg" : "png";
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const id = wb.addImage({ buffer: bytes as any, extension });
          // Data rows start at sheet row 2 (row 1 is the header). Anchor each
          // image to span its own cell with a one-cell range string, so the
          // image stays in its row (ExcelJS stretches it to the cell bounds).
          const cell = `${colLetter}${rowIdx + 2}`;
          ws.addImage(id, `${cell}:${cell}`);
        } catch {
          // Missing/unreadable image — leave the cell empty rather than abort
          // the whole export. Logged for diagnosis via the existing extract
          // log path; no separate user-facing error here.
        }
      }));
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
    (key: string, value: string, source: "ai" | "vocab" | "manual", listName: string, similarity: number | null) =>
      dispatch({ type: "TOGGLE_FIELD_VALUE", key, value, source, listName, similarity }),
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
    const savedFields = state.settings.fields;
    const savedById = new Map(savedFields.map((f) => [f.id, f] as const));
    const reorderedSavedIds = ids.filter((id) => savedById.has(id));
    if (reorderedSavedIds.length !== savedFields.length) return;
    const reorderedSaved = reorderedSavedIds.map((id) => savedById.get(id)!);
    const newSettings: Settings = { ...state.settings, fields: reorderedSaved };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      // Mirror reorder into draft using draft values, preserving content edits.
      patchDraft((d) => {
        const draftById = new Map(d.fields.map((f) => [f.id, f] as const));
        const reorderedDraft = ids.map((id) => draftById.get(id)).filter((f): f is CatalogueField => !!f);
        return reorderedDraft.length === d.fields.length ? { ...d, fields: reorderedDraft } : d;
      });
    } catch { console.error("[artefact] reorderFields: save failed"); }
  }, [state.settings, state.darkMode, state.zoom, patchDraft, dispatch]);
  const removeField = useCallback(async (id: string) => {
    const liveFields = state.fieldDraft?.fields ?? state.settings.fields;
    const label = liveFields.find((f) => f.id === id)?.name || "this field";
    const ok = await confirmDelete({
      title: "Delete catalogue field?",
      message: `Delete "${label}"? This immediately removes the field from all artefacts.`,
    });
    if (!ok) return;
    const remaining = state.settings.fields.filter((f) => f.id !== id);
    const newSettings: Settings = { ...state.settings, fields: remaining };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      if (state.fieldDraft) {
        patchDraft((d) => ({ ...d, fields: d.fields.filter((f) => f.id !== id) }));
      }
    } catch { console.error("[artefact] removeField: save failed"); }
  }, [state.fieldDraft, state.settings, state.darkMode, state.zoom, patchDraft, dispatch, confirmDelete]);
  const updateField = useCallback((id: string, key: EditableCatalogueFieldKey, value: string | FieldType) => {
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
    // Upsert: replace if the field already persists, else append (a newly-added
    // field isn't in settings yet — its per-card Save persists it in place).
    const persisted = state.settings.fields.some((f) => f.id === id);
    const fields = persisted
      ? state.settings.fields.map((f) => (f.id === id ? { ...cardField } : f))
      : [...state.settings.fields, { ...cardField }];
    const newSettings: Settings = { ...state.settings, fields };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      // Sync the draft entry to its now-persisted value so this card reads as
      // clean while any other pending cards/structural changes stay buffered.
      dispatch({ type: "PATCH_FIELD_DRAFT", patch: (d) => ({ ...d, fields: d.fields.map((f) => (f.id === id ? { ...cardField } : f)) }) });
      dispatch({ type: "SET_FIELD_CARD_STATUS", id, status: "ok" });
    } catch {
      dispatch({ type: "SET_FIELD_CARD_STATUS", id, status: "err" });
    }
  }, [state.fieldDraft, state.settings, state.darkMode, state.zoom, dispatch]);

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
    patchDraft((d) => ({ ...d, fields: [...d.fields, { id, name: "", type: "open", layout: "row", prompt: "", vocabSources: [] }] }));
    dispatch({ type: "TOGGLE_SF", id });
  }, [patchDraft, dispatch]);

  // --- settings: vocab ---
  // A source's files/fields/embedding status have real Rust-side disk effects
  // (staged bytes, a LanceDB table) and persist immediately, mirroring
  // removeVocabList's old "no banner" structural-change pattern — buffering
  // them in a draft would let Discard desync the UI from what's already on
  // disk. Only the Display Name is draft-buffered per card (unchanged from
  // before). Reorders and deletes also persist immediately.
  const startAddVocabSource = useCallback(() => {
    const id = gid();
    patchVocabDraft((d) => ({
      ...d,
      vocabSources: [...d.vocabSources, {
        id, name: "", files: [], fields: [],
        ingestionField: null, labelField: null, badgeField: null,
        embedding: { status: "never", providerId: null, model: null, dimensions: null, lastSyncedAt: null, rowsEmbedded: null, lastError: null },
      }],
    }));
    // Also seed persisted settings immediately (structural add, like startAddField
    // does for its own draft) so the source exists on disk for the very first
    // addFilesToSource call, which needs a real sourceId to stage files under.
    patch((s) => ({
      ...s,
      vocabSources: [...s.vocabSources, {
        id, name: "", files: [], fields: [],
        ingestionField: null, labelField: null, badgeField: null,
        embedding: { status: "never", providerId: null, model: null, dimensions: null, lastSyncedAt: null, rowsEmbedded: null, lastError: null },
      }],
    }));
    dispatch({ type: "TOGGLE_VOCAB", id });
  }, [patchVocabDraft, patch, dispatch]);

  const addFilesToSource = useCallback(async (sourceId: string, list: FileList | File[]) => {
    const ok = Array.from(list).filter((f) => /\.(xlsx|xls|csv)$/i.test(f.name));
    if (!ok.length) return;
    dispatch({ type: "SET_VOCAB_CARD_ERROR", id: sourceId, error: null });
    dispatch({ type: "SET_VOCAB_CARD_STATUS", id: sourceId, status: "saving" });
    try {
      const staged = [];
      for (const f of ok) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        staged.push(await vocabLib.stageVocabFile(sourceId, f.name, bytes));
      }
      const source = state.settings.vocabSources.find((v) => v.id === sourceId);
      if (!source) return;
      const files = [...source.files, ...staged.map((s) => ({ id: s.id, filename: s.filename, addedDate: s.addedDate, sizeBytes: s.sizeBytes, rowCountLast: s.rowCount }))];
      const existingNames = new Set(source.fields.map((f) => f.name));
      const newFieldNames = new Set(staged.flatMap((s) => s.detectedFields));
      const fields = [
        ...source.fields,
        ...[...newFieldNames].filter((n) => !existingNames.has(n)).map((name) => ({ name, includeForAI: true })),
      ];
      // Re-embedding is only meaningful once real content has changed; a
      // source that was synced now has fresher content than its index reflects.
      const embedding = source.embedding.status === "synced"
        ? { ...source.embedding, status: "stale" as const }
        : source.embedding;
      const vocabSources = state.settings.vocabSources.map((v) => (v.id === sourceId ? { ...v, files, fields, embedding } : v));
      const newSettings: Settings = { ...state.settings, vocabSources };
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      dispatch({ type: "SET_VOCAB_CARD_STATUS", id: sourceId, status: "ok" });
    } catch (e) {
      console.error("[artefact] addFilesToSource failed:", e);
      dispatch({ type: "SET_VOCAB_CARD_ERROR", id: sourceId, error: (e as Error)?.message || String(e) });
      dispatch({ type: "SET_VOCAB_CARD_STATUS", id: sourceId, status: "err" });
    }
  }, [state.settings, state.darkMode, state.zoom, dispatch]);

  const removeFileFromSource = useCallback(async (sourceId: string, filename: string) => {
    const source = state.settings.vocabSources.find((v) => v.id === sourceId);
    if (!source) return;
    await vocabLib.removeVocabFile(sourceId, filename);
    const files = source.files.filter((f) => f.filename !== filename);
    const embedding = source.embedding.status === "synced"
      ? { ...source.embedding, status: "stale" as const }
      : source.embedding;
    const vocabSources = state.settings.vocabSources.map((v) => (v.id === sourceId ? { ...v, files, embedding } : v));
    const newSettings: Settings = { ...state.settings, vocabSources };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
    } catch { console.error("[artefact] removeFileFromSource: save failed"); }
  }, [state.settings, state.darkMode, state.zoom, dispatch]);

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
    const source = state.settings.vocabSources.find((v) => v.id === sourceId);
    if (!source) return;
    const fields = source.fields.map((f) => (f.name === fieldName ? { ...f, includeForAI: !f.includeForAI } : f));
    // Toggling includeForAI changes embed_text, so a synced index is now stale
    // regardless of whether the underlying file content changed (see M2 diff-
    // key nuance: the fields-config version is part of the effective row hash).
    const embedding = source.embedding.status === "synced" ? { ...source.embedding, status: "stale" as const } : source.embedding;
    const vocabSources = state.settings.vocabSources.map((v) => (v.id === sourceId ? { ...v, fields, embedding } : v));
    void patch(() => ({ ...state.settings, vocabSources }));
  }, [state.settings, patch]);

  const setVocabIngestionField = useCallback((sourceId: string, fieldName: string | null) => {
    const source = state.settings.vocabSources.find((v) => v.id === sourceId);
    if (!source) return;
    // Changing which column supplies the term changes every row's identity,
    // so a synced index is stale regardless of whether file bytes changed —
    // mirrors toggleSourceFieldAI's stale-marking above.
    const embedding = source.embedding.status === "synced" ? { ...source.embedding, status: "stale" as const } : source.embedding;
    const vocabSources = state.settings.vocabSources.map((v) => (v.id === sourceId ? { ...v, ingestionField: fieldName, embedding } : v));
    void patch(() => ({ ...state.settings, vocabSources }));
  }, [state.settings, patch]);

  const setVocabLabelField = useCallback((sourceId: string, fieldName: string | null) => {
    const source = state.settings.vocabSources.find((v) => v.id === sourceId);
    if (!source) return;
    // Purely cosmetic — never marks the source stale. A column can only be
    // Label or Badge, not both, so picking it as Label clears it from Badge.
    const badgeField = fieldName && source.badgeField === fieldName ? null : source.badgeField;
    const vocabSources = state.settings.vocabSources.map((v) => (v.id === sourceId ? { ...v, labelField: fieldName, badgeField } : v));
    void patch(() => ({ ...state.settings, vocabSources }));
  }, [state.settings, patch]);

  const setVocabBadgeField = useCallback((sourceId: string, fieldName: string | null) => {
    const source = state.settings.vocabSources.find((v) => v.id === sourceId);
    if (!source) return;
    const labelField = fieldName && source.labelField === fieldName ? null : source.labelField;
    const vocabSources = state.settings.vocabSources.map((v) => (v.id === sourceId ? { ...v, badgeField: fieldName, labelField } : v));
    void patch(() => ({ ...state.settings, vocabSources }));
  }, [state.settings, patch]);

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

  // Threads `base` through as a parameter/return value (rather than reading
  // state.settings from closure) so syncAllVocab can chain several of these
  // in one sequential loop: each iteration's dispatch/save must build on the
  // *previous* iteration's result, not the stale settings snapshot this
  // useCallback closed over at render time.
  const syncOneVocabSource = useCallback(async (base: Settings, sourceId: string, provider: EmbeddingProvider): Promise<Settings> => {
    const source = base.vocabSources.find((v) => v.id === sourceId);
    if (!source || !source.files.length) return base;
    const markStatus = async (embedding: typeof source.embedding) => {
      base = { ...base, vocabSources: base.vocabSources.map((v) => (v.id === sourceId ? { ...v, embedding } : v)) };
      await saveState(base, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: base });
    };
    await markStatus({ ...source.embedding, status: "syncing", providerId: provider.id, model: provider.model });
    dispatch({ type: "SET_VOCAB_SYNC_PROGRESS", id: sourceId, rowsDone: 0, rowsTotal: 0 });
    try {
      const result = await vocabLib.syncVocabSource(sourceId, provider, source.fields, source.ingestionField, (ev) => {
        dispatch({ type: "SET_VOCAB_SYNC_PROGRESS", id: sourceId, rowsDone: ev.rowsDone, rowsTotal: ev.rowsTotal, fileProgress: ev.fileProgress });
      });
      const files = source.files.map((f) => {
        const rowCountLast = result.fileRowCounts[f.filename];
        const rowCountSyncedLast = result.fileSyncedCounts[f.filename];
        return { ...f, ...(rowCountLast !== undefined && { rowCountLast }), ...(rowCountSyncedLast !== undefined && { rowCountSyncedLast }) };
      });
      const embedding = {
        status: "synced" as const, providerId: provider.id, model: provider.model, dimensions: result.dimensions,
        lastSyncedAt: new Date().toISOString(), rowsEmbedded: result.totalRows, lastError: null,
      };
      base = { ...base, vocabSources: base.vocabSources.map((v) => (v.id === sourceId ? { ...v, files, embedding } : v)) };
      await saveState(base, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: base });
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
    return base;
  }, [state.darkMode, state.zoom, dispatch]);

  const syncVocabSource = useCallback(async (sourceId: string) => {
    const provider = activeEmbeddingProvider(state.settings);
    if (!provider) return;
    await syncOneVocabSource(state.settings, sourceId, provider);
  }, [state.settings, syncOneVocabSource]);

  const syncAllVocab = useCallback(async () => {
    const provider = activeEmbeddingProvider(state.settings);
    if (!provider) return;
    const ids = state.settings.vocabSources.filter((v) => v.files.length > 0).map((v) => v.id);
    let current = state.settings;
    for (const id of ids) {
      current = await syncOneVocabSource(current, id, provider);
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
    const embedding = { status: "never" as const, providerId: null, model: null, dimensions: null, lastSyncedAt: null, rowsEmbedded: null, lastError: null };
    const newSettings: Settings = { ...state.settings, vocabSources: state.settings.vocabSources.map((v) => (v.id === sourceId ? { ...v, embedding } : v)) };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      dispatch({ type: "CLEAR_VOCAB_TERMS", id: sourceId });
    } catch { console.error("[artefact] flushVocabSource: save failed"); }
  }, [state.settings, state.darkMode, state.zoom, dispatch, confirmDelete]);

  const flushAllVocab = useCallback(async () => {
    const ok = await confirmDelete({
      title: "Flush all vocabulary embeddings?",
      message: "This permanently deletes every embedded vector for every vocabulary source. Cataloguing will fall back to full-list vocab prompts (or unconstrained answers) until each source is re-synced — which can take a long time and re-incurs embedding-API cost for large sources. Uploaded files are NOT deleted; only the embedded index.",
      confirmLabel: "Flush All",
    });
    if (!ok) return;
    await vocabLib.flushAllVocab();
    const embedding = { status: "never" as const, providerId: null, model: null, dimensions: null, lastSyncedAt: null, rowsEmbedded: null, lastError: null };
    const newSettings: Settings = { ...state.settings, vocabSources: state.settings.vocabSources.map((v) => ({ ...v, embedding })) };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      dispatch({ type: "CLEAR_ALL_VOCAB_TERMS" });
    } catch { console.error("[artefact] flushAllVocab: save failed"); }
  }, [state.settings, state.darkMode, state.zoom, dispatch, confirmDelete]);

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
    // Remove from persisted settings, pruning dangling vocabSource references.
    const remaining = state.settings.vocabSources.filter((v) => v.id !== id);
    const fields = state.settings.fields.map((f) => ({ ...f, vocabSources: f.vocabSources.filter((sid) => sid !== id) }));
    const newSettings: Settings = { ...state.settings, vocabSources: remaining, fields };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      // Mirror into drafts so any pending edits stay consistent.
      if (state.vocabDraft) {
        patchVocabDraft((d) => ({ ...d, vocabSources: d.vocabSources.filter((v) => v.id !== id) }));
      }
      dispatch({ type: "PATCH_FIELD_DRAFT", patch: (d) => ({ ...d, fields: d.fields.map((f) => ({ ...f, vocabSources: f.vocabSources.filter((sid) => sid !== id) })) }) });
      dispatch({ type: "CLEAR_VOCAB_TERMS", id });
    } catch { console.error("[artefact] removeVocabSource: save failed"); }
  }, [state.vocabDraft, state.settings, state.darkMode, state.zoom, patchVocabDraft, dispatch, confirmDelete]);
  const toggleVocab = useCallback((id: string) => dispatch({ type: "TOGGLE_VOCAB", id }), [dispatch]);
  const updateVocabName = useCallback((id: string, name: string) => {
    patchVocabDraft((d) => ({ ...d, vocabSources: d.vocabSources.map((v) => (v.id === id ? { ...v, name } : v)) }));
  }, [patchVocabDraft]);
  const reorderVocab = useCallback(async (ids: string[]) => {
    // Only reorder persisted rows; skip any draft-only ids (new unsaved sources).
    const savedSources = state.settings.vocabSources;
    const savedById = new Map(savedSources.map((v) => [v.id, v] as const));
    const reorderedSavedIds = ids.filter((id) => savedById.has(id));
    if (reorderedSavedIds.length !== savedSources.length) return;
    const reorderedSaved = reorderedSavedIds.map((id) => savedById.get(id)!);
    const newSettings: Settings = { ...state.settings, vocabSources: reorderedSaved };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      // Mirror reorder into draft using draft values, preserving pending renames.
      patchVocabDraft((d) => {
        const draftById = new Map(d.vocabSources.map((v) => [v.id, v] as const));
        const reorderedDraft = ids.map((id) => draftById.get(id)).filter((v): v is (typeof d.vocabSources)[number] => !!v);
        return reorderedDraft.length === d.vocabSources.length ? { ...d, vocabSources: reorderedDraft } : d;
      });
    } catch { console.error("[artefact] reorderVocab: save failed"); }
  }, [state.settings, state.darkMode, state.zoom, patchVocabDraft, dispatch]);

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
    // immediately, but this stays defensive for that invariant).
    const persisted = state.settings.vocabSources.some((v) => v.id === id);
    const vocabSources = persisted
      ? state.settings.vocabSources.map((v) => (v.id === id ? { ...v, name: card.name } : v))
      : [...state.settings.vocabSources, card];
    const newSettings: Settings = { ...state.settings, vocabSources };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      dispatch({ type: "PATCH_VOCAB_DRAFT", patch: (d) => ({ ...d, vocabSources: d.vocabSources.map((v) => (v.id === id ? { ...v, name: card.name } : v)) }) });
      dispatch({ type: "SET_VOCAB_CARD_STATUS", id, status: "ok" });
    } catch {
      dispatch({ type: "SET_VOCAB_CARD_STATUS", id, status: "err" });
    }
  }, [state.vocabDraft, state.settings, state.darkMode, state.zoom, dispatch]);

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
  // The whole providers config is one deferred draft: field edits, add, delete,
  // and active-selection changes all accumulate in `providerDraft` and persist
  // only on the tab-level Save. Test Connection is the lone exception — it runs
  // immediately as transient verification (stored in `provStatus`).
  const startAddProv = useCallback(() => {
    dispatch({ type: "SET_PROV_SAVE_STATUS", status: null });
    // Generate the id once so the new card can be auto-expanded (and scrolled
    // into view by ProvidersTab) the moment it's added.
    const id = gid();
    patchProvDraft((d) => ({
      ...d,
      // Append an empty standard entry; the user fills it in, then Test → pick model.
      providers: [...d.providers, { id, name: "", baseUrl: "", apiKey: "", model: "", apiFormat: "openai", modelOptions: [], connStatus: "untested" }],
    }));
    dispatch({ type: "TOGGLE_PROV", id });
  }, [patchProvDraft, dispatch]);

  // Editing credentials (baseUrl/apiKey) or API format changes the transport,
  // so any prior successful connection test is no longer valid.
  // Editing name/model is downstream and must NOT clear the test/model list.
  const setProvF = useCallback((id: string, k: keyof Provider, e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    dispatch({ type: "SET_PROV_SAVE_STATUS", status: null });
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
    dispatch({ type: "SET_PROV_SAVE_STATUS", status: null });
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
    dispatch({ type: "SET_PROV_SAVE_STATUS", status: null });
    dispatch({ type: "SET_PROV_CARD_STATUS", id, status: null });
    dispatch({ type: "SET_PROV_CARD_ERROR", id, error: null });
    patchProvDraft(mapDraftEntry(id, (entry) => ({ ...entry, model })));
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
      dispatch({ type: "SET_PROV_STATUS", id, test: "err" });
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
      dispatch({ type: "SET_PROV_STATUS", id, test: "err" });
    }
  }, [state.providerDraft, state.settings, patchProvDraft, mapDraftEntry, dispatch]);

  /** Validates draft entries before Save. Only the truly required fields are
   *  gated: a provider must have a name, base URL, and API key. A model is NOT
   *  required to save — it can be populated later via Test Connection, and the
   *  catalogue run independently verifies a usable provider exists. Blocking
   *  save on a missing model prevented persisting otherwise-valid edits. */
  const validateProviders = useCallback((draft: ProviderDraft): string | null => {
    for (const e of draft.providers) {
      if (!e.name.trim()) return "Every provider needs a name.";
      if (!e.baseUrl.trim()) return `Provider "${e.name}" needs a base URL.`;
      if (!e.apiKey.trim()) return `Provider "${e.name}" needs an API key.`;
    }
    return null;
  }, []);

  const saveProviders = useCallback(async () => {
    const draft = state.providerDraft;
    if (!draft) return;
    const validationError = validateProviders(draft);
    if (validationError) {
      dispatch({ type: "SET_PROV_SAVE_STATUS", status: "err" });
      return;
    }
    dispatch({ type: "SET_PROV_SAVE_STATUS", status: "saving" });
    const newSettings: Settings = {
      ...state.settings,
      providers: draft.providers.map((e) => ({ id: e.id, name: e.name, baseUrl: e.baseUrl, apiKey: e.apiKey, model: e.model, apiFormat: e.apiFormat, modelOptions: e.modelOptions, connStatus: e.connStatus })),
      activeProvider: draft.activeProvider,
    };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      dispatch({ type: "CLEAR_PROVIDER_DRAFT" });
      dispatch({ type: "SET_PROV_SAVE_STATUS", status: "ok" });
    } catch {
      dispatch({ type: "SET_PROV_SAVE_STATUS", status: "err" });
    }
  }, [state.providerDraft, state.settings, state.darkMode, state.zoom, validateProviders, dispatch]);

  const discardProviders = useCallback(() => {
    dispatch({ type: "CLEAR_PROVIDER_DRAFT" });
    dispatch({ type: "SET_PROV_SAVE_STATUS", status: null });
  }, [dispatch]);

  // --- per-card save/discard (providers) ---
  // One provider's content (name/baseUrl/apiKey/model/format) persists or
  // reverts on its own. "Set Active" is buffered into the draft and committed
  // by the active card's own Save; delete persists immediately (after its confirm).
  const saveProvCard = useCallback(async (id: string) => {
    const draft = state.providerDraft;
    if (!draft) return;
    const entry = draft.providers.find((e) => e.id === id);
    if (!entry) return;
    // Validate just this entry — a missing name/url/key blocks its own Save
    // without affecting other cards (mirrors validateProviders per row). Surface
    // the specific reason via the card's status so the failure isn't a vague
    // "Not saved".
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
    // Upsert: replace if the provider already persists, else append (a newly
    // added provider isn't in settings yet).
    const persisted = state.settings.providers.some((p) => p.id === id);
    const providers = persisted
      ? state.settings.providers.map((p) => (p.id === id ? {
          id: entry.id, name: entry.name, baseUrl: entry.baseUrl, apiKey: entry.apiKey,
          model: entry.model, apiFormat: entry.apiFormat, modelOptions: entry.modelOptions,
          connStatus: entry.connStatus,
        } : p))
      : [...state.settings.providers, {
          id: entry.id, name: entry.name, baseUrl: entry.baseUrl, apiKey: entry.apiKey,
          model: entry.model, apiFormat: entry.apiFormat, modelOptions: entry.modelOptions,
          connStatus: entry.connStatus,
        }];
    // "Set Active" now persists immediately (see setActiveProv), so
    // draft.activeProvider always mirrors state.settings.activeProvider — read
    // the source of truth directly.
    const activeProvider = state.settings.activeProvider;
    const newSettings: Settings = { ...state.settings, providers, activeProvider };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      dispatch({ type: "PATCH_PROVIDER_DRAFT", patch: mapDraftEntry(id, (e) => ({ ...e })) });
      dispatch({ type: "SET_PROV_CARD_STATUS", id, status: "ok" });
    } catch (e) {
      // Surface the concrete failure (e.g. disk write) rather than a bare err.
      dispatch({ type: "SET_PROV_CARD_ERROR", id, error: `Could not save: ${(e as Error)?.message || "unknown error"}` });
      dispatch({ type: "SET_PROV_CARD_STATUS", id, status: "err" });
    }
  }, [state.providerDraft, state.settings, state.darkMode, state.zoom, mapDraftEntry, dispatch]);

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
          id, name: "", baseUrl: "", apiKey: "", model: "", apiFormat: "openai", modelOptions: [], connStatus: "untested",
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
    // to any remaining provider in the persisted set.
    const remaining = state.settings.providers.filter((p) => p.id !== id);
    const activeProvider = state.settings.activeProvider === id ? (remaining[0]?.id ?? null) : state.settings.activeProvider;
    const newSettings: Settings = { ...state.settings, providers: remaining, activeProvider };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
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
  }, [state.providerDraft, state.settings, state.darkMode, state.zoom, patchProvDraft, dispatch, confirmDelete]);

  const setActiveProv = useCallback(async (id: string) => {
    // "Set Active" persists immediately rather than buffering for the row's Save
    // — the active selection is a single-field structural change, not per-card
    // content. Modelled on deleteProv: write to disk, then mirror into any
    // pending draft so other buffered per-card edits survive.
    const newSettings: Settings = { ...state.settings, activeProvider: id };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      if (state.providerDraft) {
        patchProvDraft((d) => ({ ...d, activeProvider: id }));
      }
    } catch {
      // Settings not updated on failure: the button stays clickable and the
      // row surfaces the error, matching deleteProv's catch.
      dispatch({ type: "SET_PROV_CARD_STATUS", id, status: "err" });
    }
  }, [state.settings, state.darkMode, state.zoom, state.providerDraft, patchProvDraft, dispatch]);

  // --- settings: embedding providers ---
  // Same per-card draft/save/discard shape as chat providers above, just a
  // separate list — see EmbeddingProvidersSection.tsx.
  const toggleEmbProv = useCallback((id: string) => dispatch({ type: "TOGGLE_EMB_PROV", id }), [dispatch]);

  const startAddEmbProv = useCallback(() => {
    const id = gid();
    patchEmbProvDraft((d) => ({
      ...d,
      providers: [...d.providers, { id, name: "", baseUrl: "", apiKey: "", model: "", apiFormat: "openai", modelOptions: [], dimensions: null, connStatus: "untested" }],
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
      patchEmbProvDraft(mapEmbDraftEntry(id, (entry) => ({ ...entry, modelOptions: saved?.modelOptions ? [...saved.modelOptions] : [], dimensions: null, connStatus: "untested" })));
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
      dispatch({ type: "SET_EMB_PROV_STATUS", id, test: "err" });
      patchEmbProvDraft(mapEmbDraftEntry(id, (entry2) => ({ ...entry2, connStatus: "err" })));
      return;
    }
    dispatch({ type: "SET_EMB_PROV_STATUS", id, test: "testing" });
    try {
      const res = await testEmbeddingConnection({ id: "", name, baseUrl, apiKey, model, apiFormat });
      const nextModel = res.models.includes(model) ? model : "";
      patchEmbProvDraft(mapEmbDraftEntry(id, (entry2) => ({ ...entry2, model: nextModel, modelOptions: res.models, dimensions: res.dimensions, connStatus: "ok" })));
      dispatch({ type: "SET_EMB_PROV_STATUS", id, test: "ok" });
    } catch (e) {
      console.error("[artefact] test embedding connection failed", e);
      patchEmbProvDraft(mapEmbDraftEntry(id, (entry2) => ({ ...entry2, connStatus: "err" })));
      dispatch({ type: "SET_EMB_PROV_STATUS", id, test: "err" });
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
    const persisted = state.settings.embeddingProviders.some((p) => p.id === id);
    const toPersisted = (): EmbeddingProvider => ({
      id: entry.id, name: entry.name, baseUrl: entry.baseUrl, apiKey: entry.apiKey,
      model: entry.model, apiFormat: entry.apiFormat,
      modelOptions: entry.modelOptions, dimensions: entry.dimensions ?? undefined, connStatus: entry.connStatus,
    });
    const embeddingProviders = persisted
      ? state.settings.embeddingProviders.map((p) => (p.id === id ? toPersisted() : p))
      : [...state.settings.embeddingProviders, toPersisted()];
    // "Set Active" now persists immediately (see setActiveEmbProv), so read the
    // active selection from settings directly.
    const activeEmbeddingProvider = state.settings.activeEmbeddingProvider;
    const newSettings: Settings = { ...state.settings, embeddingProviders, activeEmbeddingProvider };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      dispatch({ type: "PATCH_EMB_PROVIDER_DRAFT", patch: mapEmbDraftEntry(id, (e) => ({ ...e })) });
      dispatch({ type: "SET_EMB_PROV_CARD_STATUS", id, status: "ok" });
    } catch (e) {
      dispatch({ type: "SET_EMB_PROV_CARD_ERROR", id, error: `Could not save: ${(e as Error)?.message || "unknown error"}` });
      dispatch({ type: "SET_EMB_PROV_CARD_STATUS", id, status: "err" });
    }
  }, [state.embProviderDraft, state.settings, state.darkMode, state.zoom, mapEmbDraftEntry, dispatch]);

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
          id, name: "", baseUrl: "", apiKey: "", model: "", apiFormat: "openai", modelOptions: [], dimensions: null, connStatus: "untested",
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
          modelOptions: [...(saved.modelOptions ?? [])], dimensions: saved.dimensions ?? null,
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
    const remaining = state.settings.embeddingProviders.filter((p) => p.id !== id);
    const activeEmbeddingProvider = state.settings.activeEmbeddingProvider === id ? (remaining[0]?.id ?? null) : state.settings.activeEmbeddingProvider;
    const newSettings: Settings = { ...state.settings, embeddingProviders: remaining, activeEmbeddingProvider };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
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
  }, [state.embProviderDraft, state.settings, state.darkMode, state.zoom, patchEmbProvDraft, dispatch, confirmDelete]);

  const setActiveEmbProv = useCallback(async (id: string) => {
    // "Set Active" persists immediately — see setActiveProv for rationale.
    const newSettings: Settings = { ...state.settings, activeEmbeddingProvider: id };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      if (state.embProviderDraft) {
        patchEmbProvDraft((d) => ({ ...d, activeProvider: id }));
      }
    } catch {
      dispatch({ type: "SET_EMB_PROV_CARD_STATUS", id, status: "err" });
    }
  }, [state.settings, state.darkMode, state.zoom, state.embProviderDraft, patchEmbProvDraft, dispatch]);

  // --- settings: artefact fields ---
  // The required-column config is one deferred draft (mirrors the catalogue-
  // fields draft): edits, adds, and deletes accumulate here and persist only on
  // the tab-level Save. Rows expand on click via toggleAF.
  const toggleAF = useCallback((id: string) => dispatch({ type: "TOGGLE_AF", id }), [dispatch]);
  const reorderAF = useCallback(async (ids: string[]) => {
    // Only reorder persisted rows; skip any draft-only ids (new unsaved columns).
    const savedFields = state.settings.artefactFields || _DEF_AF;
    const savedById = new Map(savedFields.map((f) => [f.id, f] as const));
    const reorderedSavedIds = ids.filter((id) => savedById.has(id));
    if (reorderedSavedIds.length !== savedFields.length) return;
    const reorderedSaved = reorderedSavedIds.map((id) => savedById.get(id)!);
    const newSettings: Settings = { ...state.settings, artefactFields: reorderedSaved };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      // Mirror reorder into draft using draft values, preserving content edits.
      patchArtefactDraft((d) => {
        const draftById = new Map(d.artefactFields.map((f) => [f.id, f] as const));
        const reorderedDraft = ids.map((id) => draftById.get(id)).filter((f): f is ArtefactField => !!f);
        return reorderedDraft.length === d.artefactFields.length ? { ...d, artefactFields: reorderedDraft } : d;
      });
    } catch { console.error("[artefact] reorderAF: save failed"); }
  }, [state.settings, state.darkMode, state.zoom, patchArtefactDraft, dispatch]);
  const updateAF = useCallback((id: string, key: EditableArtefactFieldKey, value: string) => {
    // `includeInExport` is a boolean persisted on ArtefactField, but the Segmented
    // toggle emits the string "true"/"false" — coerce here so the draft carries
    // the typed value, while name/description/prompt stay string passthroughs.
    const coerced = key === "includeInExport" ? value === "true" : value;
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
    const remaining = (state.settings.artefactFields || _DEF_AF).filter((f) => f.id !== id);
    const newSettings: Settings = { ...state.settings, artefactFields: remaining };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      if (state.artefactDraft) {
        patchArtefactDraft((d) => ({ ...d, artefactFields: d.artefactFields.filter((f) => f.id !== id) }));
      }
    } catch { console.error("[artefact] removeAF: save failed"); }
  }, [state.artefactDraft, state.settings, state.darkMode, state.zoom, patchArtefactDraft, dispatch, confirmDelete]);
  const startAddAF = useCallback(() => {
    const id = gid();
    patchArtefactDraft((d) => ({ ...d, artefactFields: [...d.artefactFields, { id, name: "", description: "", prompt: "", includeInExport: true }] }));
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
    // Upsert: replace if the column already persists, else append (a newly
    // added column isn't in settings yet). Coalesce optional keys to "" so a
    // missing key never survives into persisted settings.
    const base = state.settings.artefactFields || _DEF_AF;
    const persisted = base.some((f) => f.id === id);
    const normalize = (f: ArtefactField) => ({ ...f, description: f.description ?? "", prompt: f.prompt ?? "" });
    const artefactFields = persisted
      ? base.map((f) => (f.id === id ? normalize({ ...card }) : f))
      : [...base, normalize({ ...card })];
    const newSettings: Settings = { ...state.settings, artefactFields };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      dispatch({ type: "PATCH_ARTEFACT_DRAFT", patch: (d) => ({ ...d, artefactFields: d.artefactFields.map((f) => (f.id === id ? { ...card } : f)) }) });
      dispatch({ type: "SET_ARTEFACT_CARD_STATUS", id, status: "ok" });
    } catch {
      dispatch({ type: "SET_ARTEFACT_CARD_STATUS", id, status: "err" });
    }
  }, [state.artefactDraft, state.settings, state.darkMode, state.zoom, dispatch]);

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

  // --- vision-analysis system instruction (artefact tab, vision-analysis
  // stage of the threaded pipeline). Deferred draft + per-card save,
  // mirroring the catalogue tab's System Instructions trio.
  const updateVisionSystemPromptInstruction = useCallback((value: string) => {
    patchArtefactDraft((d) => ({ ...d, visionSystemPromptInstruction: value }));
  }, [patchArtefactDraft]);
  const saveVisionSystemPromptInstruction = useCallback(async () => {
    const draft = state.artefactDraft;
    if (!draft) return;
    dispatch({ type: "SET_ARTEFACT_CARD_STATUS", id: "vision-instruction", status: "saving" });
    const newSettings: Settings = { ...state.settings, visionSystemPromptInstruction: draft.visionSystemPromptInstruction };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      dispatch({ type: "SET_ARTEFACT_CARD_STATUS", id: "vision-instruction", status: "ok" });
    } catch {
      dispatch({ type: "SET_ARTEFACT_CARD_STATUS", id: "vision-instruction", status: "err" });
    }
  }, [state.artefactDraft, state.settings, state.darkMode, state.zoom, dispatch]);
  const discardVisionSystemPromptInstruction = useCallback(() => {
    const draft = state.artefactDraft;
    if (!draft) return;
    dispatch({ type: "SET_ARTEFACT_CARD_STATUS", id: "vision-instruction", status: null });
    dispatch({ type: "PATCH_ARTEFACT_DRAFT", patch: (d) => ({ ...d, visionSystemPromptInstruction: state.settings.visionSystemPromptInstruction ?? "" }) });
  }, [state.artefactDraft, state.settings.visionSystemPromptInstruction, dispatch]);

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
    const current = state.artefactDraft?.visionSystemPromptInstruction ?? state.settings.visionSystemPromptInstruction ?? "";
    if (!current) updateVisionSystemPromptInstruction(_DEF_VISION_SYSTEM_PROMPT_INSTRUCTION);
    setPromptEditing(true);
  }, [confirmDelete, state.artefactDraft, state.settings.visionSystemPromptInstruction, updateVisionSystemPromptInstruction, setPromptEditing]);

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
    // Migrate a pre-VocabSource export (old `vocabularyLists` key), then
    // validate with the same tolerant schema loadState uses — an imported
    // file can be just as old/partial as a persisted one, and
    // withDefaultSettings fills any gaps (e.g. a pre-embeddings export
    // missing `embeddingProviders`/`activeEmbeddingProvider` entirely).
    const migrated = stripBuiltinLegacyVocabFields(migrateLegacyVocabularyLists(raw));
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
    onUploadClick, addAnotherFile, onDragOver, onDragLeave, onDrop, removeFile, startParse, pauseParse, resumeParse, cancelParse, dismissParseError, resetUpload, retryRow, stopRow, retryAllFailed, onResizeStart,
    toggleRow, setFilter, setSearch, toggleSearchColAf, toggleSearchColCat, setSearchColsAf, setSearchColsCat, dismissExportWarning, exportResults, onTriggerClick, setFieldSearch, toggleFieldValue, clearField, setOpenFieldValue,
    toggleSF, reorderFields, removeField, updateField, addVocabSrc, removeVocabSrc, saveFieldCard, discardFieldCard, startAddField, toggleProv,
    startAddVocabSource, addFilesToSource, removeFileFromSource, downloadVocabFile, toggleSourceFieldAI, setVocabIngestionField, setVocabLabelField, setVocabBadgeField, syncVocabSource, syncAllVocab, cancelVocabSync, flushVocabSource, flushAllVocab, removeVocabSource, toggleVocab, updateVocabName, reorderVocab, saveVocabCard, discardVocabCard, ensureVocabTermsLoaded, setVocabNetCount, setVocabShortlistCount, setValidationEnabled,
    startAddProv, setProvF, setProvModel, setProvApiFormat, toggleProvKey, testConn, saveProviders, discardProviders, deleteProv, setActiveProv, saveProvCard, discardProvCard,
    toggleEmbProv, startAddEmbProv, setEmbProvF, setEmbProvModel, setEmbProvApiFormat, toggleEmbProvKey, testEmbConn, deleteEmbProv, setActiveEmbProv, saveEmbProvCard, discardEmbProvCard,
    toggleAF, reorderAF, updateAF, removeAF, startAddAF, saveArtefactCard, discardArtefactCard, updateVisionSystemPromptInstruction, saveVisionSystemPromptInstruction, discardVisionSystemPromptInstruction, setPromptEditing, overridePrompt,
    exportSettings, importSettings,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
