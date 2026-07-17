// Right-side slide-out sheet previewing the exact prompt message sent for each
// parsing job, including all hardcoded framing. Shared by the Cataloguing
// Fields tab (Call 2 prompt) and the Artefact File tab (Call 1 vision prompt).
//
// Built on the shadcn Sheet (Radix), which handles focus trapping, scroll
// locking, Esc, and backdrop dismiss. The text is assembled by the same Rust
// `build_*` functions the live catalogue call uses, so it can never drift.
// Callers pass a `build` function that resolves the preview string against a
// settings object already merged with the in-progress draft, so the preview
// reflects unsaved edits.

import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Assembles the prompt text (typically a thin wrapper around a Rust
   *  `build_*_preview` invoke). Re-run whenever the merged settings change. */
  build: () => Promise<string>;
  /** Tab-specific descriptive copy under the title. */
  description?: ReactNode;
}

/** Default descriptive copy for the cataloguing (Call 2) preview. */
const DEFAULT_DESCRIPTION = (
  <>
    The exact message sent to your AI provider for each parsing job, including all hardcoded
    framing. The artefact row&apos;s source columns are produced at parse time, so the record
    is shown as an empty placeholder; the extracted image is attached as a separate content
    block and is not represented here. Reflects your current (possibly unsaved) edits.
  </>
);

export function PromptPreviewSheet({ open, onClose, build, description = DEFAULT_DESCRIPTION }: Props) {
  const [prompt, setPrompt] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Reassemble whenever `build` changes (e.g. while editing fields in the
  // background). Loading flips inside the async chain, not synchronously in
  // the effect body, to avoid a cascading render.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const pending = build()
      .then((text) => {
        if (!cancelled) {
          setPrompt(text);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      void pending;
    };
  }, [open, build]);

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent className="w-full sm:max-w-[560px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Prompt Preview</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>

        {error && (
          <Alert variant="destructive" className="mt-4">
            <AlertCircle className="size-4" />
            <AlertTitle>Couldn&apos;t build the prompt preview</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <textarea
          readOnly
          value={loading ? "Building prompt preview…" : prompt}
          spellCheck={false}
          className="bg-background text-foreground mt-4 min-h-[300px] flex-1 rounded-md border p-3 font-sans text-[13px] leading-relaxed resize-none focus:outline-none"
        />
      </SheetContent>
    </Sheet>
  );
}
