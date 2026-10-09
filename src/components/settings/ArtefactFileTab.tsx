import { useCallback, useMemo, useRef, useState } from "react";
import { Eye, FileText, Plus } from "lucide-react";
import type { AppActions } from "../../app/actions";
import type { AppState } from "../../app/state";
import { _DEF_AF, _DEF_ARTEFACT_ANALYSIS_SYSTEM_PROMPT_INSTRUCTION } from "../../app/defaults";
import { fieldsDiffer } from "../../app/drafts";
import { buildPromptPreview } from "../../lib/ai";
import type { Settings } from "../../app/types";
import { CardActions } from "./CardActions";
import { Field, FieldInput, FieldTextarea, Segmented } from "./FormControls";
import { PromptPreviewSheet } from "./PromptPreviewSheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { SaveState } from "./SaveActions.types";
import { UnsavedBadge } from "./UnsavedBadge";
import { ExpandCollapseAll } from "./ExpandCollapseAll";
import { SortableList } from "./SortableList";
import { SortableRow } from "./SortableRow";
import { useScrollNewRowIntoView } from "../../hooks/useScrollNewRowIntoView";

interface Props {
  state: AppState;
  actions: AppActions;
}

/** Grid template shared by the header row and each column row (via SortableRow)
 *  so columns align exactly: grip / Name / Description. */
const GRID = "grid-cols-[24px_1fr_1fr] gap-2.5 px-3.5";

