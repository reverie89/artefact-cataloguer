import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  clearLogs,
  pushLog,
  useLogErrorCount,
  useLogEvents,
} from "./logs";

// `useSyncExternalStore` snapshots a module-level store, so each test starts
// from a known empty state.
beforeEach(() => {
  clearLogs();
});

afterEach(() => {
  clearLogs();
});

describe("pushLog / clearLogs", () => {
  it("appends events in order with an id and timestamp", () => {
    pushLog({ status: "ok", label: "one" });
    pushLog({ status: "busy", label: "two" });

    const { result } = renderHook(() => useLogEvents());
    const events = result.current;
    expect(events).toHaveLength(2);
    expect(events[0].label).toBe("one");
    expect(events[1].label).toBe("two");
    expect(events.map((e) => e.id)).toEqual([1, 2]);
    expect(events[0].ts).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it("preserves optional fields (detail, elapsedMs, verbose)", () => {
    pushLog({
      status: "ok",
      label: "response",
      detail: "5 fields",
      elapsedMs: 3200,
      verbose: { status: 200, jobId: "88a1" },
    });

    const { result } = renderHook(() => useLogEvents());
    const e = result.current[0];
    expect(e.detail).toBe("5 fields");
    expect(e.elapsedMs).toBe(3200);
    expect(e.verbose).toEqual({ status: 200, jobId: "88a1" });
  });

  it("caps the buffer at the configured maximum, keeping the newest", () => {
    for (let i = 0; i < 510; i++) pushLog({ status: "ok", label: `row ${i}` });

    const { result } = renderHook(() => useLogEvents());
    expect(result.current).toHaveLength(500);
    // The most recent 500 survive; the first 10 ("row 0".."row 9") are dropped.
    expect(result.current[0].label).toBe("row 10");
    expect(result.current[499].label).toBe("row 509");
  });

  it("clearLogs empties the stream", () => {
    pushLog({ status: "ok", label: "x" });
    act(() => clearLogs());

    const { result } = renderHook(() => useLogEvents());
    expect(result.current).toEqual([]);
  });

  it("notifies subscribers on push and clear", () => {
    const { result, rerender } = renderHook(() => useLogEvents());
    expect(result.current).toEqual([]);

    act(() => pushLog({ status: "busy", label: "p" }));
    rerender();
    expect(result.current).toHaveLength(1);

    act(() => clearLogs());
    rerender();
    expect(result.current).toEqual([]);
  });
});

describe("useLogErrorCount", () => {
  it("counts only failed entries", () => {
    pushLog({ status: "ok", label: "a" });
    pushLog({ status: "busy", label: "b" });
    pushLog({ status: "fail", label: "c" });
    pushLog({ status: "ok", label: "d" });
    pushLog({ status: "fail", label: "e" });

    const { result } = renderHook(() => useLogErrorCount());
    expect(result.current).toBe(2);
  });

  it("updates as new failures arrive", () => {
    const { result, rerender } = renderHook(() => useLogErrorCount());
    expect(result.current).toBe(0);

    act(() => pushLog({ status: "fail", label: "boom" }));
    rerender();
    expect(result.current).toBe(1);
  });
});

describe("job resolution", () => {
  it("resolves earlier busy stages of a job to a terminal outcome (ok)", () => {
    pushLog({ status: "busy", jobId: "row-1", label: "now parsing row 1" });
    pushLog({ status: "busy", jobId: "vision-1", label: "waiting for job ID" });
    pushLog({ status: "busy", jobId: "vision-1", label: "polling" });
    pushLog({ status: "ok", jobId: "vision-1", label: "response received" });

    const { result } = renderHook(() => useLogEvents());
    const statuses = result.current.map((e) => e.status);
    expect(statuses).toEqual(["busy", "ok", "ok", "ok"]);
    // The other job's busy dot is untouched.
    expect(result.current[0].status).toBe("busy");
  });

  it("resolves earlier busy stages of a job to a terminal outcome (fail)", () => {
    pushLog({ status: "busy", jobId: "vision-1", label: "waiting for job ID" });
    pushLog({ status: "busy", jobId: "vision-1", label: "polling" });
    pushLog({ status: "fail", jobId: "vision-1", label: "timeout" });

    const { result } = renderHook(() => useLogEvents());
    // The two busy dots flip red alongside the terminal failure.
    expect(result.current.map((e) => e.status)).toEqual(["fail", "fail", "fail"]);
  });

  it("leaves unrelated jobs' busy dots alone", () => {
    pushLog({ status: "busy", jobId: "vision-1", label: "waiting" });
    pushLog({ status: "ok", jobId: "vision-2", label: "done" });

    const { result } = renderHook(() => useLogEvents());
    expect(result.current[0].status).toBe("busy"); // vision-1 still in flight
    expect(result.current[1].status).toBe("ok");
  });

  it("only resolves busy stages; already-resolved ones keep their status", () => {
    pushLog({ status: "busy", jobId: "row-1", label: "parsing" });
    pushLog({ status: "ok", jobId: "row-1", label: "vision done" });
    pushLog({ status: "fail", jobId: "row-1", label: "row failed" });

    const { result } = renderHook(() => useLogEvents());
    // The busy flips to ok at the first terminal event; the later failure does
    // NOT retroactively re-flip an already-resolved ok stage.
    expect(result.current.map((e) => e.status)).toEqual(["ok", "ok", "fail"]);
  });
});
