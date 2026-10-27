import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { VisionProvidersSection } from "./VisionProvidersSection";
import { initialState } from "../../app/state";
import type { AppState } from "../../app/state";
import type { AppActions } from "../../app/actions";
import type { Provider } from "../../app/types";

// Proxy-backed no-op actions (ArtefactFileTab.test.tsx pattern).
function makeActions(): AppActions {
  return new Proxy<AppActions>({} as AppActions, {
    get: () => () => vi.fn(),
  });
}

function renderWith(provider: Provider) {
  const state: AppState = {
    ...initialState,
    settings: { ...initialState.settings, providers: [provider] },
    providerExpanded: { [provider.id]: true },
  };
  return render(<VisionProvidersSection state={state} actions={makeActions()} />);
}

afterEach(cleanup);

function provider(overrides: Partial<Provider>): Provider {
  return {
    id: "p1", name: "SG GovTech", baseUrl: "https://api-public.ai.tech.gov.sg/platform/gpt-6-luna", apiKey: "k",
    model: "", apiFormat: "custom", connStatus: "untested",
    ...overrides,
  };
}

describe("VisionProvidersSection custom API format", () => {
  it("shows the auth choice, message template, and no model/test/thinking", () => {
    renderWith(provider({}));

    // The base URL IS the request URL — the placeholder is a plain base.
    expect(screen.getByPlaceholderText("https://gateway.example")).toBeInTheDocument();
    // Auth: Segmented picker, Bearer by default (no header-name input).
    expect(screen.getByText("Bearer")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("x-api-key")).not.toBeInTheDocument();
    // Message (JSON) + template loader.
    expect(screen.getByPlaceholderText('{"input": "{{input}}"}')).toBeInTheDocument();
    expect(screen.getByText("Load template")).toBeInTheDocument();
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Test Connection/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    // No test → no status; no model → the Model cell is also a dash
    // (exactly two: Model + Status columns).
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("reveals the header-name input once Custom auth is picked", () => {
    renderWith(provider({ authHeader: "x-api-key" }));

    expect(screen.getByPlaceholderText("x-api-key")).toBeInTheDocument();
  });

  it("keeps the Test Connection flow for the listed formats", () => {
    renderWith(provider({ apiFormat: "openai", baseUrl: "https://api.test/v1", model: "m1", modelOptions: ["m1"] }));

    expect(screen.getByRole("button", { name: /Test Connection/i })).toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("https://gateway.example")).not.toBeInTheDocument();
    expect(screen.queryByText("Load template")).not.toBeInTheDocument();
  });
});
