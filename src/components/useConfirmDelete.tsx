// Promise-returning hook backing the shared ConfirmDialog overlay. Kept in its
// own file (not in ConfirmDialog.tsx) so the component file only exports
// components, per the react-refresh/only-export-components lint rule.
//
// One overlay instance per app: the first pending request holds the resolver; a
// second confirmDelete() while one is open resolves false and is dropped, so a
// stale resolver can never fire.

import { useCallback, useRef, useState } from "react";

import { ConfirmDialog, type ConfirmDeleteOptions } from "./ConfirmDialog";

interface PendingRequest extends ConfirmDeleteOptions {
  resolve: (ok: boolean) => void;
}

export interface ConfirmDeleteApi {
  /** Resolve true on confirm, false on cancel/Esc/backdrop. */
  confirmDelete: (opts: ConfirmDeleteOptions) => Promise<boolean>;
  /** Render once at the app root. Renders the (controlled) dialog. */
  dialog: React.ReactNode;
}

export function useConfirmDelete(): ConfirmDeleteApi {
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const close = useCallback((ok: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPending(null);
    resolve?.(ok);
  }, []);

  const confirmDelete = useCallback((opts: ConfirmDeleteOptions) => {
    if (resolverRef.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setPending({ ...opts, resolve });
    });
  }, []);

  const dialog = (
    <ConfirmDialog
      open={!!pending}
      title={pending?.title ?? ""}
      message={pending?.message ?? ""}
      confirmLabel={pending?.confirmLabel}
      onCancel={() => close(false)}
      onConfirm={() => close(true)}
    />
  );

  return { confirmDelete, dialog };
}
