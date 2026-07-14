import { Button } from "@/components/ui/button";

interface ExpandCollapseAllProps {
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

/** Shared "Expand all / Collapse all" control for a card-list tab. Placed
 *  above the rows Card; each tab wires its own ids + expanded-map scope into
 *  actions.setAllExpanded via the two callbacks. */
export function ExpandCollapseAll({ onExpandAll, onCollapseAll }: ExpandCollapseAllProps) {
  return (
    <div className="flex items-center justify-end gap-2">
      <Button onClick={onExpandAll} variant="ghost" size="sm" className="text-muted-foreground">
        Expand all
      </Button>
      <Button onClick={onCollapseAll} variant="ghost" size="sm" className="text-muted-foreground">
        Collapse all
      </Button>
    </div>
  );
}
