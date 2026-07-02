import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind classes with conflict resolution. The single class-join
 *  helper every shadcn primitive and app component uses — no hand-written
 *  `className` concatenation elsewhere. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
