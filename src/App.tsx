import { useCallback, useEffect, useReducer, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { initialState, reducer } from "./app/state";
import { loadState, makeDebouncedSaver } from "./lib/store";
import { useActions } from "./app/actions";
import { TopBar } from "./components/TopBar";
import { MainScreen } from "./components/MainScreen";
import { SettingsScreen } from "./components/settings/SettingsScreen";
import { LogsViewer } from "./components/LogsViewer";
import { useConfirmDelete } from "./components/useConfirmDelete";
import { pushLog, type LogVerbose } from "./lib/logs";

/** A vision-pipeline stage emitted by Rust (ai.rs `do_vision_query`) onto the
 *  "ac-logs" event. Each maps to one row in the Logs Viewer; `verbose` carries
 *  the redacted request/response envelope shown on row click. */
interface VisionStageEvent {
  stage: "postSent" | "jobFound" | "done" | "timeout" | "failed";
  /** Group id tying every stage of one vision call together, used to resolve
   *  earlier "busy" dots when a terminal stage lands. */
  jobGroup: string;
  label?: string;
  detail?: string;
  elapsedMs?: number;
  status: "ok" | "busy" | "fail";
  verbose?: LogVerbose;
}

/** Human label for each Rust vision stage, used unless Rust supplied one. */
const VISION_STAGE_LABEL: Record<VisionStageEvent["stage"], string> = {
  postSent: "Sent POST request, waiting for job ID",
  jobFound: "Job ID found, polling for response",
  done: "Response received",
  timeout: "Timeout",
  failed: "Request failed",
};

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Keep a ref so the debounced saver always reads the latest bundle.
  const stateRef = useRef(state);
  const saveRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const save = useCallback(() => {
    saveRef.current ??= makeDebouncedSaver(() => stateRef.current);
    saveRef.current();
  }, []);

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

  // Rust→frontend vision-stage bridge. `do_vision_query` (ai.rs) emits the
  // POST → job-ID → poll → timeout/response stages onto "ac-logs"; forward each
  // into the Logs Viewer stream so the run transcript shows the live vision
  // sub-flow (which otherwise only surfaces as raw HTTP on "ac-http").
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let active = true;
    void (async () => {
      unlisten = await listen<VisionStageEvent>("ac-logs", (ev) => {
        const e = ev.payload;
        pushLog({
          status: e.status,
          jobId: e.jobGroup,
          label: e.label ?? VISION_STAGE_LABEL[e.stage],
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
  const actions = useActions(state, dispatch, save, confirmDelete);

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
