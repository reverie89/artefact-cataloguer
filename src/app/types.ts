// Data model types — mirror the reference app's shapes.

export type FieldType = "open" | "vocab";

/** Which API family a provider speaks — drives auth scheme and endpoint paths. */
export type ApiFormat = "openai" | "anthropic" | "gemini";

/** A configurable column the artefact spreadsheet must provide. */
export interface ArtefactField {
  id: string;
  name: string;
  required: boolean;
  description: string;
}

/** A catalogue field the AI extracts per artefact. */
export interface CatalogueField {
  id: string;
  name: string;
  type: FieldType;
  layout: string;
  prompt: string;
  vocabSources: string[]; // ids into Settings.vocabularyLists
}

/** A controlled-vocabulary list (terms come from a csv/xlsx or built-ins). */
export interface VocabList {
  id: string;
  filename: string;
  name: string;
  terms: number;
  termData: string[];
  uploadDate: string;
}

/** An AI provider configuration. */
export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Models discovered by a successful connection test. */
  modelOptions?: string[];
  /** Optional; providers saved before this field existed default to OpenAI format. */
  apiFormat?: ApiFormat;
  /** Last persisted connection-test outcome for this provider. Optional;
   *  providers saved before this field existed default to "untested" on load.
   *  The "testing" state is inherently transient and never persisted. */
  connStatus?: "ok" | "err" | "untested";
}

/** The whole persisted settings object. */
export interface Settings {
  /** Part 1 of the system instructions — user-edited context prose. */
  systemPromptInstruction: string;
  /** Part 2 of the system instructions — the read-only output contract the
   *  parser relies on. Empty string means "use the built-in default"; any
   *  non-empty value is an explicit user override. */
  systemPromptContractOverride: string;
  fields: CatalogueField[];
  vocabularyLists: VocabList[];
  providers: Provider[];
  activeProvider: string | null;
  artefactFields: ArtefactField[];
}

/** One row of the uploaded spreadsheet (one artefact). */
export interface ArtefactRow {
  /** Stable internal identity — assigned once at parse. Used for React keys,
   *  reducer matching, and the expandedRows/fieldSelections/aiResults map keys.
   *  Never empty, never duplicated. */
  uid: string;
  /** Accession No value from the sheet — display data only, not identity. May
   *  be empty or duplicated across rows; never use this to match/state a row. */
  id: string;
  title: string;
  category: string;
  /** Set at parse time. `cancelled` = skipped because the user cancelled the
   *  run before this row was reached (terminal, like `done`/`error`). */
  status?: "queued" | "processing" | "done" | "error" | "cancelled";
  /** Arbitrary source columns from the sheet (key → value). */
  record?: Record<string, string>;
  /** Absolute path to the extracted image beside the binary, if any. */
  imagePath?: string;
  /** Legacy display fields kept for parity with the reference rows. */
  altNo?: string;
  acquired?: string;
  dimensions?: string;
}

export interface AiSuggestion {
  value: string;
  confidence: number;
}

/** AI results keyed by artefact id → field name → suggestions. */
export type AiResults = Record<string, Record<string, AiSuggestion[]>>;

export interface FieldSelection {
  /** "multi" marks a vocab-type field with more than one term picked — its
   *  per-term source/listName/confidence no longer apply to the selection as
   *  a whole. */
  source: "ai" | "vocab" | "manual" | "open" | "multi";
  /** Display/export value — the selected term, or every selected term joined
   *  with " | " once more than one is picked. */
  value: string;
  /** Every selected value in pick order. Vocab-type fields may hold several;
   *  other field types always hold exactly one, matching `value`. */
  values: string[];
  listName: string;
  confidence: number | null;
}

export type Screen = "main" | "settings";
export type SettingsTab = "about" | "artefactFile" | "fields" | "vocab" | "ai";

/** Lifecycle of the current parse run. `idle` = nothing has run yet for the
 *  current upload; `running`/`paused` = the loop is alive; `completed`/
 *  `cancelled` = terminal (loop has exited). Replaces the former
 *  `parseStarted: boolean`, which couldn't distinguish an active run from a
 *  finished one. */
export type ParseStatus = "idle" | "running" | "paused" | "cancelled" | "completed";

/** Shape written to / read from <exe_dir>/settings.json. */
export interface StateBundle {
  ac_settings: Settings;
  ac_darkMode: string;
  ac_zoom: string;
}

/** Extracted image descriptor returned by Rust. */
export interface ExtractedImage {
  id: string;
  abs_path: string;
}
