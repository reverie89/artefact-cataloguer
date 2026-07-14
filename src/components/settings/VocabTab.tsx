import { useCallback } from "react";
import { DndContext, type DragEndEvent, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { BookOpen, GripVertical, Upload } from "lucide-react";
import type { AppActions } from "../../app/actions";
import type { AppState } from "../../app/state";
import { displayName } from "../../app/styles";
import type { VocabList } from "../../app/types";
import { CardActions } from "./CardActions";
import { FieldInput } from "./FormControls";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { SaveState } from "./SaveActions.types";
import { UnsavedBadge } from "./UnsavedBadge";
import { ExpandCollapseAll } from "./ExpandCollapseAll";

interface Props {
  state: AppState;
  actions: AppActions;
}

export function VocabTab({ state, actions }: Props) {
  const { settings } = state;

  const live = state.vocabDraft ?? { vocabularyLists: settings.vocabularyLists };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const ids = live.vocabularyLists.map((v) => v.id);
      const from = ids.indexOf(active.id as string);
      const to = ids.indexOf(over.id as string);
      if (from === -1 || to === -1) return;
      void actions.reorderVocab(arrayMove(ids, from, to));
    },
    [live.vocabularyLists, actions]
  );

  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-muted-foreground text-sm px-0.5 pb-1.5 leading-relaxed">
        Manage the controlled-vocabulary lists fields can draw terms from. Click a row to rename; drag to reorder.
      </div>

      <ExpandCollapseAll
        onExpandAll={() => actions.setAllExpanded("settingsVocabExpanded", live.vocabularyLists.map((v) => v.id), true)}
        onCollapseAll={() => actions.setAllExpanded("settingsVocabExpanded", live.vocabularyLists.map((v) => v.id), false)}
      />

      <Card className="gap-0 overflow-hidden p-0">
        <div className="bg-muted/30 grid grid-cols-[24px_1fr_36px] gap-2.5 border-b px-3.5 py-1.75">
          <span />
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Name / File</span>
          <span />
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={live.vocabularyLists.map((v) => v.id)} strategy={verticalListSortingStrategy}>
            {live.vocabularyLists.map((vl) => {
              const saved = settings.vocabularyLists.find((s) => s.id === vl.id);
              const draftList = state.vocabDraft?.vocabularyLists.find((v) => v.id === vl.id);
              const cardDirty = !!state.vocabDraft && (!saved || (draftList?.name ?? "") !== (saved.name ?? ""));
              return (
                <SortableVocabRow
                  key={vl.id}
                  vl={vl}
                  expanded={!!state.settingsVocabExpanded[vl.id]}
                  dirty={cardDirty}
                  cardStatus={state.vocabCardSaveStatus[vl.id] ?? null}
                  liveFields={state.fieldDraft?.fields ?? settings.fields}
                  actions={actions}
                />
              );
            })}
          </SortableContext>
        </DndContext>
        {live.vocabularyLists.length === 0 && (
          <div className="text-muted-foreground p-5 text-center text-[15px]">No vocabulary files uploaded yet</div>
        )}
      </Card>

      <div
        onClick={actions.onVocabClick}
        onDragOver={actions.onVocabDragOver}
        onDragLeave={actions.onVocabDragLeave}
        onDrop={actions.onVocabDrop}
        className="bg-muted/30 flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed p-4.5 text-center"
      >
        <div className="bg-muted flex size-8 items-center justify-center rounded-md"><Upload className="size-4 text-primary" /></div>
        <div className="text-[15px]">Drop vocabulary files here</div>
        <div className="text-muted-foreground text-sm">or <span className="text-primary">browse for files</span>. Accepted formats: .xlsx, .xls, .csv</div>
      </div>
    </div>
  );
}

interface SortableVocabRowProps {
  vl: VocabList;
  expanded: boolean;
  dirty: boolean;
  cardStatus: SaveState;
  liveFields: { id: string; name: string; vocabSources?: string[] }[];
  actions: AppActions;
}

function SortableVocabRow({ vl, expanded, dirty, cardStatus, liveFields, actions }: SortableVocabRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: vl.id });
  const usedBy = liveFields.filter((f) => (f.vocabSources || []).includes(vl.id)).map((f) => f.name).join(", ") || null;

  return (
    <div
      ref={setNodeRef}
      className="border-border/60 border-b"
      style={{
        transform: CSS.Transform.toString(transform) || undefined,
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
    >
      <div
        onClick={() => actions.toggleVocab(vl.id)}
        className="grid cursor-pointer grid-cols-[24px_1fr_36px] items-center gap-2.5 px-3.5 py-2.25"
      >
        <div
          className={cn("text-muted-foreground flex items-center", isDragging ? "cursor-grabbing" : "cursor-grab")}
          onClick={(e) => e.stopPropagation()}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </div>
        <div className="flex min-w-0 items-center gap-1.75">
          <BookOpen className="size-3.5 shrink-0" />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-medium">{displayName(vl)}</div>
            <div className="text-muted-foreground truncate text-[11px]">{vl.filename}</div>
          </div>
          <UnsavedBadge dirty={dirty} />
        </div>
        <Button
          onClick={(e) => { e.stopPropagation(); void actions.removeVocabList(vl.id); }}
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-destructive size-6"
          title="Delete"
        >
          <span className="text-[13px] leading-none">×</span>
        </Button>
      </div>

      {expanded && (
        <div className="bg-muted/30 flex flex-col gap-2.5 border-t px-3.5 pt-2.5 pb-3.5 animate-in fade-in slide-in-from-top-1 duration-100">
          <FieldInput
            label="Display Name"
            value={vl.name ?? ""}
            onChange={(e) => actions.updateVocabName(vl.id, e.target.value)}
            placeholder={vl.filename.replace(/\.[^.]+$/, "")}
          />
          <div className="text-muted-foreground text-[12px]">
            {vl.filename} · {vl.terms} terms · {vl.uploadDate}
            {usedBy && <> · Used by: {usedBy}</>}
          </div>
          <CardActions
            dirty={dirty}
            status={cardStatus}
            onSave={() => void actions.saveVocabCard(vl.id)}
            onDiscard={() => actions.discardVocabCard(vl.id)}
            onDelete={() => void actions.removeVocabList(vl.id)}
            deleteLabel="Delete List"
          />
        </div>
      )}
    </div>
  );
}

