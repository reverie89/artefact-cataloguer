import type { AppActions } from "../app/actions";
import type { AppState } from "../app/state";
import { UploadPanel } from "./UploadPanel";
import { ResultsPanel } from "./ResultsPanel";

interface Props {
  state: AppState;
  actions: AppActions;
  convertFileSrc: (path: string) => string;
}

export function MainScreen({ state, actions, convertFileSrc }: Props) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <UploadPanel state={state} actions={actions} />
      {/* Resize handle */}
      <div
        onMouseDown={actions.onResizeStart}
        className="bg-muted/30 hover:bg-muted/50 flex h-1.5 shrink-0 cursor-row-resize items-center justify-center border-y"
      >
        <div className="bg-border pointer-events-none h-0.5 w-7 rounded-full" />
      </div>
      <ResultsPanel state={state} actions={actions} convertFileSrc={convertFileSrc} />
    </div>
  );
}
