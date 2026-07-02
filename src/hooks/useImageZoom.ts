import { useCallback, useEffect, useRef, useState } from "react";

/**
 * From-scratch zoom/pan engine for the image lightbox. Owns `{scale, tx, ty}`
 * as plain React state so the % readout is always correct (the source of truth),
 * the image is always centered (CSS flexbox + transform-origin: center), and
 * zoom is smooth (a transition on the transform). Ported from linkii — no zoom
 * library is used because owning the transform state directly is both simpler
 * and reliable (KISS).
 */

/** Lower bound is fixed at 1 — zooming out below the natural fit is meaningless. */
const MIN_SCALE = 1;
const DEFAULT_MAX_SCALE = 10;
/** Multiplier per wheel notch / button press. */
const STEP_FACTOR = 1.2;

interface UseImageZoomOptions {
  /** Maximum zoom. Defaults to 10 (1000%). */
  max?: number;
  /**
   * Whether the <img> is currently mounted/interactive. The non-passive wheel
   * listener is (re)attached only while enabled, because the image mounts
   * asynchronously (after the src loads) — the effect must re-run when the
   * image becomes available.
   */
  enabled?: boolean;
  /**
   * Identity of the viewed image. Whenever this value changes, zoom + pan reset
   * to 1x/center so a newly-loaded image opens at the natural fit. Pass the
   * image src/path — anything that changes per image.
   */
  resetKey?: unknown;
}

interface UseImageZoomResult {
  /** Maximum zoom factor (upper clamp on `scale`). */
  max: number;
  /** Current zoom factor. 1 = fit-to-container. */
  scale: number;
  /** Horizontal pan offset in px (relative to centered origin). */
  tx: number;
  /** Vertical pan offset in px (relative to centered origin). */
  ty: number;
  /** True while a mouse drag-pan is in progress (drives the cursor + transition). */
  isDragging: boolean;
  /** Attach to the zoom container (the lightbox viewport). Holds the non-passive
   *  wheel listener — binding here (not to the <img>) means scrolling anywhere
   *  over the viewport zooms, and avoids an image-mount timing dependency. */
  containerRef: (node: HTMLDivElement | null) => void | (() => void);
  /** Attach to the <img>. Used for layout-box math in zoom-to-cursor. */
  imgRef: React.RefObject<HTMLImageElement | null>;
  /** Spread onto the <img>: begins a drag-pan (only when zoomed in). */
  onMouseDown: (e: React.MouseEvent<HTMLImageElement>) => void;
  /** Spread onto the <img>: pinch-to-zoom + single-touch pan. */
  onTouchStart: (e: React.TouchEvent<HTMLImageElement>) => void;
  onTouchMove: (e: React.TouchEvent<HTMLImageElement>) => void;
  onTouchEnd: (e: React.TouchEvent<HTMLImageElement>) => void;
  /** Zoom in one step toward the image center. */
  zoomIn: () => void;
  /** Zoom out one step toward the image center. */
  zoomOut: () => void;
  /** Return to 1x, re-centering the image. */
  reset: () => void;
}

