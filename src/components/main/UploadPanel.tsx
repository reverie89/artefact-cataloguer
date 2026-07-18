import { AlertCircle, Ban, CheckCircle, FileSpreadsheet, Pause, Play, Plus, RotateCcw, Upload, X, XCircle, Zap, Loader2 } from "lucide-react";
import type { AppActions } from "../../app/actions";
import type { AppState } from "../../app/state";
import { _DEF_AF } from "../../app/defaults";
import { hasProvider } from "../../lib/ai";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface Props {
  state: AppState;
  actions: AppActions;
}

export function UploadPanel({ state, actions }: Props) {
  const { files, validationErrors } = state;
  const noFiles = files.length === 0;
  const providerReady = hasProvider(state.settings);
  const isRunning = state.parseStatus === "running";
  const isPaused = state.parseStatus === "paused";
  // The loop is alive (and may still dispatch) while running or paused.
  const isActive = isRunning || isPaused;
  const canParse = files.some((f) => f.status === "valid") && state.parseStatus === "idle" && providerReady;
  // Nothing to clear once the queue and any parsed results are gone, but the
  // parse loop must not be alive: startParse would otherwise dispatch stale
  // aiResults/fieldSelections after the reset clears them (see startParse).
  const canReset = (!noFiles || state.parseStatus !== "idle") && !isActive;
  const reqCols = (state.settings.artefactFields || _DEF_AF).map((af) => af.name).join(", ");
  const queueLabel =
    files.length === 0
      ? "No files in queue"
      : `${files.length} file${files.length > 1 ? "s" : ""} · ${files.filter((f) => f.status === "valid").length} validated`;

  return (
    <div className="bg-card border-b flex min-h-30 shrink-0 flex-col overflow-y-auto h-[var(--split-h)]">
      <div className="pt-3.5 px-5">
        <div className="text-muted-foreground text-xs font-semibold uppercase tracking-[0.12em]">
          Artefact File
        </div>
        <div
          onClick={actions.onUploadClick}
          onDragOver={actions.onDragOver}
          onDragLeave={actions.onDragLeave}
          onDrop={actions.onDrop}
          className="bg-muted/30 my-2.5 h-36 overflow-hidden rounded-md border border-dashed"
        >
          {noFiles ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-4.5 text-center">
              <div className="bg-primary/10 flex size-8.5 items-center justify-center rounded-md">
                <Upload className="size-4 text-primary" />
              </div>
              <div className="text-[15px] font-medium">Drop Artefact files here</div>
              <div className="text-muted-foreground text-sm">or <span className="text-primary">browse for files</span>. Accepted format: .xlsx</div>
            </div>
          ) : (
            <div className="h-full overflow-y-auto p-2" onClick={(e) => e.stopPropagation()}>
              {files.map((f) => (
                <div key={f.id} className="bg-card mb-1 flex items-center gap-2.5 rounded px-2.5 py-1.75">
                  <FileSpreadsheet className="size-4 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-medium">{f.name}</div>
                    <div className="text-muted-foreground mt-px text-[13px]">{f.sizeLabel}</div>
                  </div>
                  {f.status === "validating" && (
                    <Loader2 className="size-3 animate-spin text-primary" />
                  )}
                  {f.status === "valid" && (
                    <div className="text-emerald-600 dark:text-emerald-400 flex shrink-0 items-center gap-1 text-[13px]">
                      <CheckCircle className="size-3" />
                      <span>Valid</span>
                    </div>
                  )}
                  {f.status === "invalid" && (
                    <div className="text-destructive flex shrink-0 items-center gap-1 text-[13px]">
                      <XCircle className="size-3" />
                      <span>Invalid</span>
                    </div>
                  )}
                  <Button onClick={(e) => { e.stopPropagation(); actions.removeFile(f.id); }} variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive size-6"><X className="size-3" /></Button>
                </div>
              ))}
              <Button
                onClick={actions.addAnotherFile}
                variant="outline"
                size="sm"
                className="text-muted-foreground w-full border-dashed"
              >
                <Plus className="size-3" />
                <span>Add another file</span>
              </Button>
            </div>
          )}
        </div>
      </div>

      {validationErrors.length > 0 && (
        <Card className="bg-destructive/10 border-destructive/20 mx-5 my-2 rounded-md py-2.5">
          <div className="text-destructive flex items-center gap-1.25 px-3 text-[13px] font-semibold">
            <AlertCircle className="size-3" />
            <span>Validation errors</span>
          </div>
          <div className="px-3">
            {validationErrors.map((err, i) => (
              <div key={i} className="text-destructive pl-1 mb-0.5 text-sm">· {err.message}</div>
            ))}
            <div className="text-muted-foreground mt-1.5 border-destructive/20 border-t pt-1.5 text-[13px]">
              Required columns: <span className="text-foreground text-[13px]">{reqCols}</span>
            </div>
          </div>
        </Card>
      )}

      {state.parseError && (
        <Card className="bg-destructive/10 border-destructive/20 mx-5 my-2 rounded-md py-2.5">
          <div className="flex items-start gap-1.25 px-3">
            <AlertCircle className="text-destructive mt-0.5 size-3 shrink-0" />
            <div className="text-destructive flex-1 text-sm">{state.parseError}</div>
            <Button
              onClick={actions.dismissParseError}
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive -mt-1 -mr-1 size-6"
            >
              <X className="size-3" />
            </Button>
          </div>
        </Card>
      )}

      {/* Export warning — surfaced in the same panel as parse errors when the
          export can't proceed (e.g. no artefact-file columns toggled on).
          Structurally identical to the parse-error banner so the two share one
          visual treatment for "blocking, dismissable, destructive". */}
      {state.exportWarning && (
        <Card className="bg-destructive/10 border-destructive/20 mx-5 my-2 rounded-md py-2.5">
          <div className="flex items-start gap-1.25 px-3">
            <AlertCircle className="text-destructive mt-0.5 size-3 shrink-0" />
            <div className="text-destructive flex-1 text-sm">{state.exportWarning}</div>
            <Button
              onClick={actions.dismissExportWarning}
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive -mt-1 -mr-1 size-6"
            >
              <X className="size-3" />
            </Button>
          </div>
        </Card>
      )}

      <div className="flex items-center gap-2.5 px-5 pb-3.5 pt-2.5">
        <span className="text-muted-foreground text-[13px]">{queueLabel}</span>
        <div className="flex-1" />
        {/* Cancel stops the whole run from scheduling any further rows (the
            in-flight row finishes; there's no transport-level abort). Shown
            only while the loop is alive — there's nothing to stop otherwise. */}
        {isActive && (
          <Button onClick={actions.cancelParse} variant="outline" size="lg">
            <Ban className="size-3" />
            <span>Cancel</span>
          </Button>
        )}
        <Button onClick={actions.resetUpload} disabled={!canReset} variant="outline" size="lg">
          <RotateCcw className="size-3" />
          <span>Reset</span>
        </Button>
        {/* Single right slot toggles with the run state. Pause is de-emphasized
            (secondary) to signal the run isn't actively progressing; Parse and
            Resume stay primary. Idle with no valid file → disabled placeholder. */}
        {isRunning ? (
          <Button onClick={actions.pauseParse} variant="secondary" size="lg">
            <Pause className="size-3" />
            <span>Pause</span>
          </Button>
        ) : isPaused ? (
          <Button onClick={actions.resumeParse} size="lg">
            <Play className="size-3" />
            <span>Resume</span>
          </Button>
        ) : (
          <Button onClick={actions.startParse} disabled={!canParse} size="lg">
            <Zap className="size-3" />
            <span>Parse</span>
          </Button>
        )}
      </div>
    </div>
  );
}
