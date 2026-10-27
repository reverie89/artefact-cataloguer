// App state shape + reducer, mirroring the reference DCLogic component.
// Persistence (load/save beside the binary) is handled in store.ts and wired
// by an effect in App.tsx.

import { _DEF, _DEF_AF, IMAGE_PANE_W, SOURCE_LABEL_W } from "./defaults";
import type { SaveState } from "../components/settings/SaveActions.types";
import type { VocabTermEntry } from "../lib/vocab";
import type { AiResults, AiSuggestion, ApiFormat, ArtefactField, ArtefactRow, CatalogueField, EmbeddingApiFormat, FieldSelection, Screen, Settings, SettingsTab, ThinkingEffort, VocabSource } from "./types";

/** One editable provider row in the unified providers draft. Mirrors a
 *  persisted Provider, plus the model list discovered by a successful Test
 *  Connection (kept here so the Model dropdown stays populated across edits). */
export type ProviderDraftEntry = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: ApiFormat;
  /** Model ids returned by a successful Test Connection for this row. Empty
   *  until the endpoint has been reached. */
  modelOptions: string[];
  /** Last persisted connection-test outcome for this row. Mirrors
   *  Provider.connStatus; seeded as "untested" until a Test Connection has run.
   *  Persists on Save (alongside modelOptions), so the Status column survives a
   *  restart. The live "testing" state lives in the separate `provStatus` map. */
  connStatus: "ok" | "err" | "untested";
  /** Reasoning effort for thinking-capable models. `null` = off (send no
   *  thinking fields); made concrete here so the Segmented control always has a
   *  value, mirroring how apiFormat/connStatus are defaulted. */
  thinking: ThinkingEffort | null;
  /** Custom format only: header name carrying the API key; "" = Bearer. */
  authHeader: string;
  /** Custom format only: the JSON request body with an {{input}} token. */
  bodyTemplate: string;
};

/** In-memory draft of the editable parts of the Cataloguing Fields tab. Unlike
 *  `PATCH_SETTINGS` (which persists on every keystroke), edits accumulate here
 *  and are only written to disk when the user clicks Save — mirroring the
 *  providers draft layer. `null` means "no pending edits; render settings".
 *  The unified System Prompt moved to the Artefact File tab (Override-gated),
 *  so this draft now carries only the per-field list. */
export type FieldDraft = {
  fields: CatalogueField[];
};

/** In-memory draft of the whole Model Providers tab — a snapshot of providers +
 *  the active selection that edits accumulate against until Save. `null` means
 *  "no pending edits; render settings". Mirrors FieldDraft. */
export type ProviderDraft = {
  providers: ProviderDraftEntry[];
  activeProvider: string | null;
};

/** In-memory draft of the Vocabulary Lists tab. Uploaded/renamed/deleted
 *  sources (and their files/fields) accumulate here and persist only on Save
 *  — mirrors FieldDraft/ProviderDraft. `null` means "no pending edits; render
 *  settings". */
export type VocabDraft = {
  vocabSources: VocabSource[];
};

/** One editable embedding-provider row in the unified embedding-providers
 *  draft. Mirrors ProviderDraftEntry. */
export type EmbeddingProviderDraftEntry = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: EmbeddingApiFormat;
  modelOptions: string[];
  /** Advertised image-input ids from the last Test Connection; `null` when
   *  unknown (no metadata or never tested). */
  imageInputModels: string[] | null;
  connStatus: "ok" | "err" | "untested";
};

/** In-memory draft of the whole Embedding Providers section — mirrors
 *  ProviderDraft. `null` means "no pending edits; render settings". */
export type EmbeddingProviderDraft = {
  providers: EmbeddingProviderDraftEntry[];
  activeProvider: string | null;
};

/** In-memory draft of the Artefact File tab's required-column config + the
 *  artefact-analysis system instruction. Mirrors the other drafts; `null` means
 *  "no pending edits; render settings". */
export type ArtefactDraft = {
  artefactAnalysisSystemPromptInstruction: string;
  artefactFields: ArtefactField[];
};

/** Editable keys of an existing catalogue-field row (vocabSources is handled by
 *  add/remove-vocab-source actions, not the generic setter). */
export type EditableCatalogueFieldKey = "name" | "type" | "prompt" | "maxComponents";

/** Editable keys of an existing artefact-column row. */
export type EditableArtefactFieldKey = "name" | "description" | "prompt" | "includeForAI" | "includeInExport" | "useColumnLetter" | "column";

export interface AppState {
  darkMode: boolean;
  screen: Screen;
  settingsTab: SettingsTab;
  loaded: boolean;

  // Files / import + results
  /** Transient import surface only: files currently being parsed ("validating")
   *  and rejected files ("invalid", until dismissed). Valid files never linger —
   *  their records move straight into `results` (grouped by fileId there). */
  files: UploadFile[];
  uploadDragOver: boolean;
  /** The parsed records — also the catalogue queue (rows carry a `status`). */
  results: ArtefactRow[];
  expandedRows: Record<string, boolean>;
  fieldSelections: Record<string, FieldSelection>;
  fieldDropdownOpen: Record<string, boolean>;
  fieldDropdownSearch: Record<string, string>;
  resultsFilter: string;
  resultsSearch: string;
  /** Which artefact-file column ids the results search matches against. New
   *  columns default to included; the user can deselect any in the Results
   *  column picker. Kept as ids (not names) so a column rename doesn't drop it
   *  from the search scope. */
  searchColsAf: string[];
  /** Which catalogue-field ids the results search matches against — mirrors
   *  `searchColsAf` for the FieldsTab columns. */
  searchColsCat: string[];
  aiResults: AiResults;
  /** Fatal catalogue-config error that blocked starting the queue, if any. */
  parseError: string | null;
  /** Transient warning surfaced when export can't proceed (e.g. no artefact
   *  columns selected for export). Rendered beside `parseError` in the results
   *  panel; dismissed by the user or cleared on a successful export. */
  exportWarning: string | null;
  /** Whether the catalogue queue drainer (startQueue) is alive. Drives the
   *  header Stop button; queued rows survive a stop so Start or Retry can
   *  resume. */
  queueRunning: boolean;
  /** Monotonic source of row queue tickets (ArtefactRow.queueTicket): the
   *  queue is served in Start/Retry click order, not results-list order.
   *  Session-only, like results. */
  nextQueueTicket: number;
  /** Live pipeline position for an in-flight `catalogue_artefact` run, keyed
   *  by row uid — transient (not persisted), mirroring `vocabSyncProgress`.
   *  `step`/`total` count the row's pipeline stages (ai.rs `stage_plan`).
   *  Absent = not processing or the first event hasn't arrived. */
  catalogueProgress: Record<string, { step: number; total: number }>;

