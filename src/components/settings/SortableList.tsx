import { useCallback, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";

interface Props {
  /** Row ids in display order — doubles as the SortableContext items. */
  items: string[];
  /** Called with the full id list in the new order after a drop. */
  onReorder: (ids: string[]) => void;
  children: ReactNode;
}

/** Vertical drag-to-reorder list shared by the settings card-list tabs
 *  (Fields, Artefact File, Vocab). Owns the DndContext/sensors wiring and the
 *  drop→reorder guard; rows themselves call `useSortable` and apply the drag
 *  transform inline (the sanctioned runtime-computed exception). The 5px
 *  PointerSensor activation distance keeps a normal row click a click, not a
 *  drag. */
export function SortableList({ items, onReorder, children }: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const from = items.indexOf(active.id as string);
      const to = items.indexOf(over.id as string);
      if (from === -1 || to === -1) return;
      onReorder(arrayMove(items, from, to));
    },
    [items, onReorder]
  );

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}
