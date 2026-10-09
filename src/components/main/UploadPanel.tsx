import { AlertCircle, FileSpreadsheet, Loader2, Upload, X } from "lucide-react";
import type { AppActions } from "../../app/actions";
import type { AppState } from "../../app/state";
import type { UploadFile } from "../../app/state";
import { _DEF_AF } from "../../app/defaults";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Props {
  state: AppState;
  actions: AppActions;
}

export function UploadPanel({ state, actions }: Props) {
  const importing = state.files.filter((f) => f.status === "validating");
  const rejected = state.files.filter((f) => f.status === "invalid");
  const reqCols = (state.settings.artefactFields || _DEF_AF).map((af) => af.name).join(", ");
  const hasTraffic = importing.length > 0 || rejected.length > 0;

  return (
    <div className="bg-card border-b flex min-h-30 shrink-0 flex-col overflow-y-auto h-[var(--split-h)]">
      <div className="pt-3 px-5">
        <div className="text-muted-foreground text-xs font-semibold uppercase tracking-[0.12em]">
          Artefact File
        </div>
        <div
          onClick={actions.onUploadClick}
          onDragOver={actions.onDragOver}
          onDragLeave={actions.onDragLeave}
          onDrop={actions.onDrop}
          className={cn(
            "bg-muted/30 my-2 h-24 overflow-hidden rounded-md border border-dashed",
            state.uploadDragOver && "border-primary bg-primary/10"
          )}
        >
          {!hasTraffic ? (
            <div className="flex h-full flex-col items-center justify-center gap-1.5 p-3 text-center">
              <div className="bg-primary/10 flex size-7 items-center justify-center rounded-md">
                <Upload className="size-3.5 text-primary" />
              </div>
              <div className="text-sm font-medium">Drop Artefact files here</div>
              <div className="text-muted-foreground text-[13px]">or <span className="text-primary">browse for files</span>. Accepted format: .xlsx</div>
            </div>
          ) : (
            <div className="h-full overflow-y-auto p-2" onClick={(e) => e.stopPropagation()}>
              {/* Validating chips are transient — each file is parsed the moment
                  it lands; valid ones join the results panel and their chip goes. */}
              {importing.map((f) => <ImportingChip key={f.id} file={f} />)}
            </div>
          )}
        </div>
      </div>

      {/* Invalid files fail loudly: one dismissible destructive card per file
          with the parser's reasons and the required-columns reference. */}
      {rejected.map((f) => (
        <Card key={f.id} className="bg-destructive/10 border-destructive/20 mx-5 my-2 rounded-md py-2.5">
          <div className="flex items-start gap-1.25 px-3">
            <AlertCircle className="text-destructive mt-0.5 size-3 shrink-0" />
            <div className="flex-1">
              <div className="text-destructive text-[13px] font-semibold">{f.name} — not imported</div>
              {f.errors.map((err, i) => (
                <div key={i} className="text-destructive pl-1 mb-0.5 text-sm">· {err.message}</div>
              ))}
              <div className="text-muted-foreground mt-1.5 border-destructive/20 border-t pt-1.5 text-[13px]">
                Required columns: <span className="text-foreground text-[13px]">{reqCols}</span>
              </div>
            </div>
            <Button
              onClick={() => actions.removeFile(f.id)}
              variant="ghost"
              size="icon"
              aria-label={`Dismiss ${f.name}`}
              className="text-muted-foreground hover:text-destructive -mt-1 -mr-1 size-6"
            >
              <X className="size-3" />
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

function ImportingChip({ file }: { file: UploadFile }) {
  return (
    <div className="bg-card mb-1 flex items-center gap-2.5 rounded px-2.5 py-1.5">
      <FileSpreadsheet className="size-4 text-primary" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{file.name}</div>
        <div className="text-muted-foreground mt-px text-xs">{file.sizeLabel}</div>
      </div>
      <Loader2 className="size-3 animate-spin text-primary" />
    </div>
  );
}
