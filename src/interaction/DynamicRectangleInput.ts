import type { Vec2 } from '../math/geometry';

/** The width/height boxes' current text, empty when the user has not typed an
 *  override and the live cursor position should drive that axis instead. */
export interface DynamicRectangleFields {
  width: string;
  height: string;
}

function parsedMagnitude(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? Math.abs(value) : null;
}

/**
 * Where a single axis should currently land, blending the live cursor
 * position with a typed override. A typed value is always a magnitude: it
 * cannot flip the result to the other side of `fixed`, since the mouse — not
 * the keyboard — is what sets which side is being dragged toward. Shared by
 * `dynamicRectangleCorner` (both axes at once, for a corner grip or
 * RECTANGLE's own second point) and a rectangle's single-axis mid-edge grip,
 * which only ever moves one of the two.
 */
export function dynamicRectangleAxisCoordinate(fixed: number, cursor: number, text: string): number {
  const live = cursor - fixed;
  const typed = parsedMagnitude(text);
  const delta = typed === null ? live : Math.sign(live || 1) * typed;
  return fixed + delta;
}

/**
 * The opposite corner RECTANGLE should currently use, blending the live
 * cursor position with whichever axis has a typed override.
 */
export function dynamicRectangleCorner(start: Vec2, cursor: Vec2, fields: DynamicRectangleFields): Vec2 {
  return {
    x: dynamicRectangleAxisCoordinate(start.x, cursor.x, fields.width),
    y: dynamicRectangleAxisCoordinate(start.y, cursor.y, fields.height),
  };
}

/** Where the width and height boxes sit: the midpoints of the two sides that
 *  actually measure them, both meeting at the fixed first corner. */
export function dynamicRectangleBoxPoints(start: Vec2, corner: Vec2): { width: Vec2; height: Vec2 } {
  return {
    width: { x: (start.x + corner.x) / 2, y: start.y },
    height: { x: corner.x, y: (start.y + corner.y) / 2 },
  };
}