  // Settings
  settings: Settings;
  settingsFieldExpanded: Record<string, boolean>;
  /** Which vocab list rows are expanded, keyed by id — mirrors
   *  settingsFieldExpanded for the collapsible vocab rows. */
  settingsVocabExpanded: Record<string, boolean>;
  /** Which provider cards are expanded, keyed by id — mirrors
   *  settingsFieldExpanded for collapsible AI Provider cards. */
  providerExpanded: Record<string, boolean>;
  /** Vocabulary Lists tab deferred draft. Only a source's Display Name is
   *  draft-buffered — files/fields/sync have real Rust-side disk effects and
   *  persist immediately (mirrors reorderVocab/removeVocabList), so they're
   *  never part of this draft. */
  vocabDraft: VocabDraft | null;
  /** Per-card save status for the Vocab inline editor (keyed by source id). Also
   *  used to surface Add-file(s) failures, since staging has the same
   *  real-disk-effect/no-draft shape as the card Save. */
  vocabCardSaveStatus: Record<string, SaveState>;
  /** Specific reason a vocab card's Save or Add-file(s) failed (keyed by source
   *  id), shown in place of the generic "Not saved". Cleared on the next
   *  successful/again attempt. */
  vocabCardError: Record<string, string>;
  /** Live progress for an in-flight `sync_vocab_source` run, keyed by source
   *  id — transient (not persisted); the source's `embedding` status in
   *  settings is what survives a restart. Absent = no sync in flight.
   *  `fileProgress` carries the per-file breakdown of the source totals
   *  (keyed by filename) when the source has more than one file. */
  vocabSyncProgress: Record<string, { rowsDone: number; rowsTotal: number; fileProgress?: Record<string, { rowsDone: number; rowsTotal: number }> }>;
  /** Full term list fetched from a synced source's LanceDB table, keyed by
   *  source id — transient (not persisted), populated on demand by
   *  `ensureVocabTermsLoaded` and consumed by `vterms` (app/styles.ts) to
   *  drive the manual vocab-picker dropdown. Absent = not yet fetched. */
  vocabTermCache: Record<string, VocabTermEntry[]>;
  /** Source ids with a `listVocabTerms` fetch currently in flight, so
   *  `ensureVocabTermsLoaded` doesn't fire a duplicate concurrent request. */
  vocabTermCacheLoading: Record<string, boolean>;

  // Providers form — a single unified draft (mirrors fieldDraft): per-card
  // content edits accumulate here and persist on the card's own Save, while
  // structural changes (delete, set-active, reorder) persist immediately.
  // `provStatus` is the one piece kept separate: it is transient per-row Test
  // Connection verification, not part of the draft.
  providerDraft: ProviderDraft | null;
  provStatus: Record<string, { test: "testing" | "ok" | "err" | null; error?: string }>;
  /** Per-card save status for a provider card (keyed by provider id). A card's
   *  own Save persists only that provider; its outcome surfaces here. */
  provCardSaveStatus: Record<string, SaveState>;
  /** Specific reason a provider card's Save failed (keyed by provider id), shown
   *  in place of the generic "Not saved". Cleared on the next successful/again
   *  Save attempt. */
  provCardError: Record<string, string>;
  showProvKey: boolean;

  // Embedding Providers section (Model Providers tab) — mirrors the providers
  // draft block above exactly, one field at a time, for the separate
  // embedding-model list.
  embProviderDraft: EmbeddingProviderDraft | null;
  embProviderExpanded: Record<string, boolean>;
  embProvStatus: Record<string, { test: "testing" | "ok" | "err" | null; error?: string }>;
  embProvCardSaveStatus: Record<string, SaveState>;
  embProvCardError: Record<string, string>;
  showEmbProvKey: boolean;

  // Catalogue field edits — a deferred draft (mirrors providerDraft). Field
  // edits/adds/deletes accumulate here until the tab-level Save; rows expand on
  // click via settingsFieldExpanded. New fields are added as expanded rows
  // directly into the draft (mirrors ProvidersTab), not via a separate form.
  /** Per-card save status for a catalogue-field row or Fields prose card (keyed
   *  by field id, or the stable keys `system-instruction` / `output-contract`
   *  for the two prose cards). A card's own Save persists only that card. */
  fieldCardSaveStatus: Record<string, SaveState>;
  /** Pending catalogue-field edits (system prompt + fields list). Persisted only
   *  on explicit Save; `null` while there are no unsaved edits. */
  fieldDraft: FieldDraft | null;
  /** Transient gate: when true the locked output-contract (Part 2) box is
   *  editable. Always reset to false on Save or Discard, so overriding it
   *  always requires pressing Override first. */
  contractEditing: boolean;

