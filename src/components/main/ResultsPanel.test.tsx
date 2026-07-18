import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ResultsPanel } from "./ResultsPanel";
import { initialState } from "../../app/state";
import type { AppState } from "../../app/state";
import type { AppActions } from "../../app/actions";

// Minimal no-op actions — the empty-scope behaviour is driven entirely by
// state, so the action callbacks only need to exist with the right shape.
const noopActions = new Proxy<AppActions>(
  {} as AppActions,
  { get: () => () => vi.fn() },
);

function renderWith(overrides: Partial<AppState>) {
  const state: AppState = { ...initialState, ...overrides };
  return render(<ResultsPanel state={state} actions={noopActions} convertFileSrc={(p) => `asset://${p}`} />);
}

afterEach(cleanup);

describe("ResultsPanel header visibility", () => {
  it("hides the search/columns/filter row and the S/N|Status header when there are no result items", () => {
    renderWith({ parseStatus: "idle", results: [] });

    // The whole sticky toolbar (search box, column picker, status filter,
    // export) and the table column-header row are gated on having rows.
    expect(screen.queryByPlaceholderText("Search artefacts…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /columns/i })).not.toBeInTheDocument();
    expect(screen.queryByText("S/N")).not.toBeInTheDocument();
  });

  it("shows the header row as soon as there is at least one result item", () => {
    renderWith({
      parseStatus: "completed",
      results: [{ uid: "u1", status: "done", record: { "Object Name": "Cup" } }],
    });

    expect(screen.getByPlaceholderText("Search artefacts…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /columns/i })).toBeInTheDocument();
  });
});

describe("ResultsPanel empty-scope search", () => {
  it("shows the empty-scope hint (not rows) when no columns are selected and a query is typed", () => {
    // Two rows that *would* match a "cup" query if any AF column were in scope,
    // but the scope is empty so the filter returns nothing. Collapsed rows
    // render only their index + status label ("Done"), so assert on those.
    renderWith({
      parseStatus: "completed",
      resultsSearch: "cup",
      searchColsAf: [],
      searchColsCat: [],
      results: [
        { uid: "u1", status: "done", record: { "Object Name": "Cup" } },
        { uid: "u2", status: "done", record: { "Object Name": "Bowl" } },
      ],
    });

    expect(screen.getByText(/select at least one column/i)).toBeInTheDocument();
    // No collapsed row renders — neither status label is present.
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
  });

  it("matches rows when an AF column is in scope and the query hits it", () => {
    renderWith({
      parseStatus: "completed",
      resultsSearch: "cup",
      searchColsAf: ["af2"], // Object Name
      searchColsCat: [],
      results: [{ uid: "u1", status: "done", record: { "Object Name": "Cup" } }],
    });

    expect(screen.queryByText(/select at least one column/i)).not.toBeInTheDocument();
    // The non-matching Bowl row is filtered out; the matching Cup row renders
    // its collapsed "Done" status label.
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("shows all rows when the scope is empty but no query is typed (the !q short-circuit)", () => {
    renderWith({
      parseStatus: "completed",
      resultsSearch: "",
      searchColsAf: [],
      searchColsCat: [],
      results: [{ uid: "u1", status: "done", record: { "Object Name": "Cup" } }],
    });

    // No empty-scope hint, no "no matches" hint — the row renders.
    expect(screen.queryByText(/select at least one column/i)).not.toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("shows the generic 'no matches' hint (not the empty-scope one) when scope is set but nothing matches", () => {
    renderWith({
      parseStatus: "completed",
      resultsSearch: "nonexistent",
      searchColsAf: ["af2"], // Object Name
      searchColsCat: [],
      results: [{ uid: "u1", status: "done", record: { "Object Name": "Cup" } }],
    });

    expect(screen.getByText(/try a different search or filter/i)).toBeInTheDocument();
    expect(screen.queryByText(/select at least one column/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
  });
});
