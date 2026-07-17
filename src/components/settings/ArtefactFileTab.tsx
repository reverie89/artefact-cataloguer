import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DndContext, type DragEndEvent, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Eye, FileText, GripVertical, Plus } from "lucide-react";
import type { AppActions } from "../../app/actions";
import type { AppState } from "../../app/state";
import { _DEF_AF } from "../../app/defaults";
import { fieldsDiffer } from "../../app/drafts";
import { buildPromptPreview } from "../../lib/ai";
import type { Settings } from "../../app/types";
import { CardActions } from "./CardActions";
import { Field, FieldInput, FieldTextarea } from "./FormControls";
import { PromptPreviewSheet } from "./PromptPreviewSheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { SaveState } from "./SaveActions.types";
import { UnsavedBadge } from "./UnsavedBadge";
import { ExpandCollapseAll } from "./ExpandCollapseAll";

interface Props {
  state: AppState;
  actions: AppActions;
}

export function ArtefactFileTab({ state, actions }: Props) {
  const { settings } = state;

  // Render from the pending draft if there are unsaved edits, otherwise from
  // persisted settings. Edits accumulate in the draft and only hit disk on Save.
  const live = state.artefactDraft ?? {
    visionSystemPromptInstruction: settings.visionSystemPromptInstruction ?? "",
    artefactFields: settings.artefactFields || _DEF_AF,
  };
  const visionInstrDirty =
    !!state.artefactDraft &&
    (state.artefactDraft.visionSystemPromptInstruction ?? "") !== (settings.visionSystemPromptInstruction ?? "");

  // Local UI state for the Vision Analysis Prompt Preview sheet — mirrors
  // FieldsTab's previewOpen. Transient tab affordance, not reducer state.
  const [previewOpen, setPreviewOpen] = useState(false);
  // Effective settings (persisted merged with the in-progress draft) so the
  // preview reflects exactly what would be sent if the user saved now. Memoized
  // so the preview builder below has a stable dependency.
  const previewSettings: Settings = useMemo(
    () => ({
      ...settings,
      artefactFields: live.artefactFields,
      visionSystemPromptInstruction: live.visionSystemPromptInstruction,
    }),
    [settings, live.artefactFields, live.visionSystemPromptInstruction]
  );
  const buildVisionPreview = useCallback(
    () => buildPromptPreview(previewSettings),
    [previewSettings]
  );

  // Per-row DOM refs so a newly-added row can be scrolled into view. A ref
  // tracks the previous column count so the scroll fires ONLY when the count
  // grows (an Add), never on content edits, deletes, or reorders — which also
  // change `live.artefactFields`. Mirrors ProvidersTab's add-scroll behaviour.
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const prevCountRef = useRef(live.artefactFields.length);
  useEffect(() => {
    const grew = live.artefactFields.length > prevCountRef.current;
    prevCountRef.current = live.artefactFields.length;
    if (!grew) return;
    // Add appends, so the new row is the last. Scroll it into view.
    const last = live.artefactFields[live.artefactFields.length - 1];
    const node = last ? rowRefs.current[last.id] : null;
    // block:"nearest" avoids jumping when the row is already partly visible;
    // a small timeout lets the expanded body measure before scrolling.
    const t = setTimeout(() => node?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 30);
    return () => clearTimeout(t);
  }, [live.artefactFields]);

  // Require a small drag threshold so a normal click on a row still toggles the
  // editor instead of starting a drag. Mirrors FieldsTab's reorder wiring.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const ids = live.artefactFields.map((f) => f.id);
      const from = ids.indexOf(active.id as string);
      const to = ids.indexOf(over.id as string);
      if (from === -1 || to === -1) return;
      void actions.reorderAF(arrayMove(ids, from, to));
    },
    [live.artefactFields, actions]
  );

  return (
    <div className="flex flex-col gap-2.5">
      {/* File-format + per-column behaviour explanation — reads like FieldsTab's Part-1 context card. */}
      <Card className="gap-0 py-0">
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <FileText className="size-4 text-primary" /><span>File Format &amp; Columns</span>
          </div>
          <div className="text-muted-foreground text-[13px] leading-relaxed">
            The artefact file must be a spreadsheet (<strong className="text-foreground">.xlsx</strong>) with a header row.
          </div>
          <div className="text-muted-foreground text-[13px] leading-relaxed">
            Every column configured here must be present when the file is parsed, even if some cells are empty. Additional (unconfigured) columns are still parsed and appear in the source record panel. All parsed columns are sent to the AI in the vision-analysis prompt.
          </div>
        </div>
      </Card>

      {/* Unified System Prompt (Call 1). Persona + output-format preamble in one
          Override-gated field — disabled by default since its preamble tells the
          model how to format responses (editing it can break parsing). The
          dynamic per-field XML enumeration and the <artefact_file> record block
          are appended by Rust at runtime (visible in the Preview). */}
      <Card className="gap-2 py-3.5">
        <Field
          label="System Prompt"
          desc="Persona + output format for Call 1. The image and per-column guidance below attach alongside; the artefact-file record is included. Edit with care."
          action={
            <>
              <Button onClick={() => setPreviewOpen(true)} variant="secondary" size="sm" className="shrink-0">
                <Eye className="size-3" />
                <span>Preview Prompt</span>
              </Button>
              {state.contractEditing ? (
                <Button
                  onClick={() => { actions.updateVisionSystemPromptInstruction(""); actions.setPromptEditing(false); }}
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
            value={live.visionSystemPromptInstruction || ""}
            onChange={(e) => actions.updateVisionSystemPromptInstruction(e.target.value)}
            readOnly={!state.contractEditing}
            rows={5}
            className={cn("resize-y leading-relaxed", !state.contractEditing && "bg-muted/40 text-muted-foreground")}
          />
        </Field>
        <div className="px-4">
          <CardActions
            dirty={visionInstrDirty}
            status={state.artefactCardSaveStatus["vision-instruction"] ?? null}
            onSave={() => { void actions.saveVisionSystemPromptInstruction(); actions.setPromptEditing(false); }}
            onDiscard={() => { actions.discardVisionSystemPromptInstruction(); actions.setPromptEditing(false); }}
          />
        </div>
      </Card>

      <ExpandCollapseAll
        onExpandAll={() => actions.setAllExpanded("artefactFieldExpanded", live.artefactFields.map((f) => f.id), true)}
        onCollapseAll={() => actions.setAllExpanded("artefactFieldExpanded", live.artefactFields.map((f) => f.id), false)}
      />

      <Card className="gap-0 overflow-hidden p-0">
        <div className="bg-muted/30 grid grid-cols-[24px_1fr_1fr] gap-2.5 border-b px-3.5 py-1.75">
          <span />
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Column Name</span>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Description</span>
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={live.artefactFields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
            {live.artefactFields.map((af) => {
              const saved = (settings.artefactFields || _DEF_AF).find((s) => s.id === af.id);
              const cardDirty = !!state.artefactDraft && (!saved || fieldsDiffer(
                { ...af, description: af.description ?? "", prompt: af.prompt ?? "" },
                { ...saved, description: saved.description ?? "", prompt: saved.prompt ?? "" },
                ["id", "name", "description", "prompt"],
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
          </SortableContext>
        </DndContext>
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
        build={buildVisionPreview}
        description={
          <>
            The exact message sent to your AI provider as the unified Call 1 of each parsing job,
            including the persona, output-format preamble, and the Rust-appended per-field XML
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
 *  editor (mirrors FieldsTab's SortableFieldRow). */
interface ArtefactColumnRowProps {
  field: { id: string; name: string; description: string; prompt: string };
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: af.id });
  return (
    <div
      ref={(node) => { setNodeRef(node); cardRef?.(node); }}
      className="border-border/60 border-b"
      style={{
        transform: CSS.Transform.toString(transform) || undefined,
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
    >
      <div
        onClick={() => actions.toggleAF(af.id)}
        className="grid cursor-pointer grid-cols-[24px_1fr_1fr] items-center gap-2.5 px-3.5 py-2.25"
      >
        <div
          className={cn("text-muted-foreground flex items-center", isDragging ? "cursor-grabbing" : "cursor-grab")}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[15px] font-semibold">{af.name || "Untitled column"}</span>
          <UnsavedBadge dirty={dirty} />
        </div>
        <span className="text-muted-foreground truncate text-sm">{af.description || "—"}</span>
      </div>
      {expanded && (
        <div className="bg-muted/30 flex flex-col gap-2.5 border-t px-3.5 pt-2.5 pb-3.5 animate-in fade-in slide-in-from-top-1 duration-100">
          <FieldInput
            label="Column Name"
            value={af.name}
            onChange={(e) => actions.updateAF(af.id, "name", e.target.value)}
            desc="Must match a column header in the uploaded spreadsheet (case-insensitive)."
          />
          <FieldInput
            label="Description"
            value={af.description}
            onChange={(e) => actions.updateAF(af.id, "description", e.target.value)}
            placeholder="What does this column contain?"
            desc="Internal note about this column, shown in the columns list — not sent to the AI."
            labelSuffix={<Badge variant="secondary" className="text-[10px] font-normal tracking-[0.04em]">Optional</Badge>}
          />
          <FieldTextarea
            label="Prompt Instruction"
            value={af.prompt}
            onChange={(e) => actions.updateAF(af.id, "prompt", e.target.value)}
            placeholder="How should the vision-analysis step use this column's value? (optional)"
            desc="Optional per-column guidance for the vision-analysis call. Leave blank to send this column's value with no field-specific guidance — it is omitted from the prompt."
            labelSuffix={<Badge variant="secondary" className="text-[10px] font-normal tracking-[0.04em]">Optional</Badge>}
            rows={2}
            className="resize-y leading-relaxed"
          />
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
    </div>
  );
}