  // Artefact field editing — deferred draft (mirrors fieldDraft). Column
  // edits/adds/deletes buffer here until the tab-level Save; rows expand on
  // click via artefactFieldExpanded (mirrors settingsFieldExpanded). New
  // columns are added as expanded rows directly into the draft (mirrors
  // ProvidersTab), not via a separate form.
  artefactDraft: ArtefactDraft | null;
  /** Per-card save status for an artefact-column row (keyed by column id). A
   *  card's own Save persists only that column. */
  artefactCardSaveStatus: Record<string, SaveState>;
  artefactFieldExpanded: Record<string, boolean>;

  // Logs Viewer drawer
  logsOpen: boolean;

  zoom: number;

  // Main-screen Source Record geometry, persisted in the bundle; the clamps
  // live in defaults.ts (SOURCE_LABEL_W / IMAGE_PANE_W).
  sourceLabelW: number;
  imagePaneW: number;
}

export interface UploadFile {
  id: string;
  name: string;
  size: number;
  sizeLabel: string;
  status: "validating" | "invalid";
  errors: { message: string }[];
}

export const initialState: AppState = {
  darkMode: true,
  screen: "main",
  settingsTab: "about",
  loaded: false,

  files: [],
  uploadDragOver: false,
  results: [],
  expandedRows: {},
  fieldSelections: {},
  fieldDropdownOpen: {},
  fieldDropdownSearch: {},
  resultsFilter: "all",
  resultsSearch: "",
  // Empty at init; the INIT reducer seeds it from the loaded settings' column
  // ids via reconcileSearchCols (every column searchable by default).
  searchColsAf: [],
  searchColsCat: [],
  aiResults: {},
  parseError: null,
  exportWarning: null,
  queueRunning: false,
  nextQueueTicket: 0,
  catalogueProgress: {},

  settings: _DEF(),
  settingsFieldExpanded: {},
  settingsVocabExpanded: {},
  providerExpanded: {},
  vocabDraft: null,
  vocabCardSaveStatus: {},
  vocabCardError: {},
  vocabSyncProgress: {},
  vocabTermCache: {},
  vocabTermCacheLoading: {},

  providerDraft: null,
  provStatus: {},
  provCardSaveStatus: {},
  provCardError: {},
  showProvKey: false,

  embProviderDraft: null,
  embProviderExpanded: {},
  embProvStatus: {},
  embProvCardSaveStatus: {},
  embProvCardError: {},
  showEmbProvKey: false,

  fieldCardSaveStatus: {},
  fieldDraft: null,
  contractEditing: false,

  artefactDraft: null,
  artefactCardSaveStatus: {},
  artefactFieldExpanded: {},

  logsOpen: false,

  zoom: 1.0,

  sourceLabelW: SOURCE_LABEL_W.default,
  imagePaneW: IMAGE_PANE_W.default,
};

// --- Actions -----------------------------------------------------------------

