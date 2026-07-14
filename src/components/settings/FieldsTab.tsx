import { useCallback, useEffect, useRef, useState } from "react";
import { DndContext, type DragEndEvent, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertTriangle, Eye, GripVertical, Plus, X } from "lucide-react";
import type { AppActions } from "../../app/actions";
import type { AppState } from "../../app/state";
import { _DEF_SYSTEM_PROMPT_CONTRACT } from "../../app/defaults";
import { fieldsDiffer } from "../../app/drafts";
import { displayName } from "../../app/styles";
import type { CatalogueField, FieldType, Settings, VocabList } from "../../app/types";
import { CardActions } from "./CardActions";
import { Field, FieldInput, FieldTextarea, Segmented } from "./FormControls";
import { PromptPreviewSheet } from "./PromptPreviewSheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { SaveState } from "./SaveActions.types";
import { UnsavedBadge } from "./UnsavedBadge";
import { ExpandCollapseAll } from "./ExpandCollapseAll";

interface Props {
  state: AppState;
  actions: AppActions;
}

export function FieldsTab({ state, actions }: Props) {
  const { settings, settingsFieldExpanded } = state;

  // Render from the pending draft if there are unsaved edits, otherwise from
  // persisted settings. Edits accumulate in the draft and only hit disk on Save.
  const live = state.fieldDraft ?? {
    systemPromptInstruction: settings.systemPromptInstruction,
    systemPromptContractOverride: settings.systemPromptContractOverride ?? "",
    fields: settings.fields,
  };
  const instrDirty = !!state.fieldDraft && state.fieldDraft.systemPromptInstruction !== settings.systemPromptInstruction;
  const contractDirty = !!state.fieldDraft && (state.fieldDraft.systemPromptContractOverride ?? "") !== (settings.systemPromptContractOverride ?? "");

  // Per-row DOM refs so a newly-added row can be scrolled into view. A ref
  // tracks the previous field count so the scroll fires ONLY when the count
  // grows (an Add), never on content edits, deletes, or reorders — which also
  // change `live.fields`. Mirrors ProvidersTab's add-scroll behaviour.
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const prevCountRef = useRef(live.fields.length);
  useEffect(() => {
    const grew = live.fields.length > prevCountRef.current;
    prevCountRef.current = live.fields.length;
    if (!grew) return;
    // Add appends, so the new row is the last. Scroll it into view.
    const last = live.fields[live.fields.length - 1];
    const node = last ? rowRefs.current[last.id] : null;
    // block:"nearest" avoids jumping when the row is already partly visible;
    // a small timeout lets the expanded body measure before scrolling.
    const t = setTimeout(() => node?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 30);
    return () => clearTimeout(t);
  }, [live.fields]);

  // Local UI state for the Prompt Preview sheet. `previewOpen` lives here rather
  // than in the app reducer because the sheet is a transient FieldsTab affordance.
  const [previewOpen, setPreviewOpen] = useState(false);
  // Settings with the in-progress draft merged in, so the preview reflects
  // exactly what would be sent if the user saved now.
  const previewSettings: Settings = { ...settings, ...live };

  // Require a small drag threshold so a normal click on a row still toggles the
  // editor instead of starting a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const ids = live.fields.map((f) => f.id);
      const from = ids.indexOf(active.id as string);
      const to = ids.indexOf(over.id as string);
      if (from === -1 || to === -1) return;
      void actions.reorderFields(arrayMove(ids, from, to));
    },
    [live.fields, actions]
  );

  // The output-contract (Part 2) box is read-only unless the user has pressed
  // Override (gated by a warning confirmation in actions.overrideContract). It
  // always re-locks on Save/Discard, so overriding always starts with Override.
  const contractEditing = state.contractEditing;
  const contractValue = live.systemPromptContractOverride || _DEF_SYSTEM_PROMPT_CONTRACT;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-muted-foreground text-sm px-0.5 pb-1.5 leading-relaxed">
        Configure the fields the AI will extract for each artefact. Click a row to edit its prompt and type.
      </div>

      {/* Part 1 — editable context prose. Prepended verbatim to every request. */}
      <Card className="gap-2 py-3.5">
        <Field
          label="System Instructions"
          desc="Your customizable context and guidance. Prepended verbatim to every catalogue request."
          action={
            <Button onClick={() => setPreviewOpen(true)} variant="secondary" size="sm" className="shrink-0">
              <Eye className="size-3" />
              <span>Preview Prompt</span>
            </Button>
          }
          className="px-4"
        >
          <Textarea
            value={live.systemPromptInstruction || ""}
            onChange={(e) => actions.updateSystemPromptInstruction(e.target.value)}
            rows={4}
            className="resize-y leading-relaxed"
          />
        </Field>
        <div className="px-4">
          <CardActions
            dirty={instrDirty}
            status={state.fieldCardSaveStatus["system-instruction"] ?? null}
            onSave={() => void actions.saveSystemInstruction()}
            onDiscard={actions.discardSystemInstruction}
          />
        </div>
      </Card>

      {/* Part 2 — locked output contract. Read-only unless overridden. */}
      <Card className="gap-2 py-3.5">
        <Field
          label="Output Contract"
          desc="Required for the app to read responses. Do not edit unless you know what you&apos;re doing!"
          action={
            contractEditing ? (
              <Button
                onClick={() => { actions.updateSystemPromptContract(""); actions.setContractEditing(false); }}
                variant="ghost"
                size="sm"
                className="shrink-0"
              >
                Reset to default
              </Button>
            ) : (
              <Button onClick={() => void actions.overrideContract()} variant="secondary" size="sm" className="shrink-0">
                Override
              </Button>
            )
          }
          className="px-4"
        >
          <Textarea
            value={contractValue}
            onChange={(e) => actions.updateSystemPromptContract(e.target.value)}
            readOnly={!contractEditing}
            rows={5}
            className={cn("resize-y leading-relaxed", !contractEditing && "bg-muted/40 text-muted-foreground")}
          />
        </Field>
        <div className="px-4">
          <CardActions
            dirty={contractDirty}
            status={state.fieldCardSaveStatus["output-contract"] ?? null}
            onSave={() => void actions.saveContract()}
            onDiscard={actions.discardContract}
          />
        </div>
      </Card>

      <ExpandCollapseAll
        onExpandAll={() => actions.setAllExpanded("settingsFieldExpanded", live.fields.map((f) => f.id), true)}
        onCollapseAll={() => actions.setAllExpanded("settingsFieldExpanded", live.fields.map((f) => f.id), false)}
      />

      <Card className="gap-0 overflow-hidden p-0">
        <div className="bg-muted/30 grid grid-cols-[24px_1fr_130px] gap-2.5 border-b px-3.5 py-1.75">
          <span />
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Name</span>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Type</span>
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={live.fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
            {live.fields.map((f) => {
              const saved = settings.fields.find((s) => s.id === f.id);
              const fieldDirty = !!state.fieldDraft && (!saved || fieldsDiffer(f, saved, ["id", "name", "type", "layout", "prompt", "vocabSources"]));
              return (
                <SortableFieldRow
                  key={f.id}
                  field={f}
                  lists={settings.vocabularyLists}
                  expanded={!!settingsFieldExpanded[f.id]}
                  dirty={fieldDirty}
                  cardStatus={state.fieldCardSaveStatus[f.id] ?? null}
                  cardRef={(node) => { rowRefs.current[f.id] = node; }}
                  actions={actions}
                />
              );
            })}
          </SortableContext>
        </DndContext>
      </Card>

      <Button onClick={actions.startAddField} variant="outline" className="text-muted-foreground w-full border-dashed">
        <Plus className="size-3" /><span>Add Field</span>
      </Button>

      <PromptPreviewSheet open={previewOpen} onClose={() => setPreviewOpen(false)} settings={previewSettings} />
    </div>
  );
}

