import { Badge } from "@/components/ui/badge";

/** Shared "unsaved" indicator for a card-list row title. The single place
 *  that defines what "this row has pending edits" looks like, so every
 *  settings card-list tab (Fields, Vocab, Artefact File, Providers) renders
 *  the same affordance next to its title instead of each inventing its own. */
export function UnsavedBadge({ dirty }: { dirty: boolean }) {
  if (!dirty) return null;
  return <Badge variant="secondary" className="font-semibold text-amber-600 dark:text-amber-400">Unsaved</Badge>;
}