export type Action =
  | { type: "INIT"; settings: Settings; darkMode: boolean; zoom: number; sourceLabelW: number; imagePaneW: number }
  | { type: "SET_DARK"; darkMode: boolean }
  | { type: "SET_SCREEN"; screen: Screen }
  | { type: "SET_TAB"; tab: SettingsTab }
  | { type: "SET_ZOOM"; zoom: number }
  | { type: "SET_SOURCE_LABEL_W"; w: number }
  | { type: "SET_IMAGE_PANE_W"; w: number }
  | { type: "SET_LOGS_OPEN"; open: boolean }
  | { type: "SET_FILES"; files: UploadFile[] }
  | { type: "SET_FILE_STATUS"; id: string; status: UploadFile["status"]; errors: { message: string }[] }
  | { type: "REMOVE_FILE"; id: string }
  | { type: "SET_UPLOAD_DRAG"; drag: boolean }
  | { type: "PARSE_FILES"; rows: ArtefactRow[] }
  | { type: "SET_ROW_STATUS"; uid: string; status: ArtefactRow["status"]; ai?: Record<string, AiSuggestion[]> }
  | { type: "REMOVE_ROWS"; uids: string[] }
  | { type: "QUEUE_ROWS"; uids: string[] }
  | { type: "UNQUEUE_ROWS"; uids: string[] }
  | { type: "SET_QUEUE_RUNNING"; running: boolean }
  | { type: "SET_CATALOGUE_PROGRESS"; uid: string; step: number; total: number }
  | { type: "CLEAR_CATALOGUE_PROGRESS"; uid: string }
  | { type: "SET_ROW_IMAGE"; uid: string; imagePath: string }
  | { type: "SET_PARSE_ERROR"; error: string | null }
  | { type: "TOGGLE_ROW"; uid: string }
  | { type: "SET_FILTER"; filter: string }
  | { type: "SET_SEARCH"; search: string }
  | { type: "TOGGLE_SEARCH_COL_AF"; id: string }
  | { type: "TOGGLE_SEARCH_COL_CAT"; id: string }
  | { type: "SET_SEARCH_COLS_AF"; ids: string[] }
  | { type: "SET_SEARCH_COLS_CAT"; ids: string[] }
  | { type: "SET_EXPORT_WARNING"; message: string | null }
  | { type: "SET_FIELD_SEARCH"; key: string; value: string }
  | { type: "OPEN_DD"; key: string }
  | { type: "CLOSE_ALL_DD" }
  | {
      type: "TOGGLE_FIELD_VALUE";
      key: string;
      value: string;
      source: "ai" | "vocab" | "manual";
      listName: string;
      similarity: number | null;
      /** False for single-pick vocab fields (`maxComponents === 1`): the pick
       *  replaces the selection and the dropdown closes. True for
       *  multi-component fields: the pick toggles in/out, dropdown stays open. */
      multi: boolean;
    }
  | { type: "CLEAR_FIELD"; key: string }
  | { type: "SET_OPEN_VALUE"; key: string; value: string }
  | { type: "PATCH_SETTINGS"; patch: (s: Settings) => Settings }
  | { type: "TOGGLE_SF"; id: string }
  | { type: "TOGGLE_VOCAB"; id: string }
  | { type: "TOGGLE_PROV"; id: string }
  | { type: "PATCH_VOCAB_DRAFT"; patch: (d: VocabDraft) => VocabDraft }
  | { type: "CLEAR_VOCAB_DRAFT" }
  | { type: "SET_VOCAB_CARD_STATUS"; id: string; status: SaveState }
  | { type: "SET_VOCAB_CARD_ERROR"; id: string; error: string | null }
  | { type: "SET_VOCAB_SYNC_PROGRESS"; id: string; rowsDone: number; rowsTotal: number; fileProgress?: Record<string, { rowsDone: number; rowsTotal: number }> }
  | { type: "CLEAR_VOCAB_SYNC_PROGRESS"; id: string }
  | { type: "SET_VOCAB_TERMS_LOADING"; id: string }
  | { type: "SET_VOCAB_TERMS"; id: string; terms: VocabTermEntry[] }
  | { type: "CLEAR_VOCAB_TERMS"; id: string }
  | { type: "CLEAR_ALL_VOCAB_TERMS" }
  | { type: "PATCH_PROVIDER_DRAFT"; patch: (d: ProviderDraft) => ProviderDraft }
  | { type: "CLEAR_PROVIDER_DRAFT" }
  | { type: "SET_PROV_STATUS"; id: string; test: "testing" | "ok" | "err" | null; error?: string }
  | { type: "CLEAR_PROV_STATUS"; id: string }
  | { type: "SET_PROV_CARD_STATUS"; id: string; status: SaveState }
  | { type: "SET_PROV_CARD_ERROR"; id: string; error: string | null }
  | { type: "SET_SHOW_PROV_KEY"; show: boolean }
  | { type: "TOGGLE_EMB_PROV"; id: string }
  | { type: "PATCH_EMB_PROVIDER_DRAFT"; patch: (d: EmbeddingProviderDraft) => EmbeddingProviderDraft }
  | { type: "CLEAR_EMB_PROVIDER_DRAFT" }
  | { type: "SET_EMB_PROV_STATUS"; id: string; test: "testing" | "ok" | "err" | null; error?: string }
  | { type: "CLEAR_EMB_PROV_STATUS"; id: string }
  | { type: "SET_EMB_PROV_CARD_STATUS"; id: string; status: SaveState }
  | { type: "SET_EMB_PROV_CARD_ERROR"; id: string; error: string | null }
  | { type: "SET_SHOW_EMB_PROV_KEY"; show: boolean }
  | { type: "SET_FIELD_CARD_STATUS"; id: string; status: SaveState }
  | { type: "PATCH_FIELD_DRAFT"; patch: (d: FieldDraft) => FieldDraft }
  | { type: "CLEAR_FIELD_DRAFT" }
  | { type: "SET_CONTRACT_EDITING"; editing: boolean }
  | { type: "TOGGLE_AF"; id: string }
  | { type: "PATCH_ARTEFACT_DRAFT"; patch: (d: ArtefactDraft) => ArtefactDraft }
  | { type: "CLEAR_ARTEFACT_DRAFT" }
  | { type: "SET_ARTEFACT_CARD_STATUS"; id: string; status: SaveState }
  | { type: "SET_ALL_EXPANDED"; scope: "settingsFieldExpanded" | "settingsVocabExpanded" | "embProviderExpanded" | "artefactFieldExpanded" | "expandedRows"; ids: string[]; expanded: boolean };

/** Keep the search-column scope in step with the settings' column ids: keep
 *  selection for columns that still exist, and add any new columns
 *  (default-on, so a freshly-added column is searchable immediately). Runs on
 *  every settings write — the load path and functional patches alike, since
 *  per-card saves and deletes add/remove columns through PATCH_SETTINGS too. */
function reconcileSearchCols(state: AppState): AppState {
  const afIds = state.settings.artefactFields.map((f) => f.id);
  const catIds = state.settings.fields.map((f) => f.id);
  const searchColsAf = [
    ...state.searchColsAf.filter((id) => afIds.includes(id)),
    ...afIds.filter((id) => !state.searchColsAf.includes(id)),
  ];
  const searchColsCat = [
    ...state.searchColsCat.filter((id) => catIds.includes(id)),
    ...catIds.filter((id) => !state.searchColsCat.includes(id)),
  ];
  return { ...state, searchColsAf, searchColsCat };
}

/** Drop every entry belonging to the given rows from a per-row map. Keys are
 *  either the bare uid (expandedRows, aiResults) or `${uid}_<fieldId>`
 *  (fieldSelections, fieldDropdownOpen/Search). */
function pruneRowEntries<T>(rec: Record<string, T>, uids: Set<string>): Record<string, T> {
  const owned = (k: string) => {
    if (uids.has(k)) return true;
    for (const uid of uids) if (k.startsWith(`${uid}_`)) return true;
    return false;
  };
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (!owned(k)) out[k] = v;
  }
  return out;
}

/** The selection shape once more than one term is picked: the display/export
 *  value is the terms joined, and per-term metadata (source list, similarity)
 *  no longer describes a single term. Shared by manual multi-picks and the
 *  AI-result seeding. */