/** A single reorderable catalogue-field row. The GripVertical handle is the
 *  drag anchor; clicking anywhere else on the row toggles the editor. */
interface SortableFieldRowProps {
  field: CatalogueField;
  lists: VocabList[];
  expanded: boolean;
  /** Whether this field row has unsaved content edits. */
  dirty: boolean;
  /** Persist status of this row's own Save button. */
  cardStatus: SaveState;
  /** Registers this row's root DOM node so the parent can scroll it into view. */
  cardRef?: (node: HTMLDivElement | null) => void;
  actions: AppActions;
}

function SortableFieldRow({ field: f, lists, expanded, dirty, cardStatus, cardRef, actions }: SortableFieldRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: f.id });
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
      <div onClick={() => actions.toggleSF(f.id)} className="grid cursor-pointer grid-cols-[24px_1fr_130px] items-center gap-2.5 px-3.5 py-2.25">
        <div
          className={cn("text-muted-foreground flex items-center", isDragging ? "cursor-grabbing" : "cursor-grab")}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[15px] font-semibold">{f.name || "Untitled field"}</span>
          <UnsavedBadge dirty={dirty} />
        </div>
        <Badge variant={f.type === "vocab" ? "default" : "secondary"} className="w-fit tracking-[0.04em]">
          {f.type === "vocab" ? "Controlled Vocab" : "Open-ended"}
        </Badge>
      </div>
      {expanded && (
        <div className="bg-muted/30 flex flex-col gap-2.5 border-t px-3.5 pt-2.5 pb-3.5 animate-in fade-in slide-in-from-top-1 duration-100">
          <FieldEditor
            field={f}
            lists={lists}
            onName={(v) => actions.updateField(f.id, "name", v)}
            onType={(v) => actions.updateField(f.id, "type", v)}
            onPrompt={(v) => actions.updateField(f.id, "prompt", v)}
            onAddSource={(vId) => actions.addVocabSrc(f.id, vId)}
            onRemoveSource={(vId) => actions.removeVocabSrc(f.id, vId)}
          />
          {/* Per-card actions: Delete/Discard/Save target only this field.
              Delete buffers into the draft (flushed by the Apply banner). */}
          <CardActions
            dirty={dirty}
            status={cardStatus}
            onSave={() => void actions.saveFieldCard(f.id)}
            onDiscard={() => actions.discardFieldCard(f.id)}
            onDelete={() => void actions.removeField(f.id)}
            deleteLabel="Delete Field"
          />
        </div>
      )}
    </div>
  );
}

