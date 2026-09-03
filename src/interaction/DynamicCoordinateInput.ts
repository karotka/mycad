import type { Vec2 } from '../math/geometry';

/** The X/Y boxes' current text, empty when the user has not typed an
 *  override and the live cursor position should drive that axis instead. */
export interface DynamicCoordinateFields {
  x: string;
  y: string;
}

function parsedCoordinate(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * The point a dragged reference point — a circle's own centre grip, say —
 * should currently land on: the live cursor on any axis with no typed
 * override, the typed absolute coordinate on one that has it. Unlike
 * RECTANGLE's or LINE's boxes, these are plain absolute coordinates, not a
 * magnitude measured from some fixed point — moving an object by its centre
 * has no fixed point to measure from, so there's no sign to preserve either.
 */
export function dynamicCoordinatePoint(cursor: Vec2, fields: DynamicCoordinateFields): Vec2 {
  return {
    x: parsedCoordinate(fields.x) ?? cursor.x,
    y: parsedCoordinate(fields.y) ?? cursor.y,
  };
}