function multiSelection(values: string[]): FieldSelection {
  return { source: "multi", value: values.join(" | "), values, listName: "", similarity: null };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "INIT":
      // Reconcile so the loaded settings' columns are searchable by default —
      // without this the scope stayed empty after a load and non-empty queries
      // matched nothing until some later settings write happened to reconcile.
      return reconcileSearchCols({ ...state, settings: action.settings, darkMode: action.darkMode, zoom: action.zoom, sourceLabelW: action.sourceLabelW, imagePaneW: action.imagePaneW, loaded: true, fieldDraft: null, providerDraft: null, embProviderDraft: null, vocabDraft: null, artefactDraft: null });
    case "SET_DARK":
      return { ...state, darkMode: action.darkMode };
    case "SET_SCREEN":
      return { ...state, screen: action.screen };
    case "SET_TAB":
      return { ...state, settingsTab: action.tab };
    case "SET_ZOOM":
      return { ...state, zoom: action.zoom };
    case "SET_SOURCE_LABEL_W":
      return { ...state, sourceLabelW: action.w };
    case "SET_IMAGE_PANE_W":
      return { ...state, imagePaneW: action.w };
    case "SET_LOGS_OPEN":
      return { ...state, logsOpen: action.open };

    case "SET_FILES":
      // Additive: imported/rejected file chips join whatever is already listed
      // (a dropped batch must not clobber a batch still parsing, and nothing
      // here may wipe results — rows are only ever removed explicitly).
      return { ...state, files: [...state.files, ...action.files] };
    case "SET_FILE_STATUS": {
      const files = state.files.map((f) =>
        f.id === action.id ? { ...f, status: action.status, errors: action.errors } : f
      );
      return { ...state, files };
    }
    // Drops the file's chip/error card only. Rows are never removed here —
    // their lifecycle is owned by REMOVE_ROWS (per-row delete / delete-all-
    // of-file from the results panel), so an import that removed its own chip
    // can't cascade its freshly added rows away.
    case "REMOVE_FILE":
      return { ...state, files: state.files.filter((f) => f.id !== action.id) };
    case "SET_UPLOAD_DRAG":
      return { ...state, uploadDragOver: action.drag };

    // Imported rows join the results panel as-is (already stamped with
    // fileId/sourceName). Append-only: earlier imports' rows, selections and
    // AI results are never touched. A stale queue pre-flight banner doesn't
    // survive an import — Start re-surfaces it if the config problem persists.
    case "PARSE_FILES":
      return { ...state, results: [...state.results, ...action.rows], parseError: null };
    case "SET_ROW_STATUS": {
      // A row deleted mid-run (per-row delete / delete-all-of-file) must not be
      // resurrected in the per-row maps by its in-flight AI call's write.
      if (!state.results.some((r) => r.uid === action.uid)) return state;
      const results = state.results.map((r) =>
        r.uid === action.uid ? { ...r, status: action.status } : r
      );
      const aiResults =
        action.ai !== undefined ? { ...state.aiResults, [action.uid]: action.ai } : state.aiResults;
      let { fieldSelections } = state;
      if (action.ai !== undefined && action.status === "done") {
        const additions: Record<string, FieldSelection> = {};
        for (const field of state.settings.fields) {
          if (field.type !== "vocab") continue;
          const key = `${action.uid}_${field.id}`;
          if (fieldSelections[key]) continue;
          const sugs = action.ai[field.name];
          if (!sugs || sugs.length === 0) continue;
          // Only the picked suggestions are recorded — `picked: false`
          // alternates are swap choices offered in the field's dropdown,
          // never auto-selected. Legacy payloads without the flag behave
          // exactly as before (every suggestion counts as picked).
          const rec = sugs.filter((s) => s.picked !== false);
          const base = rec.length > 0 ? rec : sugs;
          additions[key] = base.length === 1
            ? { source: "ai", value: base[0].value, values: [base[0].value], listName: "AI", similarity: base[0].similarity ?? null }
            : multiSelection(base.map((s) => s.value));
        }
        if (Object.keys(additions).length > 0) {
          fieldSelections = { ...fieldSelections, ...additions };
        }
      }
      return { ...state, results, aiResults, fieldSelections };
    }
    // Per-row delete / delete-all-of-file: drop the rows and every per-row map
    // entry (expandedRows/aiResults keyed by uid; fieldSelections/fieldDropdown*
    // keyed `${uid}_<fieldId>`).
    case "REMOVE_ROWS": {
      const uids = new Set(action.uids);
      const results = state.results.filter((r) => !uids.has(r.uid));
      if (results.length === state.results.length) return state;
      return {
        ...state,
        results,
        aiResults: pruneRowEntries(state.aiResults, uids),
        expandedRows: pruneRowEntries(state.expandedRows, uids),
        catalogueProgress: pruneRowEntries(state.catalogueProgress, uids),
        fieldSelections: pruneRowEntries(state.fieldSelections, uids),
        fieldDropdownOpen: pruneRowEntries(state.fieldDropdownOpen, uids),
        fieldDropdownSearch: pruneRowEntries(state.fieldDropdownSearch, uids),
      };
    }
    // Queueing: flip the listed rows to `queued` in one dispatch so a Start/
    // Retry click visibly queues everything at once. Each newly-queued row
    // takes the next ticket (list order within one click) and the drainer
    // runs lowest ticket first — so queue order is click order, and a row
    // queued mid-run waits behind everything already queued regardless of
    // its position in the results list. `queued`/`processing` rows are
    // untouched (their owner owns that status — and their ticket).
    case "QUEUE_ROWS": {
      const uids = new Set(action.uids);
      let ticket = state.nextQueueTicket;
      const results = state.results.map((r) =>
        uids.has(r.uid) && r.status !== "queued" && r.status !== "processing"
          ? { ...r, status: "queued" as const, queueTicket: ++ticket }
          : r
      );
      return { ...state, results, nextQueueTicket: ticket };
    }
    // Unqueueing: flip the listed rows back to `ready` and drop their tickets
    // (a later re-queue takes fresh ones). Stop empties the whole work list
    // (under auto-drain a leftover queued row would resume instantly) and a
    // queued row's Stop leaves it without waiting for the drainer. Non-queued
    // rows are untouched (their owner owns that status).
    case "UNQUEUE_ROWS": {
      const uids = new Set(action.uids);
      return {
        ...state,
        results: state.results.map((r) =>
          uids.has(r.uid) && r.status === "queued"
            ? { ...r, status: "ready", queueTicket: undefined }
            : r
        ),
      };
    }
    case "SET_QUEUE_RUNNING":
      return { ...state, queueRunning: action.running };
    case "SET_ROW_IMAGE":
      return {
        ...state,
        results: state.results.map((r) => (r.uid === action.uid ? { ...r, imagePath: action.imagePath } : r)),
      };

    case "SET_PARSE_ERROR":
      return { ...state, parseError: action.error };

    case "TOGGLE_ROW": {
      const expandedRows = { ...state.expandedRows };
      expandedRows[action.uid] = !expandedRows[action.uid];
      return { ...state, expandedRows };
    }
    case "SET_FILTER":
      return { ...state, resultsFilter: action.filter };
    case "SET_SEARCH":
      return { ...state, resultsSearch: action.search };
    case "TOGGLE_SEARCH_COL_AF": {
      // Per-item toggle in the column picker. Symmetric with SET_SEARCH_COLS_*
      // (Clear/All): an empty scope is a legal state — when the user searches
      // it, the results list shows a discoverable empty-state hint rather than
      // every row.
      const has = state.searchColsAf.includes(action.id);
      const next = has
        ? state.searchColsAf.filter((id) => id !== action.id)
        : [...state.searchColsAf, action.id];
      return { ...state, searchColsAf: next };
    }
    case "TOGGLE_SEARCH_COL_CAT": {
      const has = state.searchColsCat.includes(action.id);
      const next = has
        ? state.searchColsCat.filter((id) => id !== action.id)
        : [...state.searchColsCat, action.id];
      return { ...state, searchColsCat: next };
    }
    case "SET_SEARCH_COLS_AF":
      return { ...state, searchColsAf: action.ids };
    case "SET_SEARCH_COLS_CAT":
      return { ...state, searchColsCat: action.ids };
    case "SET_EXPORT_WARNING":
      return { ...state, exportWarning: action.message };
    case "SET_FIELD_SEARCH":
      return { ...state, fieldDropdownSearch: { ...state.fieldDropdownSearch, [action.key]: action.value } };
    case "OPEN_DD":
      return { ...state, fieldDropdownOpen: { [action.key]: true } };
    case "CLOSE_ALL_DD":
      return { ...state, fieldDropdownOpen: {} };
    case "TOGGLE_FIELD_VALUE": {
      // Single-pick vocab fields (maxComponents 1): the pick replaces the
      // selection and the dropdown closes — there is nothing else to pick.
      // Re-picking the selected term is an idempotent replace, not a deselect.
      if (!action.multi) {
        const selection: FieldSelection = {
          source: action.source,
          value: action.value,
          values: [action.value],
          listName: action.listName,
          similarity: action.similarity,
        };
        return {
          ...state,
          fieldSelections: { ...state.fieldSelections, [action.key]: selection },
          fieldDropdownOpen: {},
        };
      }
      // Multi-component fields toggle: picking an already-selected term
      // removes it, anything else is appended. The dropdown stays open (no
      // fieldDropdownOpen reset) so several terms can be picked in one go.
      const existing = state.fieldSelections[action.key];
      const values = existing ? existing.values.slice() : [];
      const idx = values.findIndex((v) => v.toLowerCase() === action.value.toLowerCase());
      if (idx >= 0) {
        values.splice(idx, 1);
      } else {
        values.push(action.value);
      }
      if (values.length === 0) {
        const fs = { ...state.fieldSelections };
        delete fs[action.key];
        return { ...state, fieldSelections: fs };
      }
      const selection: FieldSelection =
        values.length > 1
          ? multiSelection(values)
          : { source: action.source, value: values[0], values, listName: action.listName, similarity: action.similarity };
      return { ...state, fieldSelections: { ...state.fieldSelections, [action.key]: selection } };
    }
    case "CLEAR_FIELD": {
      const fs = { ...state.fieldSelections };
      delete fs[action.key];
      return { ...state, fieldSelections: fs, fieldDropdownOpen: {} };
    }
    case "SET_OPEN_VALUE":
      return {
        ...state,
        fieldSelections: {
          ...state.fieldSelections,
          [action.key]: { source: "open", value: action.value, values: [action.value], listName: "", similarity: null },
        },
      };

    case "PATCH_SETTINGS":
      // Functional patches can add/remove catalogue or artefact columns just
      // like the load path (per-card saves, deletes), so the search-column
      // scope must reconcile here too or new columns stop being searchable by
      // default and deleted ones linger in the count.
      return reconcileSearchCols({ ...state, settings: action.patch(state.settings) });
    case "TOGGLE_SF": {
      const e = { ...state.settingsFieldExpanded };
      e[action.id] = !e[action.id];
      return { ...state, settingsFieldExpanded: e };
    }
    case "TOGGLE_VOCAB": {
      const e = { ...state.settingsVocabExpanded };
      e[action.id] = !e[action.id];
      return { ...state, settingsVocabExpanded: e };
    }
    case "TOGGLE_PROV": {
      const e = { ...state.providerExpanded };
      e[action.id] = !e[action.id];
      return { ...state, providerExpanded: e };
    }

    case "PATCH_VOCAB_DRAFT": {
      // Self-heal: seed from persisted settings when no draft exists yet. Edits
      // accumulate without persisting (the no-save twin of PATCH_SETTINGS).
      const base = state.vocabDraft ?? vocabDraftFromSettings(state.settings);
      return { ...state, vocabDraft: action.patch(base) };
    }
    case "CLEAR_VOCAB_DRAFT":
      // Discard: drop the whole vocab draft so the UI renders settings again.
      return { ...state, vocabDraft: null };
    case "SET_VOCAB_CARD_STATUS":
      return { ...state, vocabCardSaveStatus: { ...state.vocabCardSaveStatus, [action.id]: action.status } };
    case "SET_VOCAB_CARD_ERROR": {
      const vocabCardError = { ...state.vocabCardError };
      if (action.error === null) delete vocabCardError[action.id];
      else vocabCardError[action.id] = action.error;
      return { ...state, vocabCardError };
    }
    case "SET_VOCAB_SYNC_PROGRESS":
      return { ...state, vocabSyncProgress: { ...state.vocabSyncProgress, [action.id]: { rowsDone: action.rowsDone, rowsTotal: action.rowsTotal, fileProgress: action.fileProgress } } };
    case "CLEAR_VOCAB_SYNC_PROGRESS": {
      if (!state.vocabSyncProgress[action.id]) return state;
      const vocabSyncProgress = { ...state.vocabSyncProgress };
      delete vocabSyncProgress[action.id];
      return { ...state, vocabSyncProgress };
    }
    case "SET_CATALOGUE_PROGRESS":
      return { ...state, catalogueProgress: { ...state.catalogueProgress, [action.uid]: { step: action.step, total: action.total } } };
    case "CLEAR_CATALOGUE_PROGRESS": {
      if (!state.catalogueProgress[action.uid]) return state;
      const catalogueProgress = { ...state.catalogueProgress };
      delete catalogueProgress[action.uid];
      return { ...state, catalogueProgress };
    }
    case "SET_VOCAB_TERMS_LOADING":
      return { ...state, vocabTermCacheLoading: { ...state.vocabTermCacheLoading, [action.id]: true } };
    case "SET_VOCAB_TERMS": {
      const vocabTermCacheLoading = { ...state.vocabTermCacheLoading };
      delete vocabTermCacheLoading[action.id];
      return { ...state, vocabTermCache: { ...state.vocabTermCache, [action.id]: action.terms }, vocabTermCacheLoading };
    }
    case "CLEAR_VOCAB_TERMS": {
      if (!(action.id in state.vocabTermCache) && !state.vocabTermCacheLoading[action.id]) return state;
      const vocabTermCache = { ...state.vocabTermCache };
      const vocabTermCacheLoading = { ...state.vocabTermCacheLoading };
      delete vocabTermCache[action.id];
      delete vocabTermCacheLoading[action.id];
      return { ...state, vocabTermCache, vocabTermCacheLoading };
    }
    case "CLEAR_ALL_VOCAB_TERMS":
      return { ...state, vocabTermCache: {}, vocabTermCacheLoading: {} };

    case "PATCH_PROVIDER_DRAFT": {
      // Self-heal: seed from persisted settings when no draft exists yet. Edits
      // accumulate without persisting (the no-save twin of PATCH_SETTINGS).
      const base = state.providerDraft ?? providerDraftFromSettings(state.settings);
      return { ...state, providerDraft: action.patch(base) };
    }
    case "CLEAR_PROVIDER_DRAFT":
      // Discard: drop the whole providers draft so the UI renders settings again.
      return { ...state, providerDraft: null };
    case "SET_PROV_STATUS": {
      // Transient Test Connection outcome for a single row. This is verification,
      // not config, so it lives outside the draft. `error` carries the
      // provider's actual failure text so the UI can show it verbatim.
      const provStatus = { ...state.provStatus, [action.id]: { test: action.test, error: action.error } };
      return { ...state, provStatus };
    }
    case "CLEAR_PROV_STATUS": {
      // Drop a row's stale test status (e.g. after editing its credentials).
      if (!state.provStatus[action.id]) return state;
      const provStatus = { ...state.provStatus };
      delete provStatus[action.id];
      return { ...state, provStatus };
    }
    case "SET_PROV_CARD_STATUS":
      return { ...state, provCardSaveStatus: { ...state.provCardSaveStatus, [action.id]: action.status } };
    case "SET_PROV_CARD_ERROR": {
      const provCardError = { ...state.provCardError };
      if (action.error === null) delete provCardError[action.id];
      else provCardError[action.id] = action.error;
      return { ...state, provCardError };
    }
    case "SET_SHOW_PROV_KEY":
      return { ...state, showProvKey: action.show };

    case "TOGGLE_EMB_PROV": {
      const e = { ...state.embProviderExpanded };
      e[action.id] = !e[action.id];
      return { ...state, embProviderExpanded: e };
    }
    case "PATCH_EMB_PROVIDER_DRAFT": {
      // Self-heal: seed from persisted settings when no draft exists yet. Edits
      // accumulate without persisting (the no-save twin of PATCH_SETTINGS).
      const base = state.embProviderDraft ?? embeddingProviderDraftFromSettings(state.settings);
      return { ...state, embProviderDraft: action.patch(base) };
    }
    case "CLEAR_EMB_PROVIDER_DRAFT":
      // Discard: drop the whole embedding-providers draft so the UI renders settings again.
      return { ...state, embProviderDraft: null };
    case "SET_EMB_PROV_STATUS": {
      // Transient Test Connection outcome for a single row. This is verification,
      // not config, so it lives outside the draft. `error` carries the
      // provider's actual failure text so the UI can show it verbatim.
      const embProvStatus = { ...state.embProvStatus, [action.id]: { test: action.test, error: action.error } };
      return { ...state, embProvStatus };
    }
    case "CLEAR_EMB_PROV_STATUS": {
      // Drop a row's stale test status (e.g. after editing its credentials).
      if (!state.embProvStatus[action.id]) return state;
      const embProvStatus = { ...state.embProvStatus };
      delete embProvStatus[action.id];
      return { ...state, embProvStatus };
    }
    case "SET_EMB_PROV_CARD_STATUS":
      return { ...state, embProvCardSaveStatus: { ...state.embProvCardSaveStatus, [action.id]: action.status } };
    case "SET_EMB_PROV_CARD_ERROR": {
      const embProvCardError = { ...state.embProvCardError };
      if (action.error === null) delete embProvCardError[action.id];
      else embProvCardError[action.id] = action.error;
      return { ...state, embProvCardError };
    }
    case "SET_SHOW_EMB_PROV_KEY":
      return { ...state, showEmbProvKey: action.show };

    case "SET_FIELD_CARD_STATUS":
      return { ...state, fieldCardSaveStatus: { ...state.fieldCardSaveStatus, [action.id]: action.status } };
    case "PATCH_FIELD_DRAFT": {
      // Self-heal: if no draft exists yet, seed from persisted settings. Edits
      // accumulate without persisting (the no-save twin of PATCH_SETTINGS).
      const base = state.fieldDraft ?? fieldDraftFromSettings(state.settings);
      return { ...state, fieldDraft: action.patch(base) };
    }
    case "CLEAR_FIELD_DRAFT":
      // Discard: drop the draft so the UI renders the persisted settings again,
      // and re-lock the output-contract box so a later edit needs Override again.
      return { ...state, fieldDraft: null, contractEditing: false };
    case "SET_CONTRACT_EDITING":
      return { ...state, contractEditing: action.editing };

    case "TOGGLE_AF": {
      const e = { ...state.artefactFieldExpanded };
      e[action.id] = !e[action.id];
      return { ...state, artefactFieldExpanded: e };
    }
    case "PATCH_ARTEFACT_DRAFT": {
      // Self-heal: seed from persisted settings when no draft exists yet. Edits
      // accumulate without persisting (the no-save twin of PATCH_SETTINGS).
      const base = state.artefactDraft ?? artefactDraftFromSettings(state.settings);
      return { ...state, artefactDraft: action.patch(base) };
    }
    case "CLEAR_ARTEFACT_DRAFT":
      // Discard: drop the artefact draft so the UI renders settings again.
      return { ...state, artefactDraft: null };
    case "SET_ARTEFACT_CARD_STATUS":
      return { ...state, artefactCardSaveStatus: { ...state.artefactCardSaveStatus, [action.id]: action.status } };

    case "SET_ALL_EXPANDED":
      return { ...state, [action.scope]: Object.fromEntries(action.ids.map((id) => [id, action.expanded])) };

    default:
      return state;
  }
}

