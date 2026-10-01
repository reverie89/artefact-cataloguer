import { useEffect, useRef } from "react";

/** Scroll a newly-added list row into view. Callers register each row's DOM
 *  node in `refs` (keyed by row id); the hook fires ONLY when `count` grows
 *  (an Add appends, so the new row is the last) — never on content edits,
 *  deletes, or reorders, which also change the list backing `count`. */
export function useScrollNewRowIntoView(
  count: number,
  refs: { current: Record<string, HTMLElement | null> },
  lastId: string | undefined,
) {
  const prevCountRef = useRef(count);
  useEffect(() => {
    const grew = count > prevCountRef.current;
    prevCountRef.current = count;
    if (!grew) return;
    // block:"nearest" avoids jumping when the row is already partly visible;
    // a small timeout lets the expanded row body measure before scrolling.
    const node = lastId ? refs.current[lastId] : null;
    const t = setTimeout(() => node?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 30);
    return () => clearTimeout(t);
  }, [count, refs, lastId]);
}
