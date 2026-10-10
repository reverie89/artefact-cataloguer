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

function renderRow(row: Partial<ArtefactRow>, artefactFields: ArtefactField[] = [af("a", "Accession No"), af("b", "Curator's Obj. Type"), af("m", "Material")], actions: AppActions = noopActions, stateExtra: Partial<AppState> = {}, index = 1) {
  const state: AppState = {
    ...initialState,
    expandedRows: { u1: true },
    settings: { ...initialState.settings, artefactFields },
    ...stateExtra,
  };
  return render(
    <ResultRow
      row={{ uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "ready", record: {}, ...row }}
      index={index}
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

describe("ResultRow row actions & stripe", () => {
  // The row calls actions.queueRow/dequeueRow/stopRow on its strip button;
  // every other action stays a no-op. The spies are created once per test and
  // returned alongside the wired proxy.
  const spyActions = () => {
    const queueRow = vi.fn();
    const dequeueRow = vi.fn();
    const stopRow = vi.fn();
    const actions = new Proxy<AppActions>({} as AppActions, {
      get: (_t, prop) =>
        prop === "queueRow" ? queueRow : prop === "dequeueRow" ? dequeueRow : prop === "stopRow" ? stopRow : () => vi.fn(),
    });
    return { actions, queueRow, dequeueRow, stopRow };
  };

  it("offers Start on a ready row, wired to queueRow", () => {
    const { actions, queueRow } = spyActions();
    renderRow({ status: "ready" }, undefined, actions);
    fireEvent.click(screen.getByRole("button", { name: "Start this record" }));
    expect(queueRow).toHaveBeenCalledWith("u1");
  });

  it("keeps a ready row's Start available while the queue runs (it joins the FIFO)", () => {
    renderRow({ status: "ready" }, undefined, noopActions, { queueRunning: true });
    expect(screen.getByRole("button", { name: "Start this record" })).toBeInTheDocument();
  });

  it("offers Stop on a queued row, wired to dequeueRow", () => {
    const { actions, dequeueRow } = spyActions();
    renderRow({ status: "queued" }, undefined, actions, { queueRunning: true });
    // No Start (it is in the work list) and no in-flight Stop variant.
    expect(screen.queryByRole("button", { name: "Start this record" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop this record" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop queueing this record" }));
    expect(dequeueRow).toHaveBeenCalledWith("u1");
  });

  it("offers Retry on error, cancelled and done rows, wired to queueRow", () => {
    const { actions, queueRow } = spyActions();
    for (const status of ["error", "cancelled", "done"] as const) {
      const { unmount } = renderRow({ status }, undefined, actions);
      fireEvent.click(screen.getByRole("button", { name: "Retry this record" }));
      unmount();
    }
    expect(queueRow).toHaveBeenCalledTimes(3);
    expect(queueRow).toHaveBeenNthCalledWith(3, "u1");
  });

  it("offers Stop on a processing row, wired to stopRow", () => {
    const { actions, stopRow } = spyActions();
    renderRow({ status: "processing" }, undefined, actions);
    fireEvent.click(screen.getByRole("button", { name: "Stop this record" }));
    expect(stopRow).toHaveBeenCalledWith("u1");
  });

  it("keeps the expanded body informational — no duplicate action buttons inside", () => {
    const { actions } = spyActions();
    // renderRow expands by default; the error bar text stays, its button goes.
    const first = renderRow({ status: "error" }, undefined, actions);
    expect(screen.getByText("Processing failed — check Logs Viewer")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Retry this record" })).toHaveLength(1);
    first.unmount();
    // Done rows: the Catalogue Fields header keeps the provider chip, not a
    // second Retry.
    renderRow({ status: "done" }, undefined, actions);
    expect(screen.getAllByRole("button", { name: "Retry this record" })).toHaveLength(1);
  });

  it("stripes every 2nd visible row (even S/N) and yields to the delete tint", () => {
    const { container: odd } = renderRow({ status: "done" });
    expect(odd.firstElementChild!.firstElementChild).not.toHaveClass("bg-muted/50");
    const { container: even } = renderRow({ status: "done" }, undefined, noopActions, {}, 2);
    expect(even.firstElementChild!.firstElementChild).toHaveClass("bg-muted/50");
  });
});
