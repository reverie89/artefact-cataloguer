import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ArtefactFileTab } from "./ArtefactFileTab";
import { initialState } from "../../app/state";
import type { AppState } from "../../app/state";
import type { AppActions } from "../../app/actions";
import { _DEF_ARTEFACT_ANALYSIS_SYSTEM_PROMPT_INSTRUCTION } from "../../app/defaults";

// Proxy-backed no-op actions (ResultsPanel.test.tsx pattern) with the two
// handlers the Reset button drives swapped for spies.
function makeActions(updateSpy: ReturnType<typeof vi.fn>, editingSpy: ReturnType<typeof vi.fn>): AppActions {
  return new Proxy<AppActions>({} as AppActions, {
    get: (_t, prop) => {
      if (prop === "updateArtefactAnalysisSystemPromptInstruction") return updateSpy;
      if (prop === "setPromptEditing") return editingSpy;
      return () => vi.fn();
    },
  });
}

function renderWith(overrides: Partial<AppState>, actions: AppActions) {
  const state: AppState = { ...initialState, ...overrides };
  return render(<ArtefactFileTab state={state} actions={actions} />);
}

afterEach(cleanup);

describe("ArtefactFileTab System Prompt reset", () => {
  it("seeds the draft with the default prompt, not an empty string", async () => {
    const user = userEvent.setup();
    const updateSpy = vi.fn();
    const editingSpy = vi.fn();
    renderWith({ contractEditing: true }, makeActions(updateSpy, editingSpy));

    await user.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(updateSpy).toHaveBeenCalledWith(_DEF_ARTEFACT_ANALYSIS_SYSTEM_PROMPT_INSTRUCTION);
    expect(editingSpy).toHaveBeenCalledWith(false);
  });
});

describe("ArtefactFileTab column identification mode", () => {
  it("shows the per-field letter binding only in letter mode, and persists mode changes immediately", async () => {
    const user = userEvent.setup();
    const modeSpy = vi.fn();
    const actions = new Proxy<AppActions>({} as AppActions, {
      get: (_t, prop) => {
        if (prop === "setArtefactColumnMode") return modeSpy;
        return () => vi.fn();
      },
    });
    renderWith(
      {
        settings: { ...initialState.settings, artefactColumnMode: "letter" },
        // Expand the first default column (Image) so its editor is visible.
        artefactFieldExpanded: { af1: true },
      },
      actions,
    );

    expect(screen.getByPlaceholderText("e.g. C")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Column name" }));
    expect(modeSpy).toHaveBeenCalledWith("name");
  });

  it("hides the letter binding in name mode", () => {
    renderWith({ artefactFieldExpanded: { af1: true } }, makeActions(vi.fn(), vi.fn()));

    expect(screen.queryByPlaceholderText("e.g. C")).not.toBeInTheDocument();
  });
});