export function useImageZoom(options: UseImageZoomOptions = {}): UseImageZoomResult {
  const { max = DEFAULT_MAX_SCALE, enabled = true, resetKey } = options;
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const imgRef = useRef<HTMLImageElement>(null);

  // Reset to 1x/center whenever the viewed image changes, so a new image always
  // opens at the natural fit rather than inheriting the previous zoom. Done
  // during render (the "adjust state when a prop changes" pattern from the
  // React docs) rather than in an effect — React re-renders before committing,
  // so there's no flash of the previous zoom and no extra paint.
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey);
    setScale(MIN_SCALE);
    setTx(0);
    setTy(0);
  }

  // The wheel handler reads the current scale and zoom target via refs so the
  // (non-passive) listener stays stable — it's attached once when the viewport
  // mounts and not re-bound on every scale change. This also lets the wheel
  // listener be wired through a ref callback (below), which fires at commit
  // time and so has no ref-timing race with the Radix portal mounting.
  const scaleRef = useRef(scale);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  // Drag-pan bookkeeping. Refs (not state) so move handlers read the latest
  // values without re-binding on every pixel.
  const dragState = useRef<{
    startCursorX: number;
    startCursorY: number;
    startTx: number;
    startTy: number;
  } | null>(null);

  // Pinch bookkeeping for two-finger touch.
  const pinchState = useRef<{
    startDistance: number;
    startScale: number;
    midX: number;
    midY: number;
  } | null>(null);
  // Single-touch pan bookkeeping.
  const touchPanState = useRef<{
    startTouchX: number;
    startTouchY: number;
    startTx: number;
    startTy: number;
  } | null>(null);

  const clampScale = useCallback(
    (next: number) => Math.min(Math.max(next, MIN_SCALE), max),
    [max],
  );

  /**
   * Zoom toward a focal point expressed in **screen** coordinates (clientX /
   * clientY). Adjusts the pan offset so the point under the cursor stays fixed
   * through the prevScale → nextScale change. Everything is derived from
   * `getBoundingClientRect()` (rendered box) so the focal point and the center
   * are in the same screen coordinate space — mixing rendered px with the
   * image's natural px would drift on every scroll once scale > 1.
   *
   * With `transform-origin: center` + `translate(tx,ty) scale(s)`, the drift-
   * free update is:
   *   nextTx = prevTx + (1 - nextScale/prevScale) · (focalX - prevCenterX)
   * where prevCenter is the rendered box center.
   */
  const zoomTo = useCallback(
    (nextScaleRaw: number, focalScreenX: number, focalScreenY: number) => {
      const img = imgRef.current;
      if (!img) return;

      const nextScale = clampScale(nextScaleRaw);
      // Read the rendered box once; it reflects the current (prevScale) state.
      const rect = img.getBoundingClientRect();
      const prevCx = rect.left + rect.width / 2;
      const prevCy = rect.top + rect.height / 2;

      setScale((prevScale) => {
        if (nextScale === prevScale) return prevScale;

        const k = 1 - nextScale / prevScale;
        setTx((prevTx) => prevTx + k * (focalScreenX - prevCx));
        setTy((prevTy) => prevTy + k * (focalScreenY - prevCy));

        // Snapping back to 1x re-centers the image — a leftover pan offset
        // would leave it off-center at the natural fit.
        if (nextScale === MIN_SCALE) {
          setTx(0);
          setTy(0);
        }
        return nextScale;
      });
    },
    [clampScale],
  );

  // Keep the latest `zoomTo` in a ref so the wheel handler (below) can call it
  // without being rebinding on every change — the handler stays stable.
  const zoomToRef = useRef(zoomTo);
  useEffect(() => {
    zoomToRef.current = zoomTo;
  }, [zoomTo]);

  // The viewport ref is a *callback* ref: it wires the non-passive wheel
  // listener when the node mounts and unwires it on unmount. Doing this in a
  // ref callback (vs. a useEffect reading a plain ref) removes the ref-timing
  // race where the Radix portal's children aren't in the DOM yet when the
  // effect first runs — the callback fires at commit time on the real node.
  // The handler reads scale + zoom target via refs so it never needs rebinding.
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node || !enabled) return;

    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      // focal point is in screen coords — zoomTo derives the rendered center
      // from the same space, so the point under the cursor stays pinned.
      const factor = Math.pow(STEP_FACTOR, -e.deltaY / 100);
      zoomToRef.current(scaleRef.current * factor, e.clientX, e.clientY);
    }

    node.addEventListener("wheel", handleWheel, { passive: false });
    return () => node.removeEventListener("wheel", handleWheel);
  }, [enabled]);

  const zoomIn = useCallback(() => {
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomTo(scale * STEP_FACTOR, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, [scale, zoomTo]);

  const zoomOut = useCallback(() => {
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomTo(scale / STEP_FACTOR, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, [scale, zoomTo]);

  const reset = useCallback(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, []);

  // ---- Mouse drag-pan (document-level move/up so the cursor can leave img) ----
  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      if (scale <= MIN_SCALE) return;
      e.preventDefault();
      dragState.current = {
        startCursorX: e.clientX,
        startCursorY: e.clientY,
        startTx: tx,
        startTy: ty,
      };
      setIsDragging(true);
    },
    [scale, tx, ty],
  );

  useEffect(() => {
    if (!isDragging) return;

    function handleMove(e: MouseEvent) {
      const ds = dragState.current;
      if (!ds) return;
      setTx(ds.startTx + (e.clientX - ds.startCursorX));
      setTy(ds.startTy + (e.clientY - ds.startCursorY));
    }
    function handleUp() {
      dragState.current = null;
      setIsDragging(false);
    }

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    return () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
  }, [isDragging]);

  // ---- Touch: pinch-to-zoom + single-touch pan ----
  const onTouchStart = useCallback(
    (e: React.TouchEvent<HTMLImageElement>) => {
      if (e.touches.length === 2) {
        // Begin pinch. Use the two current touches.
        const [a, b] = [e.touches[0], e.touches[1]];
        pinchState.current = {
          startDistance: touchDistance(a, b),
          startScale: scale,
          midX: (a.clientX + b.clientX) / 2,
          midY: (a.clientY + b.clientY) / 2,
        };
        touchPanState.current = null;
      } else if (e.touches.length === 1 && scale > MIN_SCALE) {
        const t = e.touches[0];
        touchPanState.current = {
          startTouchX: t.clientX,
          startTouchY: t.clientY,
          startTx: tx,
          startTy: ty,
        };
      }
    },
    [scale, tx, ty],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent<HTMLImageElement>) => {
      if (e.touches.length === 2 && pinchState.current) {
        e.preventDefault();
        const [a, b] = [e.touches[0], e.touches[1]];
        const distance = touchDistance(a, b);
        const ratio = distance / pinchState.current.startDistance;
        const rect = imgRef.current?.getBoundingClientRect();
        const midX = (a.clientX + b.clientX) / 2;
        const midY = (a.clientY + b.clientY) / 2;
        const focalX = rect ? midX - rect.left : 0;
        const focalY = rect ? midY - rect.top : 0;
        zoomTo(pinchState.current.startScale * ratio, focalX, focalY);
      } else if (e.touches.length === 1 && touchPanState.current) {
        const t = e.touches[0];
        const ps = touchPanState.current;
        setTx(ps.startTx + (t.clientX - ps.startTouchX));
        setTy(ps.startTy + (t.clientY - ps.startTouchY));
      }
    },
    [zoomTo],
  );

  const onTouchEnd = useCallback((e: React.TouchEvent<HTMLImageElement>) => {
    if (e.touches.length === 0) {
      pinchState.current = null;
      touchPanState.current = null;
    }
  }, []);

  return {
    max,
    scale,
    tx,
    ty,
    isDragging,
    containerRef,
    imgRef,
    onMouseDown,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    zoomIn,
    zoomOut,
    reset,
  };
}

function touchDistance(a: Touch | React.Touch, b: Touch | React.Touch): number {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}
