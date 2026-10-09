import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ResultRow } from "./ResultRow";
import { initialState } from "../../app/state";
import type { AppState } from "../../app/state";
import type { AppActions } from "../../app/actions";
import type { ArtefactField, ArtefactRow } from "../../app/types";

const noopActions = new Proxy<AppActions>({} as AppActions, { get: () => () => vi.fn() });

const af = (id: string, name: string, extra: Partial<ArtefactField> = {}): ArtefactField => ({
  id, name, description: "", prompt: "", includeForAI: true, includeInExport: true, useColumnLetter: false, column: "",
  ...extra,
});

function renderRow(row: Partial<ArtefactRow>, artefactFields: ArtefactField[] = [af("a", "Accession No"), af("b", "Curator's Obj. Type"), af("m", "Material")], actions: AppActions = noopActions) {
  const state: AppState = {
    ...initialState,
    expandedRows: { u1: true },
    settings: { ...initialState.settings, artefactFields },
  };
  return render(
    <ResultRow
      row={{ uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "queued", record: {}, ...row }}
      index={1}
      state={state}
      actions={actions}
      convertFileSrc={(p) => p}
    />
  );
}

afterEach(cleanup);

describe("ResultRow Source Record", () => {
  it("renders every configured column in configured order, matching record keys loosely", () => {
    // The sheet's header is wrapped across lines inside the cell and the
    // accession column's casing differs — both must resolve to the configured
    // column (normalizeHeader matching, mirroring the parser).
    renderRow({ record: { "accession no": "X.2024.1", "Curator's\nObj. Type": "bronze mirror" } });

    const labels = ["Accession No", "Curator's Obj. Type", "Material"].map((t) => screen.getByText(t));
    expect(labels).toHaveLength(3);
    expect(labels[0].compareDocumentPosition(labels[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(labels[1].compareDocumentPosition(labels[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("X.2024.1")).toBeInTheDocument();
    expect(screen.getByText("bronze mirror")).toBeInTheDocument();
    // Truncated labels expose the full name as a hover title.
    expect(screen.getByTitle("Accession No")).toBeInTheDocument();
  });

  it("shows an em-dash for configured columns whose cell is empty in this row", () => {
    renderRow({ record: { "Accession No": "X.1" } });

    // Curator's Obj. Type and Material have no value in this row's record —
    // they still render (sparse records must not hide configured columns).
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("excludes the image-role column and unconfigured sheet columns", () => {
    renderRow(
      { record: { "Accession No": "X.1", Notes: "ivory inlay" } },
      [af("a", "Accession No"), af("img", "Image"), af("m", "Material")],
    );

    // "Image" appears only as the Image pane's header — never as a record row.
    expect(screen.getAllByText("Image")).toHaveLength(1);
    // Unconfigured sheet columns don't render at all.
    expect(screen.queryByText("Notes")).not.toBeInTheDocument();
    expect(screen.queryByText("ivory inlay")).not.toBeInTheDocument();
    // Material stays visible (empty → em-dash).
    expect(screen.getByText("Material")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("marks configured columns with include-for-AI off with the ✗AI pill", () => {
    renderRow(
      { record: { "Accession No": "X.1", Material: "bronze" } },
      [af("a", "Accession No"), af("m", "Material", { includeForAI: false, includeInExport: false })],
    );

    const pill = screen.getByTitle("Not sent to AI");
    expect(pill).toHaveTextContent("AI");
    // The pill sits next to its own label — Material's row, not Accession No's.
    expect(pill.parentElement).toHaveTextContent("Material");
    // Columns with include-for-AI on carry no pill.
    expect(screen.getByText("Accession No").querySelector("span[title='Not sent to AI']")).toBeNull();
  });

  it("highlights the row while its delete confirmation is open", async () => {
    let resolveDelete: (v: void) => void = () => {};
    const deleteRow = vi.fn(() => new Promise<void>((res) => { resolveDelete = res; }));
    const actions = new Proxy<AppActions>({} as AppActions, {
      get: (_t, prop) => (prop === "deleteRow" ? deleteRow : () => vi.fn()),
    });
    const { container } = renderRow({ record: { "Accession No": "X.1" } }, undefined, actions);

    fireEvent.click(screen.getByRole("button", { name: "Delete record" }));
    // The confirmation is "open" (deleteRow pending): the row tints and its
    // delete button turns destructive so the target stays identifiable
    // behind the modal.
    expect(container.firstElementChild).toHaveClass("bg-destructive/10");

    await act(async () => { resolveDelete(); });
    expect(container.firstElementChild).not.toHaveClass("bg-destructive/10");
  });
});