export function ArtefactFileTab({ state, actions }: Props) {
  const { settings } = state;

  // Render from the pending draft if there are unsaved edits, otherwise from
  // persisted settings. Edits accumulate in the draft and only hit disk on Save.
  const live = state.artefactDraft ?? {
    artefactAnalysisSystemPromptInstruction: settings.artefactAnalysisSystemPromptInstruction ?? "",
    artefactFields: settings.artefactFields || _DEF_AF,
  };
  const artefactAnalysisInstrDirty =
    !!state.artefactDraft &&
    (state.artefactDraft.artefactAnalysisSystemPromptInstruction ?? "") !== (settings.artefactAnalysisSystemPromptInstruction ?? "");

  // Local UI state for the artefact-analysis prompt preview sheet — mirrors
  // CataloguingFieldsTab's previewOpen. Transient tab affordance, not reducer state.
  const [previewOpen, setPreviewOpen] = useState(false);
  // Effective settings (persisted merged with the in-progress draft) so the
  // preview reflects exactly what would be sent if the user saved now. Memoized
  // so the preview builder below has a stable dependency.
  const previewSettings: Settings = useMemo(
    () => ({
      ...settings,
      artefactFields: live.artefactFields,
      artefactAnalysisSystemPromptInstruction: live.artefactAnalysisSystemPromptInstruction,
    }),
    [settings, live.artefactFields, live.artefactAnalysisSystemPromptInstruction]
  );
  const buildArtefactAnalysisPreview = useCallback(
    () => buildPromptPreview(previewSettings),
    [previewSettings]
  );

  // Per-row DOM refs so a newly-added row can be scrolled into view.
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  useScrollNewRowIntoView(
    live.artefactFields.length,
    rowRefs,
    live.artefactFields[live.artefactFields.length - 1]?.id
  );

  return (
    <div className="flex flex-col gap-2.5">
      {/* File-format + per-column behaviour explanation — reads like CataloguingFieldsTab's Part-1 context card. */}
      <Card className="gap-0 py-0">
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <FileText className="size-4 text-primary" /><span>File Format &amp; Columns</span>
          </div>
          <div className="text-muted-foreground text-[13px] leading-relaxed">
            The artefact file must be a spreadsheet (<strong className="text-foreground">.xlsx</strong>) with a header row.
          </div>
          <div className="text-muted-foreground text-[13px] leading-relaxed">
            Every column configured here must resolve to a spreadsheet column when the file is parsed — by its Header Text matching the header row, or by the Column Letter set on it — even if some cells are empty. Columns that are not configured here still appear in the source record panel but are never sent to the AI. The AI receives every configured column when it examines each artefact, unless you turn a column&apos;s Include for AI toggle off.
          </div>
        </div>
      </Card>

      {/* Unified System Prompt (artefact analysis). Persona + output-format
          preamble in one Override-gated field — disabled by default since its
          preamble tells the model how to format responses (editing it can
          break parsing). The dynamic per-field XML enumeration and the
          <artefact_file> record block are appended by Rust at runtime
          (visible in the Preview). */}
      <Card className="gap-2 py-3.5">
        <Field
          label="System Prompt"
          desc="How the AI should examine each artefact and format its answers. The image and per-column guidance below attach alongside; the artefact-file record is included. Edit with care."
          action={
            <>
              <Button onClick={() => setPreviewOpen(true)} variant="secondary" size="sm" className="shrink-0">
                <Eye className="size-3" />
                <span>Preview Prompt</span>
              </Button>
              {state.contractEditing ? (
                <Button
                  onClick={() => { actions.updateArtefactAnalysisSystemPromptInstruction(_DEF_ARTEFACT_ANALYSIS_SYSTEM_PROMPT_INSTRUCTION); actions.setPromptEditing(false); }}
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                >
                  Reset to default
                </Button>
              ) : (
                <Button onClick={() => void actions.overridePrompt()} variant="secondary" size="sm" className="shrink-0">
                  Override
                </Button>
              )}
            </>
          }
          className="px-4"
        >
          <Textarea
            value={live.artefactAnalysisSystemPromptInstruction || ""}
            onChange={(e) => actions.updateArtefactAnalysisSystemPromptInstruction(e.target.value)}
            readOnly={!state.contractEditing}
            rows={5}
            className={cn("resize-y leading-relaxed", !state.contractEditing && "bg-muted/40 text-muted-foreground")}
          />
        </Field>
        <div className="px-4">
          <CardActions
            dirty={artefactAnalysisInstrDirty}
            status={state.artefactCardSaveStatus["artefact-analysis-instruction"] ?? null}
            onSave={() => { void actions.saveArtefactAnalysisSystemPromptInstruction(); actions.setPromptEditing(false); }}
            onDiscard={() => { actions.discardArtefactAnalysisSystemPromptInstruction(); actions.setPromptEditing(false); }}
          />
        </div>
      </Card>

      <ExpandCollapseAll
        onExpandAll={() => actions.setAllExpanded("artefactFieldExpanded", live.artefactFields.map((f) => f.id), true)}
        onCollapseAll={() => actions.setAllExpanded("artefactFieldExpanded", live.artefactFields.map((f) => f.id), false)}
      />

      <Card className="gap-0 overflow-hidden p-0">
        <div className={cn("bg-muted/30 grid border-b py-1.75", GRID)}>
          <span />
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Name</span>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Description</span>
        </div>
        <SortableList
          items={live.artefactFields.map((f) => f.id)}
          onReorder={(ids) => void actions.reorderAF(ids)}
        >
          {live.artefactFields.map((af) => {
            const saved = (settings.artefactFields || _DEF_AF).find((s) => s.id === af.id);
            const cardDirty = !!state.artefactDraft && (!saved || fieldsDiffer(
              { ...af, description: af.description ?? "", prompt: af.prompt ?? "", useColumnLetter: af.useColumnLetter ?? false, column: af.column ?? "" },
              { ...saved, description: saved.description ?? "", prompt: saved.prompt ?? "", useColumnLetter: saved.useColumnLetter ?? false, column: saved.column ?? "" },
              ["id", "name", "description", "prompt", "includeForAI", "includeInExport", "useColumnLetter", "column"],
            ));
            return (
              <ArtefactColumnRow
                key={af.id}
                field={af}
                expanded={!!state.artefactFieldExpanded[af.id]}
                dirty={cardDirty}
                cardStatus={state.artefactCardSaveStatus[af.id] ?? null}
                cardRef={(node) => { rowRefs.current[af.id] = node; }}
                actions={actions}
              />
            );
          })}
        </SortableList>
        {live.artefactFields.length === 0 && (
          <div className="text-muted-foreground p-5 text-center text-[15px]">No columns defined yet</div>
        )}
      </Card>

      <Button onClick={actions.startAddAF} variant="outline" className="text-muted-foreground w-full border-dashed">
        <Plus className="size-3" /><span>Add Column</span>
      </Button>

      <PromptPreviewSheet
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        build={buildArtefactAnalysisPreview}
        description={
          <>
            The exact message sent to your AI provider when it catalogues each artefact,
            including the persona, output-format preamble, and the automatically appended per-field XML
            enumeration. The artefact row&apos;s source values are produced at parse time, so the
            <span className="px-1 font-mono">&lt;artefact_file&gt;</span>
            record is shown as an empty placeholder; the extracted image is attached as a separate
            content block. Reflects your current (possibly unsaved) edits.
          </>
        }
      />
    </div>
  );
}

/** A single artefact-column row. Clicking anywhere on the row toggles the
 *  editor (mirrors CataloguingFieldsTab's SortableFieldRow). */
interface ArtefactColumnRowProps {
  field: { id: string; name: string; description: string; prompt: string; includeForAI: boolean; includeInExport: boolean; useColumnLetter: boolean; column: string };
  expanded: boolean;
  /** Whether this column has unsaved content edits. */
  dirty: boolean;
  /** Persist status of this row's own Save button. */
  cardStatus: SaveState;
  /** Registers this row's root DOM node so the parent can scroll it into view. */
  cardRef?: (node: HTMLDivElement | null) => void;
  actions: AppActions;
}

