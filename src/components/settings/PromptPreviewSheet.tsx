// Right-side slide-out sheet previewing the exact prompt message sent for each
// parsing job, including all hardcoded framing. Triggered from FieldsTab.
//
// Built on the shadcn Sheet (Radix), which handles focus trapping, scroll
// locking, Esc, and backdrop dismiss. The text is assembled by the same Rust
// `build_combined_prompt` the live catalogue call uses, so it can never drift.
// Upstream (FieldsTab) passes a settings object already merged with the
// in-progress draft, so the preview reflects unsaved edits.

import { useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { Settings } from "../../app/types";
import { buildPromptsPreview } from "../../lib/ai";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Effective settings — FieldsTab merges its draft in before passing, so the
   *  preview reflects the configuration exactly as it would be saved. */
  settings: Settings;
}

export function PromptPreviewSheet({ open, onClose, settings }: Props) {
  const [prompt, setPrompt] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Reassemble whenever the merged settings change (e.g. while editing fields in
  // the background). Loading flips inside the async chain, not synchronously in
  // the effect body, to avoid a cascading render.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const pending = buildPromptsPreview(settings.fields, settings)
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
  }, [open, settings]);

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent className="w-full sm:max-w-[560px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Prompt Preview</SheetTitle>
          <SheetDescription>
            The exact message sent to your AI provider for each parsing job, including all hardcoded
            framing. The artefact row&apos;s source columns are produced at parse time, so the record
            is shown as an empty placeholder; the extracted image is attached as a separate content
            block and is not represented here. Reflects your current (possibly unsaved) edits.
          </SheetDescription>
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
