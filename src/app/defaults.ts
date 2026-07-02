// Default settings, catalogue fields, and vocab lists. There is no demo data
// here — cataloguing requires a real uploaded spreadsheet and a live provider.

import type { ArtefactField, CatalogueField, Provider, Settings, VocabList } from "./types";

/** Built-in vocabulary term sets. */
export const _VT: Record<string, string[]> = {
  v1: [
    "Abstract",
    "Art Deco",
    "Art Nouveau",
    "Baroque",
    "Classical",
    "Colonial",
    "Contemporary",
    "Cubist",
    "Expressionist",
    "Gothic",
    "Impressionist",
    "Minimalist",
    "Modernist",
    "Neoclassical",
    "Renaissance",
    "Rococo",
    "Romantic",
    "Realist",
    "Carving",
    "Casting",
    "Forging",
    "Engraving",
    "Etching",
    "Lithography",
    "Woodcut",
    "Screen Printing",
    "Wheel Throwing",
    "Hand Building",
    "Weaving",
    "Knitting",
    "Embroidery",
    "Painting",
    "Watercolour Painting",
    "Oil Painting",
    "Acrylic Painting",
    "Gilding",
    "Lacquering",
    "Joinery",
    "Welding",
    "Casting in Bronze",
    "Lost-wax Casting",
    "Slip Casting",
  ],
  v2: [
    "Wood",
    "Oak",
    "Pine",
    "Walnut",
    "Teak",
    "Bamboo",
    "Paper",
    "Parchment",
    "Vellum",
    "Canvas",
    "Cotton",
    "Linen",
    "Silk",
    "Wool",
    "Leather",
    "Bronze",
    "Brass",
    "Copper",
    "Iron",
    "Steel",
    "Silver",
    "Gold",
    "Aluminium",
    "Glass",
    "Ceramic",
    "Porcelain",
    "Earthenware",
    "Stone",
    "Marble",
    "Granite",
    "Jade",
    "Ivory",
    "Bone",
    "Horn",
    "Shell",
    "Lacquer",
    "Plastic",
    "Acrylic",
    "Resin",
  ],
};

export const _DEF_AF: ArtefactField[] = [
  { id: "af1", name: "Obj. Number", required: true, description: "Unique identifier for the artefact" },
  { id: "af2", name: "Title", required: true, description: "Name or title of the artefact" },
  { id: "af3", name: "Category", required: true, description: "Classification or collection category" },
  { id: "af4", name: "Image", required: true, description: "Image embedded directly in the spreadsheet cell" },
];

export const _DEF_FIELDS: CatalogueField[] = [
  { id: "f3", name: "Description", type: "open", layout: "row", prompt: "Write a concise, factual cataloguing description suitable for a museum record. Focus on observable physical attributes.", vocabSources: [] },
  { id: "f4", name: "Style", type: "vocab", layout: "row", prompt: "", vocabSources: ["v1"] },
  { id: "f1", name: "Material", type: "vocab", layout: "row", prompt: "Identify all physical materials, construction techniques, and surface treatments visible in the image.", vocabSources: ["v2"] },
  { id: "f5", name: "Inscription", type: "open", layout: "row", prompt: "If handwriting or motif is identified on the object and legible, answer in the following format:\n```\nRaw text:\n{words as-is identified}\n\nEnglish Translation:\n{English translation}\n```\nDo not assume. If handwriting or motif is illegible, reply as \"N/A\"", vocabSources: [] },
];

export const _DEF_SYSTEM_PROMPT_INSTRUCTION =
  "You are an experienced museum cataloguing assistant specialized in Southeast Asia artefact collections. Use museum, art-historical, and cultural context from Southeast Asia when interpreting the artefact record and image. Prioritize accurate, evidence-based catalogue language and avoid unsupported claims. Assume the object in image is part of an artwork collection and/or of historical significance.";

/** Part 2 of the system instructions — the read-only output contract the
 *  response parser relies on. Source of truth for the default; an explicit
 *  non-empty `systemPromptContractOverride` in settings takes its place. */
export const _DEF_SYSTEM_PROMPT_CONTRACT =
  'Using the "Artefact File information" and image provided below, catalogue each field listed below. Respond as strict JSON only — no prose, no code fences. For every field, echo the field name in the form _<Field Name>_ as the JSON key — this applies to controlled-vocabulary fields and open-ended fields alike. For each controlled-vocabulary field, the value is an array of up to 3 ranked candidates {"value":"...","confidence":0.0} drawn only from that field\'s list (fewer is fine; never more than 3, never a term outside the list). For each open-ended field, the value is a single string. Every requested field name must appear as a _<Field Name>_ key.';

export const _DEF_VOCAB: VocabList[] = [
  { id: "v1", filename: "style.csv", name: "Style", terms: 42, termData: [..._VT.v1], uploadDate: "2026-07-02" },
  { id: "v2", filename: "material.csv", name: "Material", terms: 39, termData: [..._VT.v2], uploadDate: "2026-07-02" },
];

/** Factory returning a fresh, deep-cloned default settings object. */
export function _DEF(): Settings {
  return {
    systemPromptInstruction: _DEF_SYSTEM_PROMPT_INSTRUCTION,
    systemPromptContractOverride: "",
    fields: _DEF_FIELDS.map((f) => ({ ...f, vocabSources: [...f.vocabSources] })),
    vocabularyLists: _DEF_VOCAB.map((v) => ({ ...v, termData: [...v.termData] })),
    providers: [] as Provider[],
    activeProvider: null,
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
