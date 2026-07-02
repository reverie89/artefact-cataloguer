import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SaveState } from "./SaveActions.types";
import { SettingsSaveActions, SaveStatus } from "./SaveActions";

interface CardActionsProps {
  /** Whether this card has unsaved edits. Gates the Save/Discard buttons'
   *  visibility (kept in-layout via invisible to avoid pop-in). */
  dirty: boolean;
  onDiscard: () => void;
  onSave: () => void;
  /** Persist status shown at the far left of the action row. */
  status: SaveState;
  /** Discard button label — "Cancel" reads better on some cards. */
  discardLabel?: string;
  /** Per-card delete. When provided, a destructive "Delete" button renders in
   *  the action row (left of Discard). Omit on cards with no delete affordance
   *  (e.g. the System Instructions / Output Contract prose cards). The
   *  underlying delete action runs its own confirm dialog. */
  onDelete?: () => void;
  /** Delete button label. */
  deleteLabel?: string;
  /** Specific reason shown in place of the generic "Not saved" when the card's
   *  Save failed (e.g. "Needs a name"). Omit to keep the default wording. */
  errorMessage?: string;
}

/**
 * Per-card action row for the deferred-save settings cards: a right-flush
 * cluster of `[status][Delete][Discard][Save]`. Lives inside each card's body
 * (a provider card, an expanded field/column row, a vocab inline editor, or a
 * prose card) so Save/Discard/Delete operate on that single card.
 *
 * Save/Discard only become visible once `dirty` is true, but they always occupy
 * the layout (invisible) so nothing shifts when a change is detected.
 */
export function CardActions({ dirty, onDiscard, onSave, status, discardLabel = "Discard", onDelete, deleteLabel = "Delete", errorMessage }: CardActionsProps) {
  const saving = status === "saving";
  return (
    <div className="flex items-center gap-2">
      <SaveStatus status={status} className="ml-auto" errorMessage={errorMessage} />
      {onDelete && (
        <Button onClick={onDelete} disabled={saving} variant="destructive" size="sm">
          <Trash2 className="size-3" />
          <span>{deleteLabel}</span>
        </Button>
      )}
      <Button
        onClick={onDiscard}
        disabled={!dirty || saving}
        variant="ghost"
        size="sm"
        className={cn(!dirty && "invisible")}
        aria-hidden={!dirty}
        tabIndex={dirty ? 0 : -1}
      >
        {discardLabel}
      </Button>
      <SettingsSaveActions status={status} onSave={onSave} hidden={!dirty} hideStatus />
    </div>
  );
}
