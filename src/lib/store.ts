// Persistence bridge: load/save the single settings file beside the binary
// via the Rust `load_state` / `save_state` commands. No localStorage.

import { invoke } from "@tauri-apps/api/core";
import { _DEF, _DEF_SYSTEM_PROMPT_INSTRUCTION } from "../app/defaults";
import { PersistedSettingsSchema } from "../app/schema";
import type { Settings, StateBundle } from "../app/types";

export interface LoadedState {
  settings: Settings;
  darkMode: boolean;
  zoom: number;
}

/** Read the persisted bundle, falling back to defaults if anything is off. */
export async function loadState(): Promise<LoadedState> {
  try {
    const bundle = await invoke<StateBundle>("load_state");
    // Validate the persisted (hand-editable, possibly older-schema) settings
    // before trusting them, instead of casting blindly.
    const parsed = PersistedSettingsSchema.safeParse(bundle.ac_settings);
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
 *  catalogue arrays from `_DEF()` when absent (normal first-run path). */
export function withDefaultSettings(settings: Settings): Settings {
  const def = _DEF();
  return {
    ...settings,
    systemPromptInstruction: settings.systemPromptInstruction ?? _DEF_SYSTEM_PROMPT_INSTRUCTION,
    systemPromptContractOverride: settings.systemPromptContractOverride ?? "",
    activeProvider: settings.activeProvider ?? settings.providers?.[0]?.id ?? null,
    fields: settings.fields ?? def.fields,
    vocabularyLists: settings.vocabularyLists ?? def.vocabularyLists,
    providers: settings.providers ?? [],
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
