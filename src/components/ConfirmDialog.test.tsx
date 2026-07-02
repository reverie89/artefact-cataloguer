import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { ConfirmDialog } from "./ConfirmDialog";
import { useConfirmDelete } from "./useConfirmDelete";

afterEach(() => {
  cleanup();
});

describe("ConfirmDialog (presentational)", () => {
  it("renders the title and message when open", () => {
    render(
      <ConfirmDialog open title="Delete catalogue field?" message='Delete "Material"?' onCancel={() => {}} onConfirm={() => {}} />
    );
    expect(screen.getByText("Delete catalogue field?")).toBeInTheDocument();
    expect(screen.getByText('Delete "Material"?')).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(
      <ConfirmDialog open={false} title="t" message="m" onCancel={() => {}} onConfirm={() => {}} />
    );
    expect(screen.queryByText("t")).not.toBeInTheDocument();
  });

  it("calls onCancel when the backdrop is clicked", async () => {
    // Disable the pointer-events check: Radix locks pointer-events on <body>
    // during open, which userEvent (correctly) enforces, but the overlay is
    // genuinely interactive in a real browser — this jsdom limitation is the
    // only thing being skipped, not the behavior under test.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="t" message="m" onCancel={onCancel} onConfirm={() => {}} />);

    await user.click(document.querySelector('[data-slot="dialog-overlay"]')!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not call onCancel when a click lands inside the panel", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="t" message="m" onCancel={onCancel} onConfirm={() => {}} />);

    await user.click(screen.getByRole("dialog"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel when Escape is pressed", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="t" message="m" onCancel={onCancel} onConfirm={() => {}} />);

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onConfirm when the Delete button is clicked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmDialog open title="t" message="m" onCancel={() => {}} onConfirm={onConfirm} />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

// Drives the hook: triggers confirmDelete() and stores the resolved value.
function Harness() {
  const { confirmDelete, dialog } = useConfirmDelete();
  const [result, setResult] = useState<boolean | null>(null);
  return (
    <div>
      <button
        onClick={() => {
          void confirmDelete({ title: "Delete catalogue field?", message: "Are you sure?" }).then(setResult);
        }}
      >
        trigger
      </button>
      <span>{result === null ? "pending" : result ? "ok" : "no"}</span>
      {dialog}
    </div>
  );
}

describe("useConfirmDelete", () => {
  it("resolves true when the Delete button is clicked", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByText("trigger"));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("ok")).toBeInTheDocument();
  });

  it("resolves false when Cancel is clicked", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByText("trigger"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("no")).toBeInTheDocument();
  });

  it("resolves false when the backdrop is clicked", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Harness />);

    await user.click(screen.getByText("trigger"));
    await user.click(document.querySelector('[data-slot="dialog-overlay"]')!);
    expect(await screen.findByText("no")).toBeInTheDocument();
  });

  it("resolves false when Escape is pressed", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByText("trigger"));
    await user.keyboard("{Escape}");
    expect(await screen.findByText("no")).toBeInTheDocument();
  });
});
