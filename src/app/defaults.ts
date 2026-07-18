// Default settings, catalogue fields, and vocab lists. There is no demo data
// here — cataloguing requires a real uploaded spreadsheet and a live provider.

import type { ArtefactField, CatalogueField, EmbeddingProvider, Provider, Settings, VocabSource } from "./types";

export const _DEF_AF: ArtefactField[] = [
  { id: "af1", name: "Image", description: "Image", prompt: "", includeInExport: true },
  { id: "af2", name: "Object Name", description: "Name of object", prompt: "", includeInExport: true },
  { id: "af3", name: "Date/Period", description: "Date or Period", prompt: "", includeInExport: true },
  { id: "af4", name: "Geo. Assoc.", description: "Geological Association", prompt: "", includeInExport: true },
  { id: "af5", name: "Material", description: "Material", prompt: "", includeInExport: true },
  { id: "af6", name: "Hist. Signi", description: "Historical Significance", prompt: "", includeInExport: true },
  { id: "af7", name: "Style Signi", description: "Style Significance", prompt: "", includeInExport: true },
  { id: "af8", name: "Curator's notes", description: "Curator's notes", prompt: "", includeInExport: true },
  { id: "af9", name: "Techniques", description: "Techniques", prompt: "", includeInExport: true },
];

export const _DEF_FIELDS: CatalogueField[] = [
  { id: "f3", name: "Physical Description", type: "open", layout: "row", prompt: "Make a physical description of the artefact.\n\nAdditionally, if handwriting or motif can be observed and is legible, answer in a structured markdown format:\n```\nRaw text:\n{words as-is identified}\n\nEnglish Translation:\n{English translation}\n```", vocabSources: [] },
  { id: "f4", name: "Obj./Work type", type: "vocab", layout: "row", prompt: "When two or more candidates are otherwise equally plausible, rank the one hinted \"Thesaurus: NHB\" above the others.", vocabSources: ["vocab-object-type"] },
  { id: "f5", name: "Place", type: "vocab", layout: "row", prompt: "", vocabSources: ["vocab-place"] },
  { id: "f6", name: "Material", type: "vocab", layout: "row", prompt: "", vocabSources: ["vocab-material"] },
  { id: "f7", name: "Technique", type: "vocab", layout: "row", prompt: "Name the specific making process, never use generic terms. Review everything in <artefact_file> to evaluate the making process.", vocabSources: ["vocab-technique"] },
  { id: "f8", name: "Shape", type: "vocab", layout: "row", prompt: "", vocabSources: ["vocab-shape"] },
  { id: "f9", name: "Date/Period", type: "open", layout: "row", prompt: "Translate and convert to the Gregorian calendar and even if only century notation can be derived, you must express it in Gregorian (e.g., \"19th century\" → \"1800s\", \"20th century\" → \"1900s\").", vocabSources: [] },
  { id: "f10", name: "Colour", type: "vocab", layout: "row", prompt: "", vocabSources: ["vocab-colour"] },
];

/** The unified vision-analysis system prompt: the museum-cataloguing persona
 *  plus the output-format preamble that tells the model to read
 *  `<artefact_file>` and reply in XML. The dynamic per-field
 *  `<extraction>`/`<open_field>` enumeration and the `<artefact_file>` record
 *  block are appended by Rust at runtime from the live field config and the
 *  row's values — they cannot live in this static text. Gated behind an
 *  Override in the UI; editing is discouraged. */
export const _DEF_VISION_SYSTEM_PROMPT_INSTRUCTION =
  "You are an experienced museum cataloguing assistant specializing in Southeast Asia artefact collections; draw on museum, art-historical, and cultural context when interpreting each object. Prioritize accurate, evidence-based description and avoid unsupported claims.\n\nAlways observe and describe the artefact using both the attached image and the metadata in <artefact_file>. Distinguish the actual object(s) from any supplementary notes or labels in the image (e.g., museum placards, curator's tags) that describe but are not the object. The reverse can also be true: a text-bearing item such as calligraphy, a manuscript, a document, or a bank note is the artefact itself when it is visually the primary subject — not a label about something else. Notes may be handwritten or in a foreign language; use them to enhance your description when clear, but prefer the object's visible physical evidence when they conflict. Do not presume an unfamiliar object's nature, identity, or function from unfamiliarity alone; describe what you can observe.\n\nReply ONLY in this XML format, using the field names exactly as tagged. Do not add prose, explanations, or code fences:\n<image_description> a rich, evidence-based description of the artefact </image_description>\n<extraction field=\"{Field Name}\"> the specific text describing this aspect of the artefact, to be aligned to this field's controlled vocabulary downstream </extraction>\n<open_field field=\"{Field Name}\"> the free-text answer for this catalogue field </open_field>";

