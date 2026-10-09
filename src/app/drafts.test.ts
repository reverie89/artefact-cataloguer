import { describe, expect, it } from "vitest";

import { isTabDirty } from "./drafts";
import { initialState, embeddingProviderDraftFromSettings, providerDraftFromSettings } from "./state";
import type { AppState, EmbeddingProviderDraft, ProviderDraft } from "./state";
import type { Settings } from "./types";

/** Settings whose only populated providers are the ones a test cares about. */
function settingsWith(overrides: Partial<Settings>): Settings {
  return { ...initialState.settings, ...overrides };
}

function stateWith(overrides: Partial<AppState>): AppState {
  return { ...initialState, settingsTab: "modelProviders", ...overrides };
}

const CHAT = { id: "p1", name: "Chat", baseUrl: "https://x/v1", apiKey: "k", model: "gpt", apiFormat: "openai" as const };
const EMB = { id: "e1", name: "Emb", baseUrl: "https://x/v1/embeddings", apiKey: "k", model: "text-embedding-3-small", apiFormat: "openai" as const };

describe("isTabDirty modelProviders — machine-written test fields never flag the tab", () => {
  it("a draft differing only in modelOptions/connStatus is clean", () => {
    const settings = settingsWith({ providers: [{ ...CHAT, modelOptions: ["gpt"], connStatus: "untested" }] });
    const draft: ProviderDraft = {
      ...providerDraftFromSettings(settings),
      providers: [{ ...providerDraftFromSettings(settings).providers[0], modelOptions: ["gpt", "gpt-next"], connStatus: "ok" }],
    };
    expect(isTabDirty(stateWith({ providerDraft: draft, settings }), "modelProviders")).toBe(false);
  });

  it("an embedding draft differing only in modelOptions/connStatus is clean", () => {
    const settings = settingsWith({ embeddingProviders: [{ ...EMB, modelOptions: ["m1"], connStatus: "untested" }] });
    const fromSettings = embeddingProviderDraftFromSettings(settings);
    const draft: EmbeddingProviderDraft = {
      ...fromSettings,
      providers: [{ ...fromSettings.providers[0], modelOptions: ["m1", "m2"], connStatus: "ok" }],
    };
    expect(isTabDirty(stateWith({ embProviderDraft: draft, settings }), "modelProviders")).toBe(false);
  });

  it("a user-authored field edit still flags the tab", () => {
    const settings = settingsWith({ embeddingProviders: [EMB] });
    const fromSettings = embeddingProviderDraftFromSettings(settings);
    const draft: EmbeddingProviderDraft = {
      ...fromSettings,
      providers: [{ ...fromSettings.providers[0], model: "text-embedding-3-large" }],
    };
    expect(isTabDirty(stateWith({ embProviderDraft: draft, settings }), "modelProviders")).toBe(true);
  });

  it("a chat thinking-only edit flags the tab", () => {
    const settings = settingsWith({ providers: [CHAT] });
    const fromSettings = providerDraftFromSettings(settings);
    const draft: ProviderDraft = {
      ...fromSettings,
      providers: [{ ...fromSettings.providers[0], thinking: "low" }],
    };
    expect(isTabDirty(stateWith({ providerDraft: draft, settings }), "modelProviders")).toBe(true);
  });

  it("a draft provider missing from settings (new row) flags the tab", () => {
    const settings = settingsWith({ embeddingProviders: [] });
    const draft = embeddingProviderDraftFromSettings(settings);
    draft.providers = [{ id: "new", name: "", baseUrl: "", apiKey: "", model: "", apiFormat: "openai", modelOptions: [], imageInputModels: null, connStatus: "untested" }];
    expect(isTabDirty(stateWith({ embProviderDraft: draft, settings }), "modelProviders")).toBe(true);
  });

  it("an active-selection flip flags the tab", () => {
    const settings = settingsWith({ embeddingProviders: [EMB], activeEmbeddingProvider: "e1" });
    const draft: EmbeddingProviderDraft = { ...embeddingProviderDraftFromSettings(settings), activeProvider: "other" };
    expect(isTabDirty(stateWith({ embProviderDraft: draft, settings }), "modelProviders")).toBe(true);
  });

  it("null drafts are never dirty", () => {
    const settings = settingsWith({ providers: [CHAT], embeddingProviders: [EMB] });
    expect(isTabDirty(stateWith({ providerDraft: null, embProviderDraft: null, settings }), "modelProviders")).toBe(false);
  });
});