/** Shared editor body for a catalogue field. Rendered inside the expanded row
 *  editor. Kept as a component so the field edits stay in one place (DRY). */
interface FieldEditorProps {
  field: { name: string; type: FieldType; prompt: string; vocabSources: string[] };
  lists: VocabList[];
  onName: (v: string) => void;
  onType: (v: FieldType) => void;
  onPrompt: (v: string) => void;
  onAddSource: (vId: string) => void;
  onRemoveSource: (vId: string) => void;
}

function FieldEditor({ field, lists, onName, onType, onPrompt, onAddSource, onRemoveSource }: FieldEditorProps) {
  const sources = field.vocabSources || [];
  const available = lists.filter((v) => !sources.includes(v.id));
  // Radix keeps the last-selected item's label displayed even after it's
  // filtered out of `available`, leaving the trigger blank. Remounting via a
  // changing `key` resets it back to uncontrolled/placeholder state each add.
  const [addKey, setAddKey] = useState(0);
  return (
    <>
      <FieldInput
        label="Field Name"
        value={field.name}
        onChange={(e) => onName(e.target.value)}
        placeholder="Field name"
      />
      <Field label="Type">
        <Segmented
          value={field.type}
          onChange={(v) => onType(v as FieldType)}
          options={[
            { value: "open", label: "Open-ended" },
            { value: "vocab", label: "Controlled vocab" },
          ]}
        />
      </Field>
      {field.type === "vocab" && (
        <div className="flex flex-col gap-1.25">
          <div className="flex items-center gap-1.5">
            <Label className="text-muted-foreground text-xs uppercase tracking-[0.08em]">Vocabulary Sources</Label>
            {sources.length === 0 && (
              <Badge variant="destructive" className="gap-1 text-[10px] font-normal tracking-[0.04em]">
                <AlertTriangle className="size-2.5" />
                No source added
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.25">
            {sources.map((sid) => {
              const vl = lists.find((v) => v.id === sid);
              if (!vl) return null;
              return (
                <div key={sid} className="flex items-center gap-1.25 rounded border px-2.5 py-1 text-sm">
                  <span>{displayName(vl)}</span>
                  <button onClick={() => onRemoveSource(sid)} className="text-muted-foreground pl-0.75 cursor-pointer"><X className="size-2.5" /></button>
                </div>
              );
            })}
            {available.length > 0 && (
              <Select key={addKey} onValueChange={(v) => { if (v) onAddSource(v); setAddKey((k) => k + 1); }}>
                <SelectTrigger className="text-muted-foreground h-8 w-auto gap-1 text-[13px]">
                  <SelectValue placeholder="+ Add source" />
                </SelectTrigger>
                <SelectContent>
                  {available.map((v) => (
                    <SelectItem key={v.id} value={v.id}>{displayName(v)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>
      )}
      <FieldTextarea
        label="Prompt Instruction"
        desc="Field-specific instruction. The system instructions above are prepended automatically."
        value={field.prompt}
        onChange={(e) => onPrompt(e.target.value)}
        rows={2}
        className="resize-y leading-relaxed"
      />
    </>
  );
}
