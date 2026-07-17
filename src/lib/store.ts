// Persistence bridge: load/save the single settings file beside the binary
// via the Rust `load_state` / `save_state` commands. No localStorage.

import { invoke } from "@tauri-apps/api/core";
import { _DEF, _DEF_VISION_SYSTEM_PROMPT_INSTRUCTION } from "../app/defaults";
import { PersistedSettingsSchema } from "../app/schema";
import type { Settings, StateBundle, VocabSource } from "../app/types";

export interface LoadedState {
  settings: Settings;
  darkMode: boolean;
  zoom: number;
}

/** Shape of a pre-upgrade `VocabList` — the only fields the migration reads. */
interface LegacyVocabList {
  id: string;
  filename?: string;
  name?: string;
  termData?: string[];
  uploadDate?: string;
}

/**
 * Migrate a raw persisted settings object's old `vocabularyLists` key (one
 * file = one flat term array) to the current `vocabSources` shape, *before*
 * `PersistedSettingsSchema` ever sees it — the schema only ever validates the
 * current shape. No-op when `vocabSources` is already present (current-format
 * file) or `vocabularyLists` is absent (fresh install / already migrated).
 *
 * The old flat `termData` isn't reconstructable into a real uploaded file, so
 * it's dropped here — the migrated source starts empty (no files, no synced
 * index) and the user re-adds real files and syncs it, same as any other
 * fresh source.
 */
export function migrateLegacyVocabularyLists(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  if (obj.vocabSources !== undefined || !Array.isArray(obj.vocabularyLists)) return raw;
  const migrated: VocabSource[] = (obj.vocabularyLists as LegacyVocabList[]).map((vl) => ({
    id: vl.id,
    name: vl.name || vl.filename?.replace(/\.[^.]+$/, "") || "Untitled source",
    files: [],
    fields: [],
    ingestionField: null,
    labelField: null,
    badgeField: null,
    embedding: {
      status: "never",
      providerId: null, model: null, dimensions: null, lastSyncedAt: null, rowsEmbedded: null, lastError: null,
    },
  }));
  const { vocabularyLists: _drop, ...rest } = obj;
  void _drop;
  return { ...rest, vocabSources: migrated };
}

/**
 * Always-run pre-pass (after {@link migrateLegacyVocabularyLists}) that strips
 * the removed `builtin`/`legacyTerms` fields and rewrites any lingering
 * `status: "legacy"` to `"never"` on a raw persisted settings object, before
 * schema validation. A no-op on settings already in the current shape.
 * Without this, a settings.json written before builtin/legacy were removed
 * would fail `PersistedSettingsSchema.safeParse` (an unrelated extra field on
 * a strict-ish shape) and `loadState` would fall back to a full defaults
 * reset — wiping providers/fields/everything, not just vocab.
 */
export function stripBuiltinLegacyVocabFields(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.vocabSources)) return raw;
  const stripped = (obj.vocabSources as Record<string, unknown>[]).map((vs) => {
    const { builtin: _b, legacyTerms: _l, ...rest } = vs;
    void _b; void _l;
    const embedding = rest.embedding as Record<string, unknown> | undefined;
    if (embedding?.status === "legacy") {
      return { ...rest, embedding: { ...embedding, status: "never" } };
    }
    return rest;
  });
  return { ...obj, vocabSources: stripped };
}

/** Read the persisted bundle, falling back to defaults if anything is off. */
export async function loadState(): Promise<LoadedState> {
  try {
    const bundle = await invoke<StateBundle>("load_state");
    // Validate the persisted (hand-editable, possibly older-schema) settings
    // before trusting them, instead of casting blindly. Legacy vocab lists are
    // migrated first so the schema only ever sees the current shape.
    const migrated = stripBuiltinLegacyVocabFields(migrateLegacyVocabularyLists(bundle.ac_settings));
    const parsed = PersistedSettingsSchema.safeParse(migrated);
    let settings: Settings;
    if (parsed.success) {
      settings = withDefaultSettings(parsed.data as Settings);
    } else {
      settings = withDefaultSettings(_DEF());
    }
    const darkMode = bundle.ac_darkMode !== undefined ? bundle.ac_darkMode === "true" : true;
    const zoom = bundle.ac_zoom ? parseFloat(bundle.ac_zoom) : 1.0;
    const z = !isNaN(zoom) && zoom > 0 ? zoom : 1.0;
    return { settings, darkMode, zoom: z };
  } catch {
    const defaults = withDefaultSettings(_DEF());
    return { settings: defaults, darkMode: true, zoom: 1.0 };
  }
}

/** Fill fields added after older settings files were saved, and seed
 *  catalogue arrays from `_DEF()` when absent (normal first-run path).
 *
 *  Pre-XML-pipeline keys (`systemPromptInstruction`, `systemPromptContractOverride`
 *  — the old Call-2 prompt and JSON contract) are dropped here: the JSON contract
 *  is fundamentally replaced by the fixed XML contract built in Rust, so its old
 *  value cannot carry over. The persona now lives in `visionSystemPromptInstruction`. */
export function withDefaultSettings(settings: Settings): Settings {
  const def = _DEF();
  return {
    visionSystemPromptInstruction: settings.visionSystemPromptInstruction ?? _DEF_VISION_SYSTEM_PROMPT_INSTRUCTION,
    vocabNetCount: settings.vocabNetCount ?? def.vocabNetCount,
    vocabShortlistCount: settings.vocabShortlistCount ?? def.vocabShortlistCount,
    call3Enabled: settings.call3Enabled ?? def.call3Enabled,
    activeProvider: settings.activeProvider ?? settings.providers?.[0]?.id ?? null,
    fields: settings.fields ?? def.fields,
    vocabSources: settings.vocabSources ?? def.vocabSources,
    providers: settings.providers ?? [],
    embeddingProviders: settings.embeddingProviders ?? [],
    activeEmbeddingProvider: settings.activeEmbeddingProvider ?? settings.embeddingProviders?.[0]?.id ?? null,
    artefactFields: settings.artefactFields ?? def.artefactFields,
  };
}

/** Persist the whole bundle (settings + dark + zoom) atomically. */
export function saveState(settings: Settings, darkMode: boolean, zoom: number): Promise<void> {
  const bundle: StateBundle = {
    ac_settings: settings,
    ac_darkMode: String(darkMode),
    ac_zoom: String(zoom),
  };
  return invoke<void>("save_state", { bundle });
}

/** Debounced saver used after settings mutations. */
export function makeDebouncedSaver(getState: () => { settings: Settings; darkMode: boolean; zoom: number }, ms = 300) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      const { settings, darkMode, zoom } = getState();
      void saveState(settings, darkMode, zoom);
    }, ms);
  };
}
