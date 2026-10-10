import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { initialState, reducer } from "./app/state";
import { loadState, makeDebouncedSaver, type DebouncedSaver } from "./lib/store";
import { useActions } from "./app/actions";
import { TopBar } from "./components/main/TopBar";
import { MainScreen } from "./components/main/MainScreen";
import { SettingsScreen } from "./components/settings/SettingsScreen";
import { LogsViewer } from "./components/main/LogsViewer";
import { useConfirmDelete } from "./hooks/useConfirmDelete";
import { pushLog, type LogVerbose } from "./lib/logs";

/** A cataloguing-pipeline stage emitted by Rust onto the "ac-logs" event.
 *  Carries artefact-analysis, partition and validation call stages from
 *  `ai.rs`. Each maps to one row in the Logs Viewer; `verbose` carries the
 *  redacted request/response envelope shown on row click. */
interface PipelineStageEvent {
  stage: string;
  /** Group id tying every stage of one call together, used to resolve earlier
   *  "busy" dots when a terminal stage lands. */
  jobGroup: string;
  /** Owning record's job id (`row-<uid>`) — the Logs Viewer's per-record
   *  grouping key; deliberately not the per-call `jobGroup`. */
  rowId?: string;
  label?: string;
  detail?: string;
  elapsedMs?: number;
  status: "ok" | "busy" | "fail";
  verbose?: LogVerbose;
}

/** Human label for the legacy artefact-analysis completion stages (postSent/jobFound/
 *  done/timeout/failed), used when Rust omits `label`. Embedding-stage emits
 *  always supply their own label, so they don't need an entry here. */
const ARTEFACT_ANALYSIS_STAGE_LABEL: Record<string, string> = {
  postSent: "Sent POST request, waiting for job ID",
  jobFound: "Job ID found, polling for response",
  done: "Response received",
  timeout: "Timeout",
  failed: "Request failed",
};

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Keep a ref so the saver and the queue drainer's getState() always read
  // the latest bundle. useLayoutEffect, not useEffect, so the mirror is in
  // place at commit: startQueue yields one microtask after a synchronous
  // dispatch (Retry's requeue) and must then scan the committed rows.
  const stateRef = useRef(state);

  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Stable saver facade over one lazily-created debounced saver: routine edits
  // coalesce via schedule(), structural vocab ops await flush(). Both read the
  // freshest bundle through `stateRef` rather than any render's snapshot.
  const saverRef = useRef<DebouncedSaver | null>(null);
  const scheduleSave = useCallback(() => {
    (saverRef.current ??= makeDebouncedSaver(() => stateRef.current)).schedule();
  }, []);
  const flushSave = useCallback((): Promise<void> => {
    const saver = (saverRef.current ??= makeDebouncedSaver(() => stateRef.current));
    return saver.flush();
  }, []);
  const persist = useMemo(() => ({ schedule: scheduleSave, flush: flushSave }), [scheduleSave, flushSave]);

  // Load persisted state beside the binary on first mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { settings, darkMode, zoom } = await loadState();
      if (!cancelled) dispatch({ type: "INIT", settings, darkMode, zoom });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Rust→frontend pipeline-stage bridge. `ai.rs` emits the artefact-analysis,
  // partition and validation call stages onto "ac-logs" (each call POSTs and
  // awaits its response inline). Forward each into the Logs Viewer stream so
  // the run transcript shows the live sub-flows that otherwise only surface
  // as a long busy dot; `rowId` carries the owning record for grouping.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let active = true;
    void (async () => {
      unlisten = await listen<PipelineStageEvent>("ac-logs", (ev) => {
        const e = ev.payload;
        pushLog({
          status: e.status,
          jobId: e.jobGroup,
          rowId: e.rowId,
          label: e.label ?? ARTEFACT_ANALYSIS_STAGE_LABEL[e.stage] ?? e.stage,
          detail: e.detail,
          elapsedMs: e.elapsedMs,
          verbose: e.verbose,
        });
      });
      if (!active && unlisten) unlisten();
    })();
    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, []);

  // Apply the shadcn dark theme by toggling the `.dark` class on <html>.
  // shadcn's tokens resolve through the `.dark` selector rather than the
  // previous `data-theme` attribute; this keeps theme switching declarative
  // (no JS branching on theme when styling components).
  useEffect(() => {
    document.documentElement.classList.toggle("dark", state.darkMode);
  }, [state.darkMode]);

  const { confirmDelete, dialog } = useConfirmDelete();
  const actions = useActions(state, dispatch, persist, confirmDelete, () => stateRef.current);

  // Hold off the first meaningful paint until the persisted state has been
  // hydrated from disk. `loaded` is flipped by the INIT reducer once loadState()
  // resolves; without this gate, TopBar would briefly render from the empty
  // defaults (no active provider) and flash the "Enable AI in Settings first"
  // banner — disagreeing with the seeded/persisted provider the rest of the app
  // already knows about. The load IPC reads a small file and resolves quickly,
  // so a plain themed container is enough; no spinner text to flash.
  if (!state.loaded) {
    return <div className="h-screen bg-background" />;
  }

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-background text-foreground font-sans"
      style={{ zoom: state.zoom }}
    >
      <TopBar state={state} actions={actions} />
      {state.screen === "main" ? (
        <MainScreen state={state} actions={actions} convertFileSrc={convertFileSrc} />
      ) : (
        <SettingsScreen state={state} actions={actions} />
      )}
      <LogsViewer open={state.logsOpen} onClose={() => actions.setLogsOpen(false)} />
      {dialog}
    </div>
  );
}