/** Column layout shared by every seeded vocabulary source — mirrors the live
 *  in-app configuration: `Term` is both the ingestion key and the display
 *  label, `Thesaurus` (NHB / Getty AAT) is the badge, and `Field Name` is
 *  metadata excluded from AI retrieval. */
const VOCAB_TERM_COLUMNS: VocabSource["fields"] = [
  { name: "Field Name", includeForAI: false },
  { name: "Term", includeForAI: true },
  { name: "Thesaurus", includeForAI: false },
];

/** Build a seeded vocabulary source with the shared column layout and a fresh
 *  "never-synced" embedding status. Keeps the seven sources' structural config
 *  DRY; only the id/name vary. */
function vocab(id: string, name: string): VocabSource {
  return {
    id,
    name,
    files: [],
    fields: VOCAB_TERM_COLUMNS.map((f) => ({ ...f })),
    ingestionField: "Term",
    labelField: "Term",
    badgeField: "Thesaurus",
    embedding: {
      status: "never",
      providerId: null,
      model: null,
      dimensions: null,
      lastSyncedAt: null,
      rowsEmbedded: null,
      lastError: null,
    },
  };
}

/** Seeded vocabulary sources. Structural config only — `files` is empty and
 *  `embedding.status` is "never" because the source CSVs live beside the binary
 *  (not in the repo) and don't exist on a fresh install. The user re-adds the
 *  real files and syncs each source, same as any other fresh source. Ids are
 *  stable semantic strings so the seeded catalogue fields can reference them. */
export const _DEF_VOCAB: VocabSource[] = [
  vocab("vocab-object-type", "Object Type"),
  vocab("vocab-place", "Place"),
  vocab("vocab-material", "Material"),
  vocab("vocab-technique", "Technique"),
  vocab("vocab-subject", "Subject"),
  vocab("vocab-shape", "Shape"),
  vocab("vocab-colour", "Colour"),
];

/** Factory returning a fresh, deep-cloned default settings object. */
export function _DEF(): Settings {
  return {
    visionSystemPromptInstruction: _DEF_VISION_SYSTEM_PROMPT_INSTRUCTION,
    vocabNetCount: 20,
    vocabShortlistCount: 3,
    validationEnabled: false,
    fields: _DEF_FIELDS.map((f) => ({ ...f, vocabSources: [...f.vocabSources] })),
    vocabSources: _DEF_VOCAB.map((v) => ({ ...v, files: [...v.files], fields: [...v.fields], embedding: { ...v.embedding } })),
    providers: [] as Provider[],
    activeProvider: null,
    embeddingProviders: [] as EmbeddingProvider[],
    activeEmbeddingProvider: null,
    artefactFields: _DEF_AF.map((f) => ({ ...f })),
  };
}

// Status dot colours. Concrete hex values (not tokens) because the dot's
// background is applied as a runtime inline style — the shadcn/Tailwind token
// layer can't be referenced from a plain CSS string in JS. These match the
// semantic status colours used elsewhere (muted/amber/emerald/red) so the dot
// reads consistently with Badge/StatusIndicator colours in both themes.
export const _ST: Record<string, { label: string; clr: string }> = {
  queued: { label: "Queued", clr: "#8b8ba0" },
  processing: { label: "Processing", clr: "#d97706" },
  done: { label: "Done", clr: "#10b981" },
  error: { label: "Error", clr: "#ef4444" },
  // Same muted grey as "queued" so a cancelled row reads as "never ran" rather
  // than a failure; the distinct label disambiguates it from a pending row.
  cancelled: { label: "Cancelled", clr: "#8b8ba0" },
};

/** Random id helper, mirroring the reference. */
export function gid(): string {
  return "_" + Math.random().toString(36).slice(2, 9);
}

/** Human-readable byte size. */
export function fmt(b: number): string {
  return b < 1024 ? b + " B" : b < 1048576 ? Math.round(b / 1024) + " KB" : (b / 1048576).toFixed(1) + " MB";
}