/** Snapshot of the editable Cataloguing Fields tab from persisted settings —
 *  the baseline a draft is seeded from and compared against for dirty checks. */
function fieldDraftFromSettings(s: Settings): FieldDraft {
  return {
    // Shallow-clone each field and its vocabSources array so patch fns can
    // mutate copies without touching persisted state.
    fields: s.fields.map((f) => ({ ...f, vocabSources: [...f.vocabSources] })),
  };
}

/** Snapshot of the editable Model Providers tab from persisted settings — the
 *  baseline a providers draft is seeded from and compared against for dirty
 *  checks. Mirrors fieldDraftFromSettings. */
export function providerDraftFromSettings(s: Settings): ProviderDraft {
  return {
    activeProvider: s.activeProvider,
    // Clone each entry (and its modelOptions array) so patch fns can mutate
    // copies without touching persisted state.
    providers: s.providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: p.model,
      apiFormat: p.apiFormat ?? "openai",
      modelOptions: [...(p.modelOptions ?? [])],
      connStatus: p.connStatus ?? "untested",
      thinking: p.thinking ?? null,
      authHeader: p.authHeader ?? "",
      bodyTemplate: p.bodyTemplate ?? "",
    })),
  };
}

/** Snapshot of the Vocabulary Lists tab from persisted settings — the baseline
 *  a vocab draft is seeded from and compared against for dirty checks. Mirrors
 *  fieldDraftFromSettings. */
