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
 * The opposite corner RECTANGLE should currently use, blending the live
 * cursor position with whichever axis has a typed override. A typed value is
 * always a magnitude: it cannot flip the rectangle to the other side of the
 * start point, since the mouse — not the keyboard — is what sets which side
 * it's being drawn on.
 */
export function dynamicRectangleCorner(start: Vec2, cursor: Vec2, fields: DynamicRectangleFields): Vec2 {
  const liveWidth = cursor.x - start.x;
  const liveHeight = cursor.y - start.y;
  const typedWidth = parsedMagnitude(fields.width);
  const typedHeight = parsedMagnitude(fields.height);
  const width = typedWidth === null ? liveWidth : Math.sign(liveWidth || 1) * typedWidth;
  const height = typedHeight === null ? liveHeight : Math.sign(liveHeight || 1) * typedHeight;
  return { x: start.x + width, y: start.y + height };
}

/** Where the width and height boxes sit: the midpoints of the two sides that
 *  actually measure them, both meeting at the fixed first corner. */
export function dynamicRectangleBoxPoints(start: Vec2, corner: Vec2): { width: Vec2; height: Vec2 } {
  return {
    width: { x: (start.x + corner.x) / 2, y: start.y },
    height: { x: corner.x, y: (start.y + corner.y) / 2 },
  };
}
