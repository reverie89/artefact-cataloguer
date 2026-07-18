// Full-screen image lightbox launched from the ResultRow thumbnail. The overlay
// is the shadcn Dialog (Radix) — the established overlay vocabulary (focus-trap,
// scroll-lock, Esc, backdrop dismiss, per DESIGN_SYSTEM.md §5). Interactive
// zoom/pan is provided by a from-scratch `useImageZoom` hook (ported from the
// linkii reference) that owns `{scale, tx, ty}` as plain React state — the
// source of truth that makes the % readout correct, the image always centered
// (CSS flexbox + transform-origin: center), and zoom smooth (a transition on
// the transform). No zoom library is used; owning the transform state directly
// is simpler and reliable (KISS).
//
// The dialog box keeps shadcn's default centering (so it sits in the middle of
// the app window, not pinned to a corner) and is sized relative to the window
// (90vw × 90vh). The surround is `bg-background` so it adapts to the active
// theme (no JS theme branching). The inline `transform` is the sanctioned
// runtime-computed exception (AGENTS.md inline-styles #1, the dnd-kit precedent).

import { RotateCcw, X as XIcon, ZoomIn, ZoomOut } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { useImageZoom } from "@/hooks/useImageZoom";
import { cn } from "@/lib/utils";

export interface ImageLightboxProps {
  src: string;
  alt: string;
  open: boolean;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, open, onClose }: ImageLightboxProps) {
  // `enabled` detaches the non-passive wheel listener while closed. `resetKey`
  // makes each open start at 1×/center — passed only when open so a reopen of
  // the same src still resets. Destructured so state values are standalone
  // bindings (not properties of the ref-bearing result), matching how dnd-kit's
  // useSortable is consumed elsewhere in the app.
  const {
    containerRef,
    imgRef,
    onMouseDown,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    reset,
    zoomIn,
    zoomOut,
    max,
    scale,
    tx,
    ty,
    isDragging,
  } = useImageZoom({ enabled: open, resetKey: open ? src : null });

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      {/* Keep the standard shadcn centering (the box is centered in the app
          window, not pinned top-left) and size it relative to the window.
          A full-bleed overlay was the previous bug — it sat at the corner. */}
      <DialogContent
        showCloseButton={false}
        className="max-w-none h-[90vh] w-[90vw] p-0 gap-0 overflow-hidden"
      >
        <DialogTitle className="sr-only">Image preview</DialogTitle>

        <DialogPrimitive.Close
          data-slot="dialog-close"
          asChild
          className="absolute top-4 right-4 z-20"
        >
          <Button variant="secondary" size="icon-sm" aria-label="Close preview">
            <XIcon />
          </Button>
        </DialogPrimitive.Close>

        {/* The zoom viewport. Holds the non-passive wheel listener (so scroll
            anywhere over the box zooms) and flex-centers the image. The inline
            transform offsets the image for pan/zoom; overflow-hidden keeps a
            panned image inside the box. */}
        <div
          ref={containerRef}
          className="absolute inset-0 flex items-center justify-center overflow-hidden"
        >
          <img
            ref={imgRef}
            src={src}
            alt={alt}
            draggable={false}
            onMouseDown={onMouseDown}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            onDoubleClick={reset}
            style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
            className={cn(
              "max-h-full max-w-full select-none object-contain origin-center",
              "transition-transform duration-75 ease-out",
              isDragging && "transition-none",
              scale > 1
                ? isDragging ? "cursor-grabbing" : "cursor-grab"
                : "cursor-default",
            )}
          />
        </div>

        <LightboxToolbar scale={scale} max={max} zoomIn={zoomIn} zoomOut={zoomOut} reset={reset} />
      </DialogContent>
    </Dialog>
  );
}

interface LightboxToolbarProps {
  scale: number;
  max: number;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}

/** Control cluster pinned bottom-center. Solid `bg-popover` (the canonical
 *  floating-control surface token) with a border + shadow so it reads as a
 *  distinct floating pill regardless of image content behind it. The live scale
 *  is passed in as a primitive — the reactive state source of truth. */
function LightboxToolbar({ scale, max, zoomIn, zoomOut, reset }: LightboxToolbarProps) {
  const pct = Math.round(scale * 100);

  return (
    <div className="bg-popover text-popover-foreground absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-full border px-1.5 py-1 shadow-lg">
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={(e) => { e.stopPropagation(); zoomOut(); }}
        disabled={scale <= 1}
        aria-label="Zoom out"
      >
        <ZoomOut />
      </Button>
      <span className="text-muted-foreground min-w-12 text-center text-xs tabular-nums">{pct}%</span>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={(e) => { e.stopPropagation(); zoomIn(); }}
        disabled={scale >= max}
        aria-label="Zoom in"
      >
        <ZoomIn />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={(e) => { e.stopPropagation(); reset(); }}
        disabled={scale === 1}
        aria-label="Reset zoom"
      >
        <RotateCcw />
      </Button>
    </div>
  );
}
