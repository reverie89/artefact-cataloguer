import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Plus, X } from "lucide-react";
import type { AppActions } from "../../app/actions";
import type { AppState } from "../../app/state";
import { fieldsDiffer } from "../../app/drafts";
import { displayName } from "../../app/styles";
import type { CatalogueField, FieldType, VocabSource } from "../../app/types";
import { CardActions } from "./CardActions";
import { Field, FieldInput, FieldTextarea, Segmented } from "./FormControls";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { ExpandCollapseAll } from "@/components/common/ExpandCollapseAll";
import { SortableList } from "./SortableList";
import { SortableRow } from "./SortableRow";
import { useScrollNewRowIntoView } from "../../hooks/useScrollNewRowIntoView";

interface Props {
  state: AppState;
  actions: AppActions;
}

/** Badge suffix marking a multi-component vocab field: ×N components, ×∞ for
 *  unlimited (0). Single-pick fields (1) get no suffix — that's the default. */
function vocabComponentSuffix(maxComponents: number): string {
  if (maxComponents === 1) return "";
  return maxComponents === 0 ? " · ×∞" : ` · ×${maxComponents}`;
}

/** Desc copy for the Distinct components input — what the number means and
 *  what the pipeline does at the current value. The number is a cap applied
 *  in Rust after validation; the partition prompt never sees it. */
function componentsDesc(maxComponents: number, shortlistCount: number): string {
  const meaning =
    "Terms the AI records: 1 = only the top match; 2+ = one top match per distinct component, keeping this many best-validated picks; 0 = unlimited.";
  if (maxComponents === 1) {
    return `${meaning} Validation shortlists ${shortlistCount} candidates for the top pick.`;
  }
  if (maxComponents === 0) {
    return `${meaning} Every perceived component is retrieved and shortlisted (${shortlistCount} candidates each).`;
  }
  return `${meaning} Components are retrieved separately (${shortlistCount} candidates each).`;
}

/** Grid template shared by the header row and each field row (via SortableRow)
 *  so columns align exactly: grip / Name / Type. The Type column is wide
 *  enough for the multi-component suffix ("Controlled vocab · ×3"). */
const GRID = "grid-cols-[24px_1fr_170px] gap-2.5 px-3.5";

export function CataloguingFieldsTab({ state, actions }: Props) {
  const { settings, settingsFieldExpanded } = state;

  // Render from the pending draft if there are unsaved edits, otherwise from
  // persisted settings. Edits accumulate in the draft and only hit disk on Save.
  const live = useMemo(
    () => state.fieldDraft ?? { fields: settings.fields },
    [state.fieldDraft, settings.fields]
  );

  // Per-row DOM refs so a newly-added row can be scrolled into view.
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  useScrollNewRowIntoView(live.fields.length, rowRefs, live.fields[live.fields.length - 1]?.id);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-muted-foreground text-sm px-0.5 pb-1.5 leading-relaxed">
        Teach the AI how to fill in each field: click a row to edit its prompt and type. Open-ended fields get a
        free-text answer; Controlled vocab fields are matched against terms from your Vocabulary Lists. The system
        prompt lives on the Artefact File tab.
      </div>

      <ExpandCollapseAll
        onExpandAll={() => actions.setAllExpanded("settingsFieldExpanded", live.fields.map((f) => f.id), true)}
        onCollapseAll={() => actions.setAllExpanded("settingsFieldExpanded", live.fields.map((f) => f.id), false)}
      />

      <Card className="gap-0 overflow-hidden p-0">
        <div className={cn("bg-muted/30 grid border-b py-1.75", GRID)}>
          <span />
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Name</span>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Type</span>
        </div>
        <SortableList
          items={live.fields.map((f) => f.id)}
          onReorder={(ids) => void actions.reorderFields(ids)}
        >
          {live.fields.map((f) => {
            const saved = settings.fields.find((s) => s.id === f.id);
            const fieldDirty = !!state.fieldDraft && (!saved || fieldsDiffer(f, saved, ["id", "name", "type", "layout", "prompt", "vocabSources", "maxComponents"]));
            return (
              <SortableFieldRow
                key={f.id}
                field={f}
                lists={settings.vocabSources}
                shortlistCount={settings.vocabShortlistCount}
                expanded={!!settingsFieldExpanded[f.id]}
                dirty={fieldDirty}
                cardStatus={state.fieldCardSaveStatus[f.id] ?? null}
                cardRef={(node) => { rowRefs.current[f.id] = node; }}
                actions={actions}
              />
            );
          })}
        </SortableList>
      </Card>

      <Button onClick={actions.startAddField} variant="outline" className="text-muted-foreground w-full border-dashed">
        <Plus className="size-3" /><span>Add Field</span>
      </Button>
    </div>
  );
}

