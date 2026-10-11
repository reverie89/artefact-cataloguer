import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { UploadPanel } from "./UploadPanel";
import { initialState } from "../../app/state";
import type { AppState, UploadFile } from "../../app/state";
import type { AppActions } from "../../app/actions";

const invalidFile: UploadFile = {
  id: "f1",
  name: "sheet.xlsx",
  size: 100,
  sizeLabel: "100 B",
  status: "invalid",
  errors: [{ message: "Missing required column: Title" }],
};

function actionsWith(overrides: Partial<AppActions> = {}): AppActions {
  return {
    onUploadClick: vi.fn(),
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
    removeFile: vi.fn(),
    ...overrides,
  } as AppActions;
}

function renderWith(overrides: Partial<AppState>, actions: Partial<AppActions> = {}) {
  return render(<UploadPanel state={{ ...initialState, ...overrides }} actions={actionsWith(actions)} />);
}

afterEach(cleanup);

describe("UploadPanel", () => {
  it("shows the standard prompt when idle", () => {
    renderWith({});
    expect(screen.getByText("Drop Artefact files here")).toBeInTheDocument();
  });

  it("renders the error card inside the dropzone with its reasons and a retry affordance", () => {
    renderWith({ files: [invalidFile] });

    expect(screen.getByText("sheet.xlsx — not imported")).toBeInTheDocument();
    expect(screen.getByText(/Missing required column: Title/)).toBeInTheDocument();
    expect(screen.getByText(/Required columns:/)).toBeInTheDocument();
    // The retry line replaces the dead-end blank box the old layout showed.
    expect(screen.getByText(/Drop more files here/)).toBeInTheDocument();
  });

  it("keeps the dropzone clickable while an error card is showing", async () => {
    const onUploadClick = vi.fn();
    const user = userEvent.setup();
    renderWith({ files: [invalidFile] }, { onUploadClick });

    // The card body is part of the single click/drop target — a failed import
    // must not dead-end the panel (the old layout blocked clicks here).
    await user.click(screen.getByText("sheet.xlsx — not imported"));
    expect(onUploadClick).toHaveBeenCalledTimes(1);
  });

  it("dismisses an error card without opening the file picker", async () => {
    const onUploadClick = vi.fn();
    const removeFile = vi.fn();
    const user = userEvent.setup();
    renderWith({ files: [invalidFile] }, { onUploadClick, removeFile });

    await user.click(screen.getByRole("button", { name: "Dismiss sheet.xlsx" }));
    expect(removeFile).toHaveBeenCalledWith("f1");
    expect(onUploadClick).not.toHaveBeenCalled();
  });
});
