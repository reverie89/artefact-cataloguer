import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { ResultsPanel } from "./ResultsPanel";
import { initialState } from "../../app/state";
import type { AppState } from "../../app/state";
import type { AppActions } from "../../app/actions";

// Minimal no-op actions — the tested behaviour is driven entirely by state, so
// the action callbacks only need to exist with the right shape.
const noopActions = new Proxy<AppActions>(
  {} as AppActions,
  { get: () => () => vi.fn() },
);

function renderWith(overrides: Partial<AppState>, actions: AppActions = noopActions) {
  const state: AppState = { ...initialState, ...overrides };
  return render(<ResultsPanel state={state} actions={actions} convertFileSrc={(p) => `asset://${p}`} />);
}

afterEach(cleanup);

describe("ResultsPanel header visibility", () => {
  it("hides the search/columns/filter row and the S/N|Status header when there are no result items", () => {
    renderWith({ results: [] });

    // The whole sticky toolbar (search box, column picker, status filter,
    // export) and the table column-header row are gated on having rows.
    expect(screen.queryByPlaceholderText("Search artefacts…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /columns/i })).not.toBeInTheDocument();
    expect(screen.queryByText("S/N")).not.toBeInTheDocument();
  });

  it("shows the import hint when there are no records", () => {
    renderWith({ results: [] });
    expect(screen.getByText(/import an artefact file above/i)).toBeInTheDocument();
  });

  it("shows the header row as soon as there is at least one result item", () => {
    renderWith({
      results: [{ uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "done", record: { "Object Name": "Cup" } }],
    });

    expect(screen.getByPlaceholderText("Search artefacts…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /columns/i })).toBeInTheDocument();
  });
});

describe("ResultsPanel file groups", () => {
  it("renders one group header per source file with its progress pill and delete affordances", () => {
    renderWith({
      results: [
        { uid: "u1", fileId: "f1", sourceName: "survey.xlsx", status: "done", record: {} },
        { uid: "u2", fileId: "f1", sourceName: "survey.xlsx", status: "queued", record: {} },
        { uid: "u3", fileId: "f2", sourceName: "loans.xlsx", status: "error", record: {} },
      ],
    });

    expect(screen.getByText("survey.xlsx")).toBeInTheDocument();
    expect(screen.getByText("loans.xlsx")).toBeInTheDocument();
    expect(screen.getByText("1/2 records OK")).toBeInTheDocument();
    expect(screen.getByText("1 record")).toBeInTheDocument();
    expect(screen.getByText("1 error")).toBeInTheDocument();
    // Delete-all per group, per-row delete per record.
    expect(screen.getByRole("button", { name: /delete all records from survey\.xlsx/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete all records from loans\.xlsx/i })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Delete record" })).toHaveLength(3);
  });

  it("shows a bare record count before processing starts, with no failure pills", () => {
    renderWith({
      results: [
        { uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "queued", record: {} },
        { uid: "u2", fileId: "f1", sourceName: "a.xlsx", status: "queued", record: {} },
      ],
    });

    expect(screen.getByText("2 records")).toBeInTheDocument();
    expect(screen.queryByText(/records OK/)).not.toBeInTheDocument();
    expect(screen.queryByText("1 error")).not.toBeInTheDocument();
    expect(screen.queryByText("1 cancelled")).not.toBeInTheDocument();
  });

  it("marks the pill OK once every record is done", () => {
    renderWith({
      results: [
        { uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "done", record: {} },
        { uid: "u2", fileId: "f1", sourceName: "a.xlsx", status: "done", record: {} },
      ],
    });

    expect(screen.getByText("2 records OK")).toBeInTheDocument();
  });

  it("shows per-group error and cancelled pills alongside the partial progress count", () => {
    renderWith({
      results: [
        { uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "done", record: {} },
        { uid: "u2", fileId: "f1", sourceName: "a.xlsx", status: "error", record: {} },
        { uid: "u3", fileId: "f1", sourceName: "a.xlsx", status: "cancelled", record: {} },
        { uid: "u4", fileId: "f1", sourceName: "a.xlsx", status: "queued", record: {} },
      ],
    });

    expect(screen.getByText("1/4 records OK")).toBeInTheDocument();
    expect(screen.getByText("1 error")).toBeInTheDocument();
    expect(screen.getByText("1 cancelled")).toBeInTheDocument();
  });

  it("highlights the whole group while its delete-all confirmation is open", async () => {
    let resolveDelete: (v: void) => void = () => {};
    const deleteFileRows = vi.fn(() => new Promise<void>((res) => { resolveDelete = res; }));
    const actions = new Proxy<AppActions>({} as AppActions, {
      get: (_t, prop) => (prop === "deleteFileRows" ? deleteFileRows : () => vi.fn()),
    });
    const { container } = renderWith({
      results: [{ uid: "u1", fileId: "f1", sourceName: "survey.xlsx", status: "queued", record: {} }],
    }, actions);

    fireEvent.click(screen.getByRole("button", { name: /delete all records from survey\.xlsx/i }));
    // The confirmation is "open" (deleteFileRows pending): the group wrapper —
    // header + its rows — tints so the target stays identifiable behind the
    // modal. The other group would stay untouched.
    expect(screen.getByText("survey.xlsx").closest('[class*="bg-destructive/10"]')).not.toBeNull();

    await act(async () => { resolveDelete(); });
    expect(screen.getByText("survey.xlsx").closest('[class*="bg-destructive/10"]')).toBeNull();
    expect(container.querySelector('[class*="bg-destructive/10"]')).toBeNull();
  });

  it("hides a group whose rows all fail the search, keeping visible groups", () => {
    renderWith({
      resultsSearch: "cup",
      searchColsAf: ["af2"], // Object Name
      searchColsCat: [],
      results: [
        { uid: "u1", fileId: "f1", sourceName: "survey.xlsx", status: "done", record: { "Object Name": "Cup" } },
        { uid: "u2", fileId: "f2", sourceName: "loans.xlsx", status: "done", record: { "Object Name": "Bowl" } },
      ],
    });

    expect(screen.getByText("survey.xlsx")).toBeInTheDocument();
    expect(screen.queryByText("loans.xlsx")).not.toBeInTheDocument();
  });
});

describe("ResultsPanel queue controls", () => {
  it("shows a pulsing Start (and no Stop) when rows are queued and the queue is idle", () => {
    renderWith({
      results: [{ uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "queued", record: {} }],
    });

    const start = screen.getByRole("button", { name: /start/i });
    expect(start.className).toContain("animate-pulse");
    expect(screen.queryByRole("button", { name: /stop/i })).not.toBeInTheDocument();
  });

  it("swaps Start for Stop while the queue is running", () => {
    renderWith({
      queueRunning: true,
      results: [{ uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "processing", record: {} }],
    });

    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start/i })).not.toBeInTheDocument();
  });

  it("shows Retry with the failed count when error/cancelled rows exist", () => {
    renderWith({
      results: [
        { uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "error", record: {} },
        { uid: "u2", fileId: "f1", sourceName: "a.xlsx", status: "cancelled", record: {} },
      ],
    });

    const retry = screen.getByRole("button", { name: /retry/i });
    expect(within(retry).getByText("2")).toBeInTheDocument();
  });
});

describe("ResultsPanel empty-scope search", () => {
  it("shows the empty-scope hint (not rows) when no columns are selected and a query is typed", () => {
    // Two rows that *would* match a "cup" query if any AF column were in scope,
    // but the scope is empty so the filter returns nothing. Collapsed rows
    // render only their index + status label ("Done"), so assert on those.
    renderWith({
      resultsSearch: "cup",
      searchColsAf: [],
      searchColsCat: [],
      results: [
        { uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "done", record: { "Object Name": "Cup" } },
        { uid: "u2", fileId: "f1", sourceName: "a.xlsx", status: "done", record: { "Object Name": "Bowl" } },
      ],
    });

    expect(screen.getByText(/select at least one column/i)).toBeInTheDocument();
    // No collapsed row renders — neither status label is present.
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
  });

  it("matches rows when an AF column is in scope and the query hits it", () => {
    renderWith({
      resultsSearch: "cup",
      searchColsAf: ["af2"], // Object Name
      searchColsCat: [],
      results: [{ uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "done", record: { "Object Name": "Cup" } }],
    });

    expect(screen.queryByText(/select at least one column/i)).not.toBeInTheDocument();
    // The non-matching Bowl row is filtered out; the matching Cup row renders
    // its collapsed "Done" status label.
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("shows all rows when the scope is empty but no query is typed (the !q short-circuit)", () => {
    renderWith({
      resultsSearch: "",
      searchColsAf: [],
      searchColsCat: [],
      results: [{ uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "done", record: { "Object Name": "Cup" } }],
    });

    // No empty-scope hint, no "no matches" hint — the row renders.
    expect(screen.queryByText(/select at least one column/i)).not.toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("shows the generic 'no matches' hint (not the empty-scope one) when scope is set but nothing matches", () => {
    renderWith({
      resultsSearch: "nonexistent",
      searchColsAf: ["af2"], // Object Name
      searchColsCat: [],
      results: [{ uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "done", record: { "Object Name": "Cup" } }],
    });

    expect(screen.getByText(/try a different search or filter/i)).toBeInTheDocument();
    expect(screen.queryByText(/select at least one column/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
  });
});
