import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { LogsViewer } from "./LogsViewer";
import { clearLogs, pushLog } from "../../lib/logs";

beforeEach(() => {
  clearLogs();
});

// Unmount between tests so each renders into a clean DOM (RTL auto-cleanup
// only fires when vitest globals are on; this is config-independent).
afterEach(() => {
  cleanup();
  clearLogs();
});

describe("LogsViewer", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<LogsViewer open={false} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the empty state when there are no events", async () => {
    render(<LogsViewer open onClose={() => {}} />);
    expect(await screen.findByText(/No activity yet/i)).toBeInTheDocument();
  });

  it("streams events into the table with their labels and durations", async () => {
    pushLog({ status: "ok", label: "Artefact file uploaded", detail: "a.xlsx", elapsedMs: 1200 });
    pushLog({ status: "busy", label: "Now parsing row ID 1", detail: "Obj. Number ACC-1" });

    render(<LogsViewer open onClose={() => {}} />);

    expect(await screen.findByText("Artefact file uploaded")).toBeInTheDocument();
    expect(screen.getByText("Now parsing row ID 1")).toBeInTheDocument();
    expect(screen.getByText("1.2s")).toBeInTheDocument(); // 1200ms -> 1.2s
  });

  it("calls onClose when the backdrop is clicked", async () => {
    // Disable the pointer-events check: Radix locks pointer-events on <body>
    // while a sheet is open, which userEvent enforces, but the overlay is
    // genuinely interactive in a real browser — this jsdom limitation is the
    // only thing being skipped, not the behavior under test.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onClose = vi.fn();
    render(<LogsViewer open onClose={onClose} />);

    // Wait for the panel to mount, then click the overlay layer to dismiss.
    await screen.findByText(/No activity yet/i);
    await user.click(document.querySelector('[data-slot="sheet-overlay"]')!);
    expect(onClose).toHaveBeenCalled();
  });

  it("does not call onClose when a click lands inside the panel", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<LogsViewer open onClose={onClose} />);

    await user.click(await screen.findByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when Escape is pressed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<LogsViewer open onClose={onClose} />);

    // Focus must be inside the sheet for Radix's DismissableLayer to handle Esc.
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("expands a verbose row on click and reveals the request detail", async () => {
    const user = userEvent.setup();
    pushLog({
      status: "busy",
      label: "Sent POST request, waiting for job ID",
      verbose: {
        method: "POST",
        url: "https://api.example/tasks/core-image-query-gemini-001",
        headers: [["x-api-key", "••••wxyz"]],
        body: { query: "Describe this artefact" },
      },
    });

    render(<LogsViewer open onClose={() => {}} />);

    // The verbose block is not present until the row is expanded.
    expect(screen.queryByText("Request")).not.toBeInTheDocument();

    await user.click(await screen.findByText("Sent POST request, waiting for job ID"));
    expect(screen.getByText("Request")).toBeInTheDocument();
    expect(screen.getByText(/core-image-query-gemini-001/)).toBeInTheDocument();
  });
});
