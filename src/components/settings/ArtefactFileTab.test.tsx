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

describe("ArtefactFileTab per-column Identify By toggle", () => {
  const expandedAf1 = { artefactFieldExpanded: { af1: true } };

  it("shows the Header Text input by default and hides the Column Letter input", () => {
    renderWith(expandedAf1, makeActions(vi.fn(), vi.fn()));

    expect(screen.getByText(/Must match a column header in the uploaded spreadsheet/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("e.g. C")).not.toBeInTheDocument();
  });

  it("swaps to the Column Letter input when the field identifies by letter", () => {
    const settings = {
      ...initialState.settings,
      artefactFields: initialState.settings.artefactFields.map((f) =>
        f.id === "af1" ? { ...f, useColumnLetter: true } : f
      ),
    };
    renderWith({ ...expandedAf1, settings }, makeActions(vi.fn(), vi.fn()));

    expect(screen.getByPlaceholderText("e.g. C")).toBeInTheDocument();
    expect(screen.queryByText(/Must match a column header in the uploaded spreadsheet/)).not.toBeInTheDocument();
  });
});
