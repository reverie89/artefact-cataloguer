// App state shape + reducer, mirroring the reference DCLogic component.
// Persistence (load/save beside the binary) is handled in store.ts and wired
// by an effect in App.tsx.

import { _DEF, _DEF_AF } from "./defaults";
import type { SaveState } from "../components/settings/SaveActions.types";
import type { VocabTermEntry } from "../lib/vocab";
import type { AiResults, ApiFormat, ArtefactField, ArtefactRow, CatalogueField, EmbeddingApiFormat, FieldSelection, ParseStatus, Screen, Settings, SettingsTab, VocabSource } from "./types";

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

/** In-memory draft of the whole AI Provider tab — a snapshot of providers +
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
  supportsImageInput: boolean;
  modelOptions: string[];
  dimensions: number | null;
  connStatus: "ok" | "err" | "untested";
};

/** In-memory draft of the whole Embedding Providers section — mirrors
 *  ProviderDraft. `null` means "no pending edits; render settings". */
export type EmbeddingProviderDraft = {
  providers: EmbeddingProviderDraftEntry[];
  activeProvider: string | null;
};

/** In-memory draft of the Artefact File tab's required-column config + the
 *  vision-analysis system instruction. Mirrors the other drafts; `null` means
 *  "no pending edits; render settings". */
export type ArtefactDraft = {
  visionSystemPromptInstruction: string;
  artefactFields: ArtefactField[];
};

/** Editable keys of an existing catalogue-field row (vocabSources is handled by
 *  add/remove-vocab-source actions, not the generic setter). */
export type EditableCatalogueFieldKey = "name" | "type" | "prompt";

/** Editable keys of an existing artefact-column row. */
export type EditableArtefactFieldKey = "name" | "description" | "prompt";

export interface AppState {
  darkMode: boolean;
  screen: Screen;
  settingsTab: SettingsTab;
  loaded: boolean;

  // Files / parse
  files: UploadFile[];
  uploadDragOver: boolean;
  /** Lifecycle of the current parse run (idle → running ⇄ paused → completed/
   *  cancelled). Source of truth for whether the loop is alive; replaces the
   *  former boolean `parseStarted`, which couldn't distinguish active from
   *  finished. */
  parseStatus: ParseStatus;
  results: ArtefactRow[];
  expandedRows: Record<string, boolean>;
  fieldSelections: Record<string, FieldSelection>;
  fieldDropdownOpen: Record<string, boolean>;
  fieldDropdownSearch: Record<string, string>;
  resultsFilter: string;
  resultsSearch: string;
  validationErrors: { message: string }[];
  aiResults: AiResults;
  /** Fatal catalogue error that aborted the run, if any. */
  parseError: string | null;

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
   *  settings is what survives a restart. Absent = no sync in flight. */
  vocabSyncProgress: Record<string, { rowsDone: number; rowsTotal: number }>;
  /** Full term list fetched from a synced source's LanceDB table, keyed by
   *  source id — transient (not persisted), populated on demand by
   *  `ensureVocabTermsLoaded` and consumed by `vterms` (app/styles.ts) to
   *  drive the manual vocab-picker dropdown. Absent = not yet fetched. */
  vocabTermCache: Record<string, VocabTermEntry[]>;
  /** Source ids with a `listVocabTerms` fetch currently in flight, so
   *  `ensureVocabTermsLoaded` doesn't fire a duplicate concurrent request. */
  vocabTermCacheLoading: Record<string, boolean>;

  // Providers form — a single unified draft (mirrors fieldDraft): edits, adds,
  // deletes, and active-selection changes all accumulate here and persist only
  // on the tab-level Save. `provStatus` is the one piece kept separate: it is
  // transient per-row Test Connection verification, not part of the draft.
  providerDraft: ProviderDraft | null;
  provStatus: Record<string, { test: "testing" | "ok" | "err" | null }>;
  /** Persist status for the tab-level Save button. */
  provSaveStatus: "saving" | "ok" | "err" | null;
  /** Per-card save status for a provider card (keyed by provider id). A card's
   *  own Save persists only that provider; its outcome surfaces here while the
   *  tab-level `provSaveStatus` stays reserved for the structural Apply. */
  provCardSaveStatus: Record<string, SaveState>;
  /** Specific reason a provider card's Save failed (keyed by provider id), shown
   *  in place of the generic "Not saved". Cleared on the next successful/again
   *  Save attempt. */
  provCardError: Record<string, string>;
  showProvKey: boolean;