export function vocabDraftFromSettings(s: Settings): VocabDraft {
  return {
    // Clone each source and its files/fields arrays so patch fns can mutate
    // copies without touching persisted state.
    vocabSources: s.vocabSources.map((v) => ({
      ...v,
      files: v.files.map((f) => ({ ...f })),
      fields: v.fields.map((f) => ({ ...f })),
      embedding: { ...v.embedding },
    })),
  };
}

/** Snapshot of the Embedding Providers section from persisted settings — the
 *  baseline an embedding-providers draft is seeded from and compared against
 *  for dirty checks. Mirrors providerDraftFromSettings. */
export function embeddingProviderDraftFromSettings(s: Settings): EmbeddingProviderDraft {
  return {
    activeProvider: s.activeEmbeddingProvider,
    providers: s.embeddingProviders.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: p.model,
      apiFormat: p.apiFormat ?? "openai",
      modelOptions: [...(p.modelOptions ?? [])],
      imageInputModels: p.imageInputModels ? [...p.imageInputModels] : null,
      connStatus: p.connStatus ?? "untested",
    })),
  };
}

/** Snapshot of the Artefact File tab's columns from persisted settings — the
 *  baseline an artefact draft is seeded from and compared against for dirty
 *  checks. Mirrors fieldDraftFromSettings. */
export function artefactDraftFromSettings(s: Settings): ArtefactDraft {
  return {
    artefactAnalysisSystemPromptInstruction: s.artefactAnalysisSystemPromptInstruction ?? "",
    artefactFields: (s.artefactFields || _DEF_AF).map((f) => ({ ...f })),
  };
}