/** A single reorderable catalogue-field row (shared SortableRow shell).
 *  Clicking anywhere on the row toggles the editor; the grip is drag-only. */
interface SortableFieldRowProps {
  field: CatalogueField;
  lists: VocabSource[];
  /** Global AI shortlist count — the per-component candidate multiplier basis
   *  for the Distinct components desc. */
  shortlistCount: number;
  expanded: boolean;
  /** Whether this field row has unsaved content edits. */
  dirty: boolean;
  /** Persist status of this row's own Save button. */
  cardStatus: SaveState;
  /** Registers this row's root DOM node so the parent can scroll it into view. */
  cardRef?: (node: HTMLDivElement | null) => void;
  actions: AppActions;
}

function SortableFieldRow({ field: f, lists, shortlistCount, expanded, dirty, cardStatus, cardRef, actions }: SortableFieldRowProps) {
  return (
    <SortableRow
      id={f.id}
      expanded={expanded}
      onToggle={() => actions.toggleSF(f.id)}
      grid={GRID}
      cardRef={cardRef}
      label={
        <>
          <span className="truncate text-[15px] font-semibold">{f.name || "Untitled field"}</span>
          <UnsavedBadge dirty={dirty} />
        </>
      }
      cells={
        <Badge variant={f.type === "vocab" ? "default" : "secondary"} className="w-fit tracking-[0.04em]">
          {f.type === "vocab"
            ? `Controlled vocab${vocabComponentSuffix(f.maxComponents)}`
            : "Open-ended"}
        </Badge>
      }
    >
      {expanded && (
        <div className="bg-muted/30 flex flex-col gap-2.5 border-t px-3.5 pt-2.5 pb-3.5 animate-in fade-in slide-in-from-top-1 duration-100">
          <FieldEditor
            field={f}
            lists={lists}
            shortlistCount={shortlistCount}
            onName={(v) => actions.updateField(f.id, "name", v)}
            onType={(v) => actions.updateField(f.id, "type", v)}
            onMaxComponents={(v) => actions.updateField(f.id, "maxComponents", v)}
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
    </SortableRow>
  );
}

/** Shared editor body for a catalogue field. Rendered inside the expanded row
 *  editor. Kept as a component so the field edits stay in one place (DRY). */
interface FieldEditorProps {
  field: { name: string; type: FieldType; prompt: string; vocabSources: string[]; maxComponents: number };
  lists: VocabSource[];
  /** Global AI shortlist count — per-component candidate multiplier basis. */
  shortlistCount: number;
  onName: (v: string) => void;
  onType: (v: FieldType) => void;
  onMaxComponents: (v: number) => void;
  onPrompt: (v: string) => void;
  onAddSource: (vId: string) => void;
  onRemoveSource: (vId: string) => void;
}

function FieldEditor({ field, lists, shortlistCount, onName, onType, onMaxComponents, onPrompt, onAddSource, onRemoveSource }: FieldEditorProps) {
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
        desc="Shown in the fields list and as the column header in exported results."
      />
      <Field
        label="Type"
        desc="Whether the AI can suggest any value (Open-ended) or must pick from attached vocabulary sources (Controlled vocab)."
      >
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
        <FieldInput
          label="Distinct components"
          type="number"
          value={String(field.maxComponents)}
          onChange={(e) => onMaxComponents(Number(e.target.value))}
          desc={componentsDesc(field.maxComponents, shortlistCount)}
        />
      )}
      {field.type === "vocab" && (
        <Field
          label="Vocabulary Sources"
          labelSuffix={sources.length === 0 && (
            <Badge variant="destructive" className="gap-1 text-[10px] font-normal tracking-[0.04em]">
              <AlertTriangle className="size-2.5" />
              No source added
            </Badge>
          )}
          desc="Terms the AI can draw from and match against for this field."
        >
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
        </Field>
      )}
      <FieldTextarea
        label="Prompt Instruction"
        desc={field.type === "vocab"
          ? "Teach the AI what to look for when extracting this field — and, with validation on, how to pick the closest matching vocabulary terms."
          : "Teach the AI how to answer this field."}
        value={field.prompt}
        onChange={(e) => onPrompt(e.target.value)}
        rows={2}
        className="resize-y leading-relaxed"
      />
    </>
  );
}
