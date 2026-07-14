// All user actions as a single hook, mirroring the reference DCLogic methods.
// Heavy async work (parsing, image extraction, AI) lives here; pure settings
// mutations dispatch PATCH_SETTINGS and the debounced saver persists them.

import { useCallback, useRef } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

import { useDropZone } from "../hooks/useDropZone";
import type { Action, AppState, ArtefactDraft, EditableArtefactFieldKey, EditableCatalogueFieldKey, FieldDraft, ProviderDraft, ProviderDraftEntry, VocabDraft } from "./state";
import { artefactDraftFromSettings, providerDraftFromSettings, vocabDraftFromSettings } from "./state";
import { _DEF_AF, _DEF_SYSTEM_PROMPT_CONTRACT, fmt, gid } from "./defaults";
import type { ApiFormat, ArtefactField, ArtefactRow, CatalogueField, FieldType, Provider, Settings, SettingsTab } from "./types";
import { isTabDirty } from "./drafts";
import { parseArtefactFile, makeVocabList, roleFieldNames } from "../lib/spreadsheet";
import { extractImagesFromXlsx } from "../lib/images";
import { catalogueArtefact, cancelCatalogue, CANCEL_ERROR, testConnection, activeProvider } from "../lib/ai";
import { pushLog } from "../lib/logs";
import { saveState, withDefaultSettings } from "../lib/store";
import { SettingsSchema } from "./schema";
import type { ConfirmDeleteOptions } from "../components/ConfirmDialog";

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
  exportResults(): Promise<void>;
  onTriggerClick(key: string): void;
  setFieldSearch(key: string, val: string): void;
  /** Toggle a vocab term in/out of a field's selection set (multi-select). */
  toggleFieldValue(key: string, value: string, source: "ai" | "vocab" | "manual", listName: string, confidence: number | null): void;
  clearField(key: string): void;
  setOpenFieldValue(key: string, val: string): void;

  // settings: fields
  toggleSF(id: string): void;
  /** Reorder catalogue fields to the given id sequence (result of a drag). Persists immediately. */
  reorderFields(ids: string[]): Promise<void>;
  toggleProv(id: string): void;
  removeField(id: string): Promise<void>;
  updateField(id: string, key: EditableCatalogueFieldKey, value: string | FieldType): void;
  updateSystemPromptInstruction(value: string): void;
  updateSystemPromptContract(value: string): void;
  setContractEditing(editing: boolean): void;
  overrideContract(): Promise<void>;
  addVocabSrc(fId: string, vId: string): void;
  removeVocabSrc(fId: string, sId: string): void;
  /** Persist only this catalogue-field row's content edits to disk. */
  saveFieldCard(id: string): Promise<void>;
  /** Revert only this catalogue-field row's content edits. */
  discardFieldCard(id: string): void;
  /** Persist only the System Instructions prose card. */
  saveSystemInstruction(): Promise<void>;
  /** Revert only the System Instructions prose card. */
  discardSystemInstruction(): void;
  /** Persist only the Output Contract prose card. */
  saveContract(): Promise<void>;
  /** Revert only the Output Contract prose card. */
  discardContract(): void;
  /** Append an empty catalogue-field row to the draft (expanded), mirroring the
   *  ProvidersTab add flow. Persisted on the tab-level Save / per-card Save. */
  startAddField(): void;

  // settings: vocab
  onVocabClick(): void;
  onVocabDragOver(e: React.DragEvent): void;
  onVocabDragLeave(): void;
  onVocabDrop(e: React.DragEvent): void;
  removeVocabList(id: string): Promise<void>;
  toggleVocab(id: string): void;
  /** Update a vocab list's display name directly in the draft (like updateField). */
  updateVocabName(id: string, name: string): void;
  /** Reorder vocab lists to the given id sequence (result of a drag). Persists immediately. */
  reorderVocab(ids: string[]): Promise<void>;
  /** Persist only this vocab list's rename to disk. */
  saveVocabCard(id: string): Promise<void>;
  /** Revert only this vocab list's rename. */
  discardVocabCard(id: string): void;

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
  setActiveProv(id: string): void;
  /** Persist only this provider card's content edits to disk (independent of
   *  any pending structural changes buffered for the tab-level Apply). */
  saveProvCard(id: string): Promise<void>;
  /** Revert only this provider card's content edits back to its persisted value. */
  discardProvCard(id: string): void;

  // settings: artefact fields — content edits accumulate per-card; reorders and
  // deletes persist immediately. Rows expand on click via toggleAF.
  toggleAF(id: string): void;
  /** Reorder artefact columns to the given id sequence (result of a drag). Persists immediately. */
  reorderAF(ids: string[]): Promise<void>;
  updateAF(id: string, key: EditableArtefactFieldKey, value: string | boolean): void;
  removeAF(id: string): Promise<void>;
  /** Append an empty artefact-column row to the draft (expanded). Persisted on per-card Save. */
  startAddAF(): void;
  /** Persist only this artefact-column row's content edits to disk. */
  saveArtefactCard(id: string): Promise<void>;
  /** Revert only this artefact-column row's content edits. */
  discardArtefactCard(id: string): void;

  // settings: import/export
  exportSettings(): Promise<void>;
  importSettings(e: React.ChangeEvent<HTMLInputElement>): Promise<void>;
}