  // Embedding Providers section (AI tab) — mirrors the providers draft block
  // above exactly, one field at a time, for the separate embedding-model list.
  embProviderDraft: EmbeddingProviderDraft | null;
  embProviderExpanded: Record<string, boolean>;
  embProvStatus: Record<string, { test: "testing" | "ok" | "err" | null }>;
  embProvSaveStatus: "saving" | "ok" | "err" | null;
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
}

export interface UploadFile {
  id: string;
  name: string;
  size: number;
  sizeLabel: string;
  status: "validating" | "valid" | "invalid";
  errors: { message: string }[];
}

export const initialState: AppState = {
  darkMode: true,
  screen: "main",
  settingsTab: "about",
  loaded: false,

  files: [],
  uploadDragOver: false,
  parseStatus: "idle",
  results: [],
  expandedRows: {},
  fieldSelections: {},
  fieldDropdownOpen: {},
  fieldDropdownSearch: {},
  resultsFilter: "all",
  resultsSearch: "",
  validationErrors: [],
  aiResults: {},
  parseError: null,

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
  provSaveStatus: null,
  provCardSaveStatus: {},
  provCardError: {},
  showProvKey: false,

  embProviderDraft: null,
  embProviderExpanded: {},
  embProvStatus: {},
  embProvSaveStatus: null,
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
};

// --- Actions -----------------------------------------------------------------

