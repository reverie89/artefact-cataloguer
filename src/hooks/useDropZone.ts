// A tiny reuse hook for the drag-and-drop file zones. The Upload panel and the
// Vocab tab each need the same trio (preventDefault on dragOver, clear the
// highlight on dragLeave, hand dropped files off on drop); this keeps that
// pattern in one place.

import { useCallback } from "react";

/**
 * Returns drag event handlers for a file-drop zone.
 *
 * @param setDragging toggles the zone's highlight state on drag enter/leave.
 * @param onFiles receives the dropped `FileList` (only when non-empty).
 */
export function useDropZone(
  setDragging: (dragging: boolean) => void,
  onFiles: (files: FileList) => void,
): {
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
} {
  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    [setDragging],
  );
  const onDragLeave = useCallback(() => setDragging(false), [setDragging]);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files) onFiles(e.dataTransfer.files);
    },
    [setDragging, onFiles],
  );
  return { onDragOver, onDragLeave, onDrop };
}