type Dispatch = (action: Action) => void;
type Persist = () => void;
type ConfirmDelete = (opts: ConfirmDeleteOptions) => Promise<boolean>;
type ParsedStore = Record<string, { rows: ArtefactRow[]; imageRowIndices: number[]; discardedColumns: Record<string, string>; file: File }>;
type AppWindow = Window & { __acFi?: HTMLInputElement; __acParsed?: ParsedStore };

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
      case "ai": dispatch({ type: "CLEAR_PROVIDER_DRAFT" }); dispatch({ type: "SET_PROV_SAVE_STATUS", status: null }); break;
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
          store[it.id] = { rows: parsed.rows, imageRowIndices: parsed.imageRowIndices, discardedColumns: parsed.discardedColumns, file: it.file };
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
    const file = entry.file;

    // A single active provider catalogues each artefact in one multimodal prompt.
    const prov = activeProvider(state.settings);
    if (!prov) {
      dispatch({ type: "SET_PARSE_ERROR", error: "An active AI provider is required — add one in Settings → AI." });
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
        const res = await extractImagesFromXlsx(file, imageRowIndices, sessionId);
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
      pushLog({
        status: "busy",
        jobId,
        label: `Now parsing row ID ${i + 1}`,
        detail: row.id ? `Obj. Number ${row.id}` : row.title,
        verbose: { record: row.record || {} },
      });
      await delay(200); // brief tick so the UI shows processing

      const rowStart = performance.now();
      let ai: Record<string, { value: string; confidence: number }[]>;
      try {
        ai = await catalogueArtefact(prov, state.settings.fields, row.record || {}, row.imagePath, state.settings, `row-${row.uid}`);
      } catch (e) {
        const message = String((e as Error)?.message || e);
        // A per-row Stop cancels only this row: mark it cancelled and carry on
        // to the remaining queued rows. (Distinct from a whole-run cancel, which
        // is fail-stop on the loop itself.) Any other error stays fail-fast.
        if (message === CANCEL_ERROR) {
          dispatch({ type: "SET_ROW_STATUS", uid: row.uid, status: "cancelled" });
          pushLog({ status: "ok", jobId, label: `Row ${i + 1} cancelled`, detail: row.id ? `Obj. Number ${row.id}` : row.title, elapsedMs: Math.round(performance.now() - rowStart) });
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
            Object.entries(ai).map(([k, v]) => [k, (v || []).map((s) => `${s.value} (${Math.round(s.confidence * 100)}%)`).join(" · ")])
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
      dispatch({ type: "SET_PARSE_ERROR", error: "An active AI provider is required — add one in Settings → AI." });
      return;
    }

    // Clear the stale batch banner from the original Parse; a retry outcome is
    // reflected on the row itself, not the global error.
    dispatch({ type: "SET_PARSE_ERROR", error: null });

    const jobId = `row-${row.uid}`;
    dispatch({ type: "SET_ROW_STATUS", uid: row.uid, status: "processing" });
    pushLog({
      status: "busy",
      jobId,
      label: "Retrying row",
      detail: row.id ? `Obj. Number ${row.id}` : row.title,
      verbose: { record: row.record || {} },
    });

    const start = performance.now();
    try {
      const ai = await catalogueArtefact(prov, state.settings.fields, row.record || {}, row.imagePath, state.settings, `row-${row.uid}`);
      dispatch({ type: "SET_ROW_STATUS", uid: row.uid, status: "done", ai });
      pushLog({
        status: "ok",
        jobId,
        label: "Populated into cataloguing fields",
        detail: `${Object.keys(ai).length} fields`,
        elapsedMs: Math.round(performance.now() - start),
        verbose: {
          record: Object.fromEntries(
            (Object.entries(ai) as [string, { value: string; confidence: number }[]][]).map(([k, v]) => [k, (v || []).map((s) => `${s.value} (${Math.round(s.confidence * 100)}%)`).join(" · ")])
          ),
        },
      });
    } catch (e) {
      const message = String((e as Error)?.message || e);
      // A cancel is a user action, not a failure: mark the row cancelled and
      // stay quiet in the logs (Stop has no error to surface).
      if (message === CANCEL_ERROR) {
        dispatch({ type: "SET_ROW_STATUS", uid: row.uid, status: "cancelled" });
        pushLog({ status: "ok", jobId, label: "Row cancelled", detail: row.id ? `Obj. Number ${row.id}` : row.title });
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

  const exportResults = useCallback(async () => {
    const { results, settings, aiResults, fieldSelections } = state;
    // Header labels for the id/title/category columns follow the configured
    // field names so export stays in lock-step with Settings.
    const roles = roleFieldNames(settings.artefactFields || []);
    const hdrs = [roles.id || "Obj. Number", roles.title || "Title", roles.category || "Category", ...settings.fields.map((f) => f.name)];
    const rows = results
      .filter((r) => r.status === "done")
      .map((r) => {
        const ai = aiResults[r.uid] || {};
        const vals = settings.fields.map((f) => {
          const sel = fieldSelections[`${r.uid}_${f.id}`];
          return sel ? sel.value : ai[f.name]?.[0]?.value || "";
        });
        return [r.id, r.title, r.category, ...vals];
      });
    const csv = [hdrs, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");

    try {
      const target = await save({ defaultPath: "artefact_catalogue.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
      if (target) {
        await writeTextFile(target, csv);
      }
    } catch {
      // Fallback: data URL download (e.g. if the dialog plugin is unavailable).
      const a = document.createElement("a");
      a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
      a.download = "artefact_catalogue.csv";
      a.click();
    }
  }, [state]);

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
    (key: string, value: string, source: "ai" | "vocab" | "manual", listName: string, confidence: number | null) =>
      dispatch({ type: "TOGGLE_FIELD_VALUE", key, value, source, listName, confidence }),
    [dispatch]
  );
  const clearField = useCallback((key: string) => dispatch({ type: "CLEAR_FIELD", key }), [dispatch]);
  const setOpenFieldValue = useCallback((key: string, val: string) => dispatch({ type: "SET_OPEN_VALUE", key, value: val }), [dispatch]);

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
  const updateSystemPromptInstruction = useCallback((value: string) => {
    patchDraft((d) => ({ ...d, systemPromptInstruction: value }));
  }, [patchDraft]);
  const updateSystemPromptContract = useCallback((value: string) => {
    patchDraft((d) => ({ ...d, systemPromptContractOverride: value }));
  }, [patchDraft]);
  const setContractEditing = useCallback((editing: boolean) => dispatch({ type: "SET_CONTRACT_EDITING", editing }), [dispatch]);
  const overrideContract = useCallback(async () => {
    // Gate editing the locked output contract behind a warning confirmation,
    // since a malformed contract stops the app from parsing AI responses. On
    // confirm, seed the override with the default (so editing starts from a
    // known-good text) and unlock the box.
    const ok = await confirmDelete({
      title: "Override output contract?",
      message: "This contract tells the AI how to format its answer so the app can read it. Editing it can stop responses from being parsed. Only continue if you know what you're doing.",
      confirmLabel: "Override",
    });
    if (!ok) return;
    const current = state.fieldDraft?.systemPromptContractOverride ?? state.settings.systemPromptContractOverride ?? "";
    if (!current) updateSystemPromptContract(_DEF_SYSTEM_PROMPT_CONTRACT);
    setContractEditing(true);
  }, [confirmDelete, state.fieldDraft, state.settings.systemPromptContractOverride, updateSystemPromptContract, setContractEditing]);
  const addVocabSrc = useCallback((fId: string, vId: string) => {
    patchDraft((d) => ({ ...d, fields: d.fields.map((f) => (f.id === fId ? { ...f, vocabSources: [...f.vocabSources, vId] } : f)) }));
  }, [patchDraft]);
  const removeVocabSrc = useCallback((fId: string, sId: string) => {
    patchDraft((d) => ({ ...d, fields: d.fields.map((f) => (f.id === fId ? { ...f, vocabSources: f.vocabSources.filter((id) => id !== sId) } : f)) }));
  }, [patchDraft]);

  // --- per-card save/discard (catalogue fields + the two prose cards) ---
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

  const saveSystemInstruction = useCallback(async () => {
    const draft = state.fieldDraft;
    if (!draft) return;
    dispatch({ type: "SET_FIELD_CARD_STATUS", id: "system-instruction", status: "saving" });
    const newSettings: Settings = { ...state.settings, systemPromptInstruction: draft.systemPromptInstruction };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      dispatch({ type: "SET_FIELD_CARD_STATUS", id: "system-instruction", status: "ok" });
    } catch {
      dispatch({ type: "SET_FIELD_CARD_STATUS", id: "system-instruction", status: "err" });
    }
  }, [state.fieldDraft, state.settings, state.darkMode, state.zoom, dispatch]);

  const discardSystemInstruction = useCallback(() => {
    const draft = state.fieldDraft;
    if (!draft) return;
    dispatch({ type: "SET_FIELD_CARD_STATUS", id: "system-instruction", status: null });
    dispatch({ type: "PATCH_FIELD_DRAFT", patch: (d) => ({ ...d, systemPromptInstruction: state.settings.systemPromptInstruction }) });
  }, [state.fieldDraft, state.settings.systemPromptInstruction, dispatch]);

  const saveContract = useCallback(async () => {
    const draft = state.fieldDraft;
    if (!draft) return;
    dispatch({ type: "SET_FIELD_CARD_STATUS", id: "output-contract", status: "saving" });
    const newSettings: Settings = { ...state.settings, systemPromptContractOverride: draft.systemPromptContractOverride };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      // Persisting a custom override locks the box again — mirroring the
      // tab-level save, overriding always starts with Override.
      dispatch({ type: "SET_CONTRACT_EDITING", editing: false });
      dispatch({ type: "SET_FIELD_CARD_STATUS", id: "output-contract", status: "ok" });
    } catch {
      dispatch({ type: "SET_FIELD_CARD_STATUS", id: "output-contract", status: "err" });
    }
  }, [state.fieldDraft, state.settings, state.darkMode, state.zoom, dispatch]);

  const discardContract = useCallback(() => {
    const draft = state.fieldDraft;
    if (!draft) return;
    dispatch({ type: "SET_FIELD_CARD_STATUS", id: "output-contract", status: null });
    dispatch({ type: "PATCH_FIELD_DRAFT", patch: (d) => ({ ...d, systemPromptContractOverride: state.settings.systemPromptContractOverride ?? "" }) });
    dispatch({ type: "SET_CONTRACT_EDITING", editing: false });
  }, [state.fieldDraft, state.settings.systemPromptContractOverride, dispatch]);
  // Append an empty catalogue-field row directly into the draft and expand it,
  // mirroring startAddProv — the user fills it in inline rather than via a
  // separate "New Field" form. FieldsTab scrolls the new row into view.
  const startAddField = useCallback(() => {
    const id = gid();
    patchDraft((d) => ({ ...d, fields: [...d.fields, { id, name: "", type: "open", layout: "row", prompt: "", vocabSources: [] }] }));
    dispatch({ type: "TOGGLE_SF", id });
  }, [patchDraft, dispatch]);

  // --- settings: vocab ---
  // Vocab uploads buffer in a draft for per-card save; renames commit per-card.
  // Reorders and deletes persist immediately (no banner).
  const addVocabFiles = useCallback(async (list: FileList | File[]) => {
    const ok = Array.from(list).filter((f) => /\.(xlsx|xls|csv)$/i.test(f.name));
    if (!ok.length) return;
    const items = await Promise.all(ok.map((f) => makeVocabList(f)));
    patchVocabDraft((d) => ({ ...d, vocabularyLists: [...d.vocabularyLists, ...items] }));
    // Expand newly-uploaded rows so the editor is immediately visible,
    // mirroring startAddField's "patch draft, then toggle-expand" convention.
    for (const item of items) dispatch({ type: "TOGGLE_VOCAB", id: item.id });
  }, [patchVocabDraft, dispatch]);

  const onVocabClick = useCallback(() => ensureInput(".xlsx,.xls,.csv", (fl) => void addVocabFiles(fl)), [ensureInput, addVocabFiles]);
  const setVocabDrag = useCallback((drag: boolean) => dispatch({ type: "SET_VOCAB_DRAG", drag }), [dispatch]);
  const { onDragOver: onVocabDragOver, onDragLeave: onVocabDragLeave, onDrop: onVocabDrop } = useDropZone(setVocabDrag, (fl) => void addVocabFiles(fl));

  const removeVocabList = useCallback(async (id: string) => {
    const live = state.vocabDraft ?? vocabDraftFromSettings(state.settings);
    const label = live.vocabularyLists.find((v) => v.id === id)?.name || "this vocabulary list";
    const ok = await confirmDelete({
      title: "Delete vocabulary list?",
      message: `Delete "${label}"? This immediately removes the list.`,
    });
    if (!ok) return;
    // Remove from persisted settings, pruning dangling vocabSource references.
    const remaining = state.settings.vocabularyLists.filter((v) => v.id !== id);
    const fields = state.settings.fields.map((f) => ({ ...f, vocabSources: f.vocabSources.filter((sid) => sid !== id) }));
    const newSettings: Settings = { ...state.settings, vocabularyLists: remaining, fields };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      // Mirror into drafts so any pending edits stay consistent.
      if (state.vocabDraft) {
        patchVocabDraft((d) => ({ ...d, vocabularyLists: d.vocabularyLists.filter((v) => v.id !== id) }));
      }
      dispatch({ type: "PATCH_FIELD_DRAFT", patch: (d) => ({ ...d, fields: d.fields.map((f) => ({ ...f, vocabSources: f.vocabSources.filter((sid) => sid !== id) })) }) });
    } catch { console.error("[artefact] removeVocabList: save failed"); }
  }, [state.vocabDraft, state.settings, state.darkMode, state.zoom, patchVocabDraft, dispatch, confirmDelete]);
  const toggleVocab = useCallback((id: string) => dispatch({ type: "TOGGLE_VOCAB", id }), [dispatch]);
  const updateVocabName = useCallback((id: string, name: string) => {
    patchVocabDraft((d) => ({ ...d, vocabularyLists: d.vocabularyLists.map((v) => (v.id === id ? { ...v, name } : v)) }));
  }, [patchVocabDraft]);
  const reorderVocab = useCallback(async (ids: string[]) => {
    // Only reorder persisted rows; skip any draft-only ids (new unsaved uploads).
    const savedLists = state.settings.vocabularyLists;
    const savedById = new Map(savedLists.map((v) => [v.id, v] as const));
    const reorderedSavedIds = ids.filter((id) => savedById.has(id));
    if (reorderedSavedIds.length !== savedLists.length) return;
    const reorderedSaved = reorderedSavedIds.map((id) => savedById.get(id)!);
    const newSettings: Settings = { ...state.settings, vocabularyLists: reorderedSaved };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      // Mirror reorder into draft using draft values, preserving pending renames.
      patchVocabDraft((d) => {
        const draftById = new Map(d.vocabularyLists.map((v) => [v.id, v] as const));
        const reorderedDraft = ids.map((id) => draftById.get(id)).filter((v): v is (typeof d.vocabularyLists)[number] => !!v);
        return reorderedDraft.length === d.vocabularyLists.length ? { ...d, vocabularyLists: reorderedDraft } : d;
      });
    } catch { console.error("[artefact] reorderVocab: save failed"); }
  }, [state.settings, state.darkMode, state.zoom, patchVocabDraft, dispatch]);

  // --- per-card save/discard (vocab inline editor) ---
  // A single list's rename is committed/reverted in isolation; list deletes
  // and uploads stay buffered for the tab-level Apply.
  const saveVocabCard = useCallback(async (id: string) => {
    const draft = state.vocabDraft;
    if (!draft) return;
    const card = draft.vocabularyLists.find((v) => v.id === id);
    if (!card) return;
    dispatch({ type: "SET_VOCAB_CARD_STATUS", id, status: "saving" });
    // Upsert: replace if the list already persists, else append (a freshly
    // uploaded list isn't in settings yet).
    const persisted = state.settings.vocabularyLists.some((v) => v.id === id);
    const vocabularyLists = persisted
      ? state.settings.vocabularyLists.map((v) => (v.id === id ? { ...card } : v))
      : [...state.settings.vocabularyLists, { ...card }];
    const newSettings: Settings = { ...state.settings, vocabularyLists };
    try {
      await saveState(newSettings, state.darkMode, state.zoom);
      dispatch({ type: "SET_SETTINGS", settings: newSettings });
      dispatch({ type: "PATCH_VOCAB_DRAFT", patch: (d) => ({ ...d, vocabularyLists: d.vocabularyLists.map((v) => (v.id === id ? { ...card } : v)) }) });
      dispatch({ type: "SET_VOCAB_CARD_STATUS", id, status: "ok" });
    } catch {
      dispatch({ type: "SET_VOCAB_CARD_STATUS", id, status: "err" });
    }
  }, [state.vocabDraft, state.settings, state.darkMode, state.zoom, dispatch]);

  const discardVocabCard = useCallback((id: string) => {
    const draft = state.vocabDraft;
    if (!draft) return;
    const saved = state.settings.vocabularyLists.find((v) => v.id === id);
    dispatch({ type: "SET_VOCAB_CARD_STATUS", id, status: null });
    if (!saved) {
      // A freshly uploaded list has no persisted value — drop it.
      dispatch({ type: "PATCH_VOCAB_DRAFT", patch: (d) => ({ ...d, vocabularyLists: d.vocabularyLists.filter((v) => v.id !== id) }) });
      return;
    }
    dispatch({ type: "PATCH_VOCAB_DRAFT", patch: (d) => ({ ...d, vocabularyLists: d.vocabularyLists.map((v) => (v.id === id ? { ...saved } : v)) }) });
  }, [state.vocabDraft, state.settings.vocabularyLists, dispatch]);

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
    // "Set Active" is card-owned: this card's Save also commits the
    // active-selection when the user made this provider active. (Only this card
    // can have flipped active to itself, so scoping it here is correct.)
    const activeProvider = draft.activeProvider === id ? id : state.settings.activeProvider;
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
    // "Set Active" is card-owned, so if the user made this card active,
    // reverting also restores the persisted active selection. (Only this card
    // can have flipped active to itself.)
    const wasSetActive = draft.activeProvider === id && state.settings.activeProvider !== id;
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
        activeProvider: wasSetActive ? state.settings.activeProvider : d.activeProvider,
      }),
    });
  }, [state.providerDraft, state.settings.providers, state.settings.activeProvider, mapDraftEntry, dispatch]);

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

  const setActiveProv = useCallback((id: string) => {
    // "Set Active" is card-owned: the selection is buffered into the draft and
    // committed when that card's own Save runs. Clear the card's stale status so
    // a prior "Saved" doesn't linger once it becomes dirty from the flip.
    dispatch({ type: "SET_PROV_CARD_STATUS", id, status: null });
    patchProvDraft((d) => ({ ...d, activeProvider: id }));
  }, [patchProvDraft, dispatch]);

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
  const updateAF = useCallback((id: string, key: EditableArtefactFieldKey, value: string | boolean) => {
    patchArtefactDraft((d) => ({ ...d, artefactFields: d.artefactFields.map((f) => (f.id === id ? { ...f, [key]: value } : f)) }));
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
    patchArtefactDraft((d) => ({ ...d, artefactFields: [...d.artefactFields, { id, name: "", required: false, description: "" }] }));
    dispatch({ type: "TOGGLE_AF", id });
  }, [patchArtefactDraft, dispatch]);

  // --- per-card save/discard (artefact columns) ---
  // One column's content (name/required/description) persists or reverts on its
  // own; adds/deletes/reorders stay buffered for the tab-level Apply.
  const saveArtefactCard = useCallback(async (id: string) => {
    const draft = state.artefactDraft;
    if (!draft) return;
    const card = draft.artefactFields.find((f) => f.id === id);
    if (!card) return;
    dispatch({ type: "SET_ARTEFACT_CARD_STATUS", id, status: "saving" });
    // Upsert: replace if the column already persists, else append (a newly
    // added column isn't in settings yet).
    const base = state.settings.artefactFields || _DEF_AF;
    const persisted = base.some((f) => f.id === id);
    const artefactFields = persisted
      ? base.map((f) => (f.id === id ? { ...card, description: card.description ?? "" } : f))
      : [...base, { ...card, description: card.description ?? "" }];
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
    dispatch({ type: "PATCH_ARTEFACT_DRAFT", patch: (d) => ({ ...d, artefactFields: d.artefactFields.map((f) => (f.id === id ? { ...saved, description: saved.description ?? "" } : f)) }) });
  }, [state.artefactDraft, state.settings.artefactFields, dispatch]);

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
    const parsed = SettingsSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first.path.length ? ` at ${first.path.join(".")}` : "";
      alert(`Invalid settings file${path}: ${first.message}`);
      return;
    }
    const imp = parsed.data;
    if (imp.vocabularyLists) {
      imp.vocabularyLists = imp.vocabularyLists.map((vl) => ({
        ...vl,
        filename: vl.filename.replace(/\.[^.]+$/, ".csv"),
        terms: vl.termData ? vl.termData.length : (vl.terms || 0),
      }));
    }
    patch(() => withDefaultSettings(imp));
  }, [patch]);

  return {
    toggleDark, goMain, goSettings, setTab, zoomIn, zoomOut, toggleLogs, setLogsOpen,
    onUploadClick, addAnotherFile, onDragOver, onDragLeave, onDrop, removeFile, startParse, pauseParse, resumeParse, cancelParse, dismissParseError, resetUpload, retryRow, stopRow, retryAllFailed, onResizeStart,
    toggleRow, setFilter, setSearch, exportResults, onTriggerClick, setFieldSearch, toggleFieldValue, clearField, setOpenFieldValue,
    toggleSF, reorderFields, removeField, updateField, updateSystemPromptInstruction, updateSystemPromptContract, setContractEditing, overrideContract, addVocabSrc, removeVocabSrc, saveFieldCard, discardFieldCard, saveSystemInstruction, discardSystemInstruction, saveContract, discardContract, startAddField, toggleProv,
    onVocabClick, onVocabDragOver, onVocabDragLeave, onVocabDrop, removeVocabList, toggleVocab, updateVocabName, reorderVocab, saveVocabCard, discardVocabCard,
    startAddProv, setProvF, setProvModel, setProvApiFormat, toggleProvKey, testConn, saveProviders, discardProviders, deleteProv, setActiveProv, saveProvCard, discardProvCard,
    toggleAF, reorderAF, updateAF, removeAF, startAddAF, saveArtefactCard, discardArtefactCard,
    exportSettings, importSettings,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