export type Action =
  | { type: "INIT"; settings: Settings; darkMode: boolean; zoom: number }
  | { type: "SET_DARK"; darkMode: boolean }
  | { type: "SET_SCREEN"; screen: Screen }
  | { type: "SET_TAB"; tab: SettingsTab }
  | { type: "SET_ZOOM"; zoom: number }
  | { type: "SET_LOGS_OPEN"; open: boolean }
  | { type: "SET_FILES"; files: UploadFile[] }
  | { type: "SET_FILE_STATUS"; id: string; status: UploadFile["status"]; errors: { message: string }[]; validationErrors: { message: string }[] }
  | { type: "REMOVE_FILE"; id: string }
  | { type: "RESET_UPLOAD" }
  | { type: "SET_UPLOAD_DRAG"; drag: boolean }
  | { type: "START_PARSE"; results: ArtefactRow[] }
  | { type: "SET_ROW_STATUS"; uid: string; status: ArtefactRow["status"]; ai?: Record<string, { value: string; similarity?: number }[]> }
  | { type: "SET_ROW_IMAGE"; uid: string; imagePath: string }
  | { type: "SET_PARSE_STATUS"; status: ParseStatus }
  | { type: "SET_PARSE_ERROR"; error: string | null }
  | { type: "TOGGLE_ROW"; uid: string }
  | { type: "SET_FILTER"; filter: string }
  | { type: "SET_SEARCH"; search: string }
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
    }
  | { type: "CLEAR_FIELD"; key: string }
  | { type: "SET_OPEN_VALUE"; key: string; value: string }
  | { type: "SET_SETTINGS"; settings: Settings }
  | { type: "PATCH_SETTINGS"; patch: (s: Settings) => Settings }
  | { type: "TOGGLE_SF"; id: string }
  | { type: "TOGGLE_VOCAB"; id: string }
  | { type: "TOGGLE_PROV"; id: string }
  | { type: "PATCH_VOCAB_DRAFT"; patch: (d: VocabDraft) => VocabDraft }
  | { type: "CLEAR_VOCAB_DRAFT" }
  | { type: "SET_VOCAB_CARD_STATUS"; id: string; status: SaveState }
  | { type: "SET_VOCAB_CARD_ERROR"; id: string; error: string | null }
  | { type: "SET_VOCAB_SYNC_PROGRESS"; id: string; rowsDone: number; rowsTotal: number }
  | { type: "CLEAR_VOCAB_SYNC_PROGRESS"; id: string }
  | { type: "SET_VOCAB_TERMS_LOADING"; id: string }
  | { type: "SET_VOCAB_TERMS"; id: string; terms: VocabTermEntry[] }
  | { type: "CLEAR_VOCAB_TERMS"; id: string }
  | { type: "CLEAR_ALL_VOCAB_TERMS" }
  | { type: "PATCH_PROVIDER_DRAFT"; patch: (d: ProviderDraft) => ProviderDraft }
  | { type: "CLEAR_PROVIDER_DRAFT" }
  | { type: "SET_PROV_STATUS"; id: string; test: "testing" | "ok" | "err" | null }
  | { type: "CLEAR_PROV_STATUS"; id: string }
  | { type: "SET_PROV_SAVE_STATUS"; status: "saving" | "ok" | "err" | null }
  | { type: "SET_PROV_CARD_STATUS"; id: string; status: SaveState }
  | { type: "SET_PROV_CARD_ERROR"; id: string; error: string | null }
  | { type: "SET_SHOW_PROV_KEY"; show: boolean }
  | { type: "TOGGLE_EMB_PROV"; id: string }
  | { type: "PATCH_EMB_PROVIDER_DRAFT"; patch: (d: EmbeddingProviderDraft) => EmbeddingProviderDraft }
  | { type: "CLEAR_EMB_PROVIDER_DRAFT" }
  | { type: "SET_EMB_PROV_STATUS"; id: string; test: "testing" | "ok" | "err" | null }
  | { type: "CLEAR_EMB_PROV_STATUS"; id: string }
  | { type: "SET_EMB_PROV_SAVE_STATUS"; status: "saving" | "ok" | "err" | null }
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
  | { type: "SET_ALL_EXPANDED"; scope: "settingsFieldExpanded" | "settingsVocabExpanded" | "embProviderExpanded" | "artefactFieldExpanded"; ids: string[]; expanded: boolean };

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "INIT":
      return { ...state, settings: action.settings, darkMode: action.darkMode, zoom: action.zoom, loaded: true, fieldDraft: null, providerDraft: null, embProviderDraft: null, vocabDraft: null, artefactDraft: null };
    case "SET_DARK":
      return { ...state, darkMode: action.darkMode };
    case "SET_SCREEN":
      return { ...state, screen: action.screen };
    case "SET_TAB":
      return { ...state, settingsTab: action.tab };
    case "SET_ZOOM":
      return { ...state, zoom: action.zoom };
    case "SET_LOGS_OPEN":
      return { ...state, logsOpen: action.open };

    case "SET_FILES":
      return {
        ...state,
        files: action.files,
        parseStatus: "idle",
        results: [],
        aiResults: {},
        expandedRows: {},
        fieldSelections: {},
        fieldDropdownOpen: {},
        fieldDropdownSearch: {},
      };
    case "SET_FILE_STATUS": {
      const files = state.files.map((f) =>
        f.id === action.id ? { ...f, status: action.status, errors: action.errors } : f
      );
      return { ...state, files, validationErrors: action.validationErrors };
    }
    case "REMOVE_FILE":
      return { ...state, files: state.files.filter((f) => f.id !== action.id) };
    case "RESET_UPLOAD":
      // Clear the whole upload + parse + results lifecycle back to a fresh
      // state (the in-memory parsed cache at window.__acParsed is dropped by
      // the action). Settings/screen/zoom/drafts/logs are left untouched.
      return {
        ...state,
        files: [],
        uploadDragOver: false,
        parseStatus: "idle",
        results: [],
        expandedRows: {},
        fieldSelections: {},
        fieldDropdownOpen: {},
        fieldDropdownSearch: {},
        resultsFilter: "all",
        resultsSearch: "",
        validationErrors: [],
        aiResults: {},
        parseError: null,
      };
    case "SET_UPLOAD_DRAG":
      return { ...state, uploadDragOver: action.drag };

    case "START_PARSE":
      return {
        ...state,
        parseStatus: "running",
        results: action.results,
        aiResults: {},
        expandedRows: {},
        fieldSelections: {},
        fieldDropdownOpen: {},
        fieldDropdownSearch: {},
        parseError: null,
      };
    case "SET_ROW_STATUS": {
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
          const top = action.ai[field.name]?.[0];
          if (!top) continue;
          additions[key] = { source: "ai", value: top.value, values: [top.value], listName: "AI", similarity: top.similarity ?? null };
        }
        if (Object.keys(additions).length > 0) {
          fieldSelections = { ...fieldSelections, ...additions };
        }
      }
      return { ...state, results, aiResults, fieldSelections };
    }
    case "SET_ROW_IMAGE":
      return {
        ...state,
        results: state.results.map((r) => (r.uid === action.uid ? { ...r, imagePath: action.imagePath } : r)),
      };

    case "SET_PARSE_STATUS":
      return { ...state, parseStatus: action.status };

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
    case "SET_FIELD_SEARCH":
      return { ...state, fieldDropdownSearch: { ...state.fieldDropdownSearch, [action.key]: action.value } };
    case "OPEN_DD":
      return { ...state, fieldDropdownOpen: { [action.key]: true } };
    case "CLOSE_ALL_DD":
      return { ...state, fieldDropdownOpen: {} };
    case "TOGGLE_FIELD_VALUE": {
      // Vocab-type fields are multi-select: picking an already-selected term
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
          ? { source: "multi", value: values.join(" | "), values, listName: "", similarity: null }
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

    case "SET_SETTINGS":
      return { ...state, settings: action.settings };
    case "PATCH_SETTINGS":
      return { ...state, settings: action.patch(state.settings) };
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
      return { ...state, vocabSyncProgress: { ...state.vocabSyncProgress, [action.id]: { rowsDone: action.rowsDone, rowsTotal: action.rowsTotal } } };
    case "CLEAR_VOCAB_SYNC_PROGRESS": {
      if (!state.vocabSyncProgress[action.id]) return state;
      const vocabSyncProgress = { ...state.vocabSyncProgress };
      delete vocabSyncProgress[action.id];
      return { ...state, vocabSyncProgress };
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
      // not config, so it lives outside the draft.
      const provStatus = { ...state.provStatus, [action.id]: { test: action.test } };
      return { ...state, provStatus };
    }
    case "CLEAR_PROV_STATUS": {
      // Drop a row's stale test status (e.g. after editing its credentials).
      if (!state.provStatus[action.id]) return state;
      const provStatus = { ...state.provStatus };
      delete provStatus[action.id];
      return { ...state, provStatus };
    }
    case "SET_PROV_SAVE_STATUS":
      return { ...state, provSaveStatus: action.status };
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
      // not config, so it lives outside the draft.
      const embProvStatus = { ...state.embProvStatus, [action.id]: { test: action.test } };
      return { ...state, embProvStatus };
    }
    case "CLEAR_EMB_PROV_STATUS": {
      // Drop a row's stale test status (e.g. after editing its credentials).
      if (!state.embProvStatus[action.id]) return state;
      const embProvStatus = { ...state.embProvStatus };
      delete embProvStatus[action.id];
      return { ...state, embProvStatus };
    }
    case "SET_EMB_PROV_SAVE_STATUS":
      return { ...state, embProvSaveStatus: action.status };
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

/** Snapshot of the editable AI Provider tab from persisted settings — the
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
      supportsImageInput: p.supportsImageInput ?? false,
      modelOptions: [...(p.modelOptions ?? [])],
      dimensions: p.dimensions ?? null,
      connStatus: p.connStatus ?? "untested",
    })),
  };
}

/** Snapshot of the Artefact File tab's columns from persisted settings — the
 *  baseline an artefact draft is seeded from and compared against for dirty
 *  checks. Mirrors fieldDraftFromSettings. */
export function artefactDraftFromSettings(s: Settings): ArtefactDraft {
  return {
    visionSystemPromptInstruction: s.visionSystemPromptInstruction ?? "",
    artefactFields: (s.artefactFields || _DEF_AF).map((f) => ({ ...f })),
  };
}
