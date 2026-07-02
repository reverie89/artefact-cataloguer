import { Loader2, Check, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SaveState } from "./SaveActions.types";

interface SettingsSaveActionsProps {
  status: SaveState;
  onSave: () => void;
  disabled?: boolean;
  savingLabel?: string;
  /** When true, the Save button is hidden from view (invisible) but kept in the
   *  layout to avoid pop-in. SaveStatus stays visible either way, so a "Saved"
   *  confirmation can outlive the dirty→clean transition. Mirrors the
   *  dirty-gated Discard button. */
  hidden?: boolean;
  /** Skip rendering the inline SaveStatus (e.g. when the consumer places the
   *  status elsewhere in the row). */
  hideStatus?: boolean;
}

export function SettingsSaveActions({ status, onSave, disabled = false, savingLabel = "Saving...", hidden = false, hideStatus = false }: SettingsSaveActionsProps) {
  const saving = status === "saving";
  return (
    <>
      {!hideStatus && <SaveStatus status={status} />}
      <Button
        onClick={onSave}
        disabled={hidden || disabled || saving}
        className={cn("min-w-28", hidden && "invisible")}
        aria-hidden={hidden}
        tabIndex={hidden ? -1 : 0}
        size="sm"
      >
        {saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
        <span>{saving ? savingLabel : "Save"}</span>
      </Button>
    </>
  );
}

/** Normalized status kind shared by every status indicator. Domains map their
 *  own state into this (e.g. save's "saving" and connection's "testing" both
 *  collapse to "busy"); the message wording stays domain-specific. */
export type StatusKind = "busy" | "ok" | "err" | null;

/**
 * Presentational status indicator: an inline label whose icon and color resolve
 * from a normalized state. Owns the one shared piece that SaveStatus and
 * ConnectionStatus map into (the icon dispatch + status→color mapping). Each
 * domain keeps its own state enum and message text.
 */
export function StatusIndicator({ state, message, className }: { state: StatusKind; message: string; className?: string }) {
  return (
    <div
      className={cn(
        "inline-flex h-9 items-center gap-2 text-sm",
        state === "ok" && "text-emerald-600 dark:text-emerald-400",
        state === "err" && "text-destructive",
        state === "busy" && "text-amber-600 dark:text-amber-400",
        !state && "text-muted-foreground invisible",
        className
      )}
      aria-hidden={!state}
    >
      {state === "busy" && <Loader2 className="size-3 animate-spin" />}
      {state === "ok" && <Check className="size-3" />}
      {state === "err" && <X className="size-3" />}
      <span>{message}</span>
    </div>
  );
}

export function SaveStatus({ status, className, errorMessage }: { status: SaveState; className?: string; errorMessage?: string }) {
  const message = status === "saving" ? "Saving..." : status === "ok" ? "Saved" : status === "err" ? (errorMessage || "Not saved") : "No status";
  return <StatusIndicator state={status === "saving" ? "busy" : status} message={message} className={className} />;
}
