// Data model types — mirror the reference app's shapes.

export type FieldType = "open" | "vocab";

/** Which API family a provider speaks — drives auth scheme and endpoint paths. */
export type ApiFormat = "openai" | "anthropic" | "gemini";

/** A configurable column the artefact spreadsheet must provide. Every
 *  configured column must be present when the file is parsed (even if some
 *  cells are empty), and its values are always sent to the AI in the
 *  vision-analysis prompt. `prompt` is an optional per-column instruction for
 *  how the vision call should use that column's value — empty means "no
 *  field-specific guidance" and is omitted from the prompt (the value still
 *  reaches the model via the record). */
export interface ArtefactField {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

/** A catalogue field the AI extracts per artefact. */
export interface CatalogueField {
  id: string;
  name: string;
  type: FieldType;
  layout: string;
  prompt: string;
  vocabSources: string[]; // ids into Settings.vocabSources
}

/** One raw file staged into a vocabulary source, persisted to disk beside the
 *  binary (see src-tauri/src/vocab_files.rs) — never held in memory as a
 *  parsed term array. */
export interface VocabSourceFile {
  id: string;
  filename: string;
  addedDate: string;
  sizeBytes: number;
  /** Row count from the file's own last parse, if known — display only. */
  rowCountLast?: number;
  /** How many of those rows actually made it into the embedded index on the
   *  last sync (after empty-term filtering and cross-file term dedup) — can
   *  be lower than `rowCountLast`. Display only. */
  rowCountSyncedLast?: number;
}

/** A column detected from the union of headers across a source's files
 *  (every column, including whichever one is currently used for ingestion).
 *  Controls whether that column's values feed the embedding text and the
 *  AI-facing shortlist hint — a metadata column is either used for AI
 *  context or it isn't. */
export interface VocabSourceField {
  name: string;
  includeForAI: boolean;
}

/** Sync status of a vocabulary source's embedded index (see lib/vocab.ts /
 *  src-tauri/src/embeddings.rs). */
export interface VocabEmbeddingStatus {
  status: "never" | "stale" | "syncing" | "synced" | "error";
  providerId: string | null;
  model: string | null;
  dimensions: number | null;
  lastSyncedAt: string | null;
  rowsEmbedded: number | null;
  lastError: string | null;
}

/** A controlled-vocabulary source: one or more uploaded files merged into one
 *  term corpus, embedded on-demand into a local LanceDB table. No term
 *  content lives here — only enough metadata to drive the Settings UI and
 *  resolve which retrieval path to use. */
export interface VocabSource {
  id: string;
  name: string;
  files: VocabSourceFile[];
  fields: VocabSourceField[];
  /** Column (by name, from `fields`) whose value becomes the term/dedup key
   *  LanceDB embeds and diffs by. `null` means "use the file's first column"
   *  — the original hardcoded behaviour, kept as the default so sources
   *  created before this field existed keep working unchanged. */
  ingestionField: string | null;
  /** Column whose value is shown as the primary label in the cataloguing
   *  dropdown ("[label] [badge]"). `null` falls back to the resolved term. */
  labelField: string | null;
  /** Column whose value is shown as a secondary badge chip beside the label
   *  in the cataloguing dropdown. `null` means no badge is shown. */
  badgeField: string | null;
  embedding: VocabEmbeddingStatus;
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

/** Which API family an embedding provider speaks. Anthropic has no
 *  embeddings API, so this is a subset of ApiFormat. */
export type EmbeddingApiFormat = "openai" | "gemini";

/** An embedding-model provider configuration — mirrors Provider, but kept as
 *  a separate list since embeddings often run on a different vendor/endpoint
 *  than chat+vision (e.g. a local Ollama embedding model alongside a hosted
 *  chat provider). */
export interface EmbeddingProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  modelOptions?: string[];
  apiFormat?: EmbeddingApiFormat;
  /** User-declared capability: whether this model accepts image input for
   *  the parse-time image-embedding step. A hint, not a guarantee — the
   *  Rust side still falls back to text-only on a rejected image call. */
  supportsImageInput?: boolean;
  /** Vector width learned from a successful Test Connection embed call. */
  dimensions?: number;
  connStatus?: "ok" | "err" | "untested";
}

/** The whole persisted settings object. */
export interface Settings {
  /** The unified Call-1 system prompt: the museum-cataloguing persona + the
   *  output-format preamble (instructs the model to read `<artefact_file>` and
   *  reply in XML). The dynamic per-field XML enumeration and the record block
   *  are appended by Rust at runtime, so this holds only the user-editable
   *  prose. Gated behind an Override in the UI (disabled by default). */
  visionSystemPromptInstruction: string;
  /** Candidates the embedding search returns per vocab field before Call 3
   *  validation (the "net"). Default 20. */
  vocabNetCount: number;
  /** Final picks per vocab field after Call 3 validation (or cosine top-N when
   *  Call 3 is off). Default 3. */
  vocabShortlistCount: number;
  /** Whether Call 3 (vision validation) runs. Default true. */
  call3Enabled: boolean;
  fields: CatalogueField[];
  vocabSources: VocabSource[];
  providers: Provider[];
  activeProvider: string | null;
  embeddingProviders: EmbeddingProvider[];
  activeEmbeddingProvider: string | null;
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
  /** Cosine similarity the embedding search scored a vocab candidate at
   *  (0–1). Absent for open-ended fields (never similarity-scored — the answer
   *  is taken verbatim from the model). */
  similarity?: number;
}

/** AI results keyed by artefact id → field name → suggestions. */
export type AiResults = Record<string, Record<string, AiSuggestion[]>>;

export interface FieldSelection {
  /** "multi" marks a vocab-type field with more than one term picked — its
   *  per-term source/listName/similarity no longer apply to the selection as
   *  a whole. */
  source: "ai" | "vocab" | "manual" | "open" | "multi";
  /** Display/export value — the selected term, or every selected term joined
   *  with " | " once more than one is picked. */
  value: string;
  /** Every selected value in pick order. Vocab-type fields may hold several;
   *  other field types always hold exactly one, matching `value`. */
  values: string[];
  listName: string;
  similarity: number | null;
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
