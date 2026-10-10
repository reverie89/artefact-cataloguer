import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind classes with conflict resolution. The single class-join
 *  helper every shadcn primitive and app component uses — no hand-written
 *  `className` concatenation elsewhere. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** `1.2s`-style duration for elapsed-time displays (`undefined` → an em dash). */
export function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
