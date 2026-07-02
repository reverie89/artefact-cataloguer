// Themed confirmation overlay shared by every destructive delete. Built on the
// shadcn Dialog (Radix), which handles focus trapping, scroll locking,
// Esc, and backdrop dismiss for free — one consistent modal vocabulary across
// the app. Uses Dialog (not AlertDialog) because the original contract allowed
// backdrop-click dismissal of the confirm; AlertDialog forces an explicit
// choice by blocking the overlay, which would change behavior.
//
// This file holds only the presentational component; the Promise-returning
// `useConfirmDelete` hook lives in `useConfirmDelete.tsx` (kept separate so this
// file only exports components, for fast refresh).

import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmDeleteOptions {
  title: string;
  message: string;
  confirmLabel?: string;
}

export interface ConfirmDialogProps extends ConfirmDeleteOptions {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Presentational overlay. Pure: callers decide what Cancel/Confirm do.
 *  Controlled via `open` so the useConfirmDelete hook can mount/unmount the
 *  dialog deterministically. Backdrop + Esc dismiss route through onCancel. */
export function ConfirmDialog({ title, message, confirmLabel = "Delete", open, onCancel, onConfirm }: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="max-w-[380px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="text-destructive size-4 shrink-0" />
            <span>{title}</span>
          </DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
