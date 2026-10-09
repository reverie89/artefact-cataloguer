import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  /** Stable row id — the useSortable id and drag payload. */
  id: string;
  /** Expanded state: drives the chevron; gate `children` at the call site. */
  expanded: boolean;
  /** Row click — toggles the editor. The grip is drag-only and stops propagation. */
  onToggle: () => void;
  /** Grid template (grid-cols + gap + px), the same const the tab's header row
   *  composes — tabs show different columns after the label, so widths stay
   *  per-tab and only need to align within their own card. */
  grid: string;
  /** Registers the row's root DOM node (scroll-new-row-into-view). */
  cardRef?: (node: HTMLDivElement | null) => void;
  /** First cell content after the chevron (name, badges, icons). */
  label: ReactNode;
  /** Remaining summary cells after the label cell. */
  cells?: ReactNode;
  children?: ReactNode;
}

/** Shared summary row for the settings card-list tabs (Fields, Vocab, Artefact
 *  File, Providers): grip + expand chevron + label + cells, with the expanded
 *  editor passed as children so it renders under the summary row and moves with
 *  the drag. Owns everything the five tabs used to duplicate: the useSortable
 *  wiring, the combined node/card ref, the drag transform/transition/opacity
 *  inline styles (the sanctioned runtime-computed exception), and the GripVertical
 *  handle — drag from the grip; clicking anywhere else on the row toggles. */
export function SortableRow({ id, expanded, onToggle, grid, cardRef, label, cells, children }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
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
      <div onClick={onToggle} className={cn("grid cursor-pointer items-center gap-2.5 px-3.5 py-2.25", grid)}>
        <div
          className={cn("text-muted-foreground flex items-center", isDragging ? "cursor-grabbing" : "cursor-grab")}
          onClick={(e) => e.stopPropagation()}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {expanded ? <ChevronDown className="text-muted-foreground size-3" /> : <ChevronRight className="text-muted-foreground size-3" />}
          {label}
        </div>
        {cells}
      </div>
      {children}
    </div>
  );
}
