/**
 * Where a dragged layer lands.
 *
 * Separate from the dragging because the order is what the G-code export walks:
 * getting it wrong means cutting the passes in the wrong sequence, which is a
 * thing you find out at the machine. Dropping a layer is fiddly to drive from a
 * test; deciding the new order is not.
 */

/**
 * `before` is the layer the dragged one is dropped in front of, or null to drop
 * it at the end. Returns the layers unchanged if the move asks for nothing —
 * dropping a layer on itself, or in front of the one it already precedes.
 */
export function reorderLayers(layers: readonly string[], moved: string, before: string | null): string[] {
  const from = layers.indexOf(moved);
  if (from === -1 || moved === before) return [...layers];

  const rest = layers.filter((layer) => layer !== moved);
  if (before === null) return [...rest, moved];

  const target = rest.indexOf(before);
  // A layer that is not there cannot be dropped in front of, and guessing where
  // it meant would silently move the layer somewhere nobody asked for.
  if (target === -1) return [...layers];
  return [...rest.slice(0, target), moved, ...rest.slice(target)];
}

/**
 * Which layer a pointer at `y` is dropping in front of, given each row's box —
 * null means past the last one. The midpoint decides, so the drop lands on the
 * side of the row the cursor is nearer to rather than always in front of it.
 */
export function dropTarget(rows: Array<{ name: string; top: number; bottom: number }>, y: number): string | null {
  for (const row of rows) {
    if (y < (row.top + row.bottom) / 2) return row.name;
  }
  return null;
}
