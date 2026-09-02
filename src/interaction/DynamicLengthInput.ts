import type { Vec2 } from '../math/geometry';

/** The length/angle boxes' current text, empty when the user has not typed
 *  an override and the live cursor position should drive that quantity
 *  instead. Angle is in degrees, matching how the rest of the app already
 *  shows angles (ROTATE's own preview label, DIMANGULAR, …). */
export interface DynamicLengthFields {
  length: string;
  angle: string;
}

function parsedMagnitude(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? Math.abs(value) : null;
}

function parsedAngleDegrees(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Where a line's (or one polyline segment's) free end should currently
 * land: the live cursor's distance and direction from `start`, with either
 * one swapped out for a typed override. A typed length is always a
 * magnitude, the same way a typed rectangle dimension is — the mouse still
 * decides which way things point unless the angle is *also* overridden.
 */
export function dynamicLengthPoint(start: Vec2, cursor: Vec2, fields: DynamicLengthFields): Vec2 {
  const dx = cursor.x - start.x;
  const dy = cursor.y - start.y;
  const liveDistance = Math.hypot(dx, dy);
  const liveAngle = Math.atan2(dy, dx);
  const typedLength = parsedMagnitude(fields.length);
  const typedAngleDeg = parsedAngleDegrees(fields.angle);
  const distance = typedLength ?? liveDistance;
  const angle = typedAngleDeg === null ? liveAngle : (typedAngleDeg * Math.PI) / 180;
  return { x: start.x + Math.cos(angle) * distance, y: start.y + Math.sin(angle) * distance };
}

/** Where the length and angle boxes sit: length at the segment's own
 *  midpoint, angle at the fixed start point it's measured from. */
export function dynamicLengthBoxPoints(start: Vec2, point: Vec2): { length: Vec2; angle: Vec2 } {
  return {
    length: { x: (start.x + point.x) / 2, y: (start.y + point.y) / 2 },
    angle: { ...start },
  };
}