function ArtefactColumnRow({ field: af, expanded, dirty, cardStatus, cardRef, actions }: ArtefactColumnRowProps) {
  return (
    <SortableRow
      id={af.id}
      expanded={expanded}
      onToggle={() => actions.toggleAF(af.id)}
      grid={GRID}
      cardRef={cardRef}
      label={
        <>
          <span className="truncate text-[15px] font-semibold">{af.name || "Untitled column"}</span>
          <UnsavedBadge dirty={dirty} />
        </>
      }
      cells={<span className="text-muted-foreground truncate text-sm">{af.description || "—"}</span>}
    >
      {expanded && (
        <div className="bg-muted/30 flex flex-col gap-2.5 border-t px-3.5 pt-2.5 pb-3.5 animate-in fade-in slide-in-from-top-1 duration-100">
          {/* Identify By gates the two inputs below — draft-buffered like the
              Segmented toggles further down (updateAF coerces the string). On
              Column Letter, the field reads positionally and Header Text is
              hidden: the name is only the row's label. */}
          <Field
            label="Identify By"
            desc="Header Text matches this column against the uploaded spreadsheet's header row. Column Letter reads it positionally from that Excel column, regardless of the header text."
          >
            <Segmented
              value={af.useColumnLetter ? "letter" : "name"}
              onChange={(v) => actions.updateAF(af.id, "useColumnLetter", v === "letter" ? "true" : "false")}
              options={[
                { value: "name", label: "Header text" },
                { value: "letter", label: "Column letter" },
              ]}
            />
          </Field>
          {af.useColumnLetter ? (
            <FieldInput
              label="Column Letter"
              value={af.column}
              onChange={(e) => actions.updateAF(af.id, "column", e.target.value)}
              placeholder="e.g. C"
              desc="Excel column letter (A, B, … AA) this column is read from, regardless of the header text."
            />
          ) : (
            <FieldInput
              label="Header Text"
              value={af.name}
              onChange={(e) => actions.updateAF(af.id, "name", e.target.value)}
              desc="Must match a column header in the uploaded spreadsheet (case-insensitive; spaces and line breaks count as the same)."
            />
          )}
          <FieldInput
            label="Description"
            value={af.description}
            onChange={(e) => actions.updateAF(af.id, "description", e.target.value)}
            placeholder="What does this column contain?"
            desc="Internal note about this column, shown in the columns list — not sent to the AI."
            labelSuffix={<Badge variant="secondary" className="text-[10px] font-normal tracking-[0.04em]">Optional</Badge>}
          />
          {/* AI inclusion — draft-buffered like Include in Export below (the
              Segmented emits "true"/"false" strings; updateAF coerces to a
              boolean on the draft). Off keeps the column export-only: its
              values never reach the model and its prompt instruction is
              omitted. */}
          <Field
            label="Include for AI"
            desc="Send this column's values to the AI when it examines each artefact. Turn off to keep the column for export only — its values still appear in the source record panel but never reach the model."
          >
            <Segmented
              value={af.includeForAI ? "true" : "false"}
              onChange={(v) => actions.updateAF(af.id, "includeForAI", v)}
              options={[
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ]}
            />
          </Field>
          <FieldTextarea
            label="Prompt Instruction"
            value={af.prompt}
            onChange={(e) => actions.updateAF(af.id, "prompt", e.target.value)}
            placeholder="Teach the AI how to read this column's values (optional)"
            desc="Teach the AI how to read this column when cataloguing — e.g. what its values mean or how to use them. Leave blank to send the value with no field-specific guidance; the instruction is then omitted from the prompt. Only used when Include for AI is on."
            labelSuffix={<Badge variant="secondary" className="text-[10px] font-normal tracking-[0.04em]">Optional</Badge>}
            rows={2}
            className="resize-y leading-relaxed"
          />
          {/* Export inclusion — draft-buffered like the fields above (the
              Segmented emits "true"/"false" strings; updateAF coerces to a
              boolean on the draft). An image column's bytes are embedded per
              row when this is on; other columns write their record value. */}
          <Field
            label="Include in Export"
            desc="Add this column as a leading column in the exported spreadsheet, before the catalogue fields. Image columns embed their bytes."
          >
            <Segmented
              value={af.includeInExport ? "true" : "false"}
              onChange={(v) => actions.updateAF(af.id, "includeInExport", v)}
              options={[
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ]}
            />
          </Field>
          {/* Per-card actions: Delete/Discard/Save target only this column.
              Delete buffers into the draft (flushed by the Apply banner). */}
          <CardActions
            dirty={dirty}
            status={cardStatus}
            onSave={() => void actions.saveArtefactCard(af.id)}
            onDiscard={() => actions.discardArtefactCard(af.id)}
            onDelete={() => void actions.removeAF(af.id)}
            deleteLabel="Delete Column"
          />
        </div>
      )}
    </SortableRow>
  );
}
