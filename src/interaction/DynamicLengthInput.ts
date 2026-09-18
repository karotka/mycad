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

/**
 * Which quantity a circle's box is showing. Both commands answer with a
 * distance from the centre, and each means a different thing by it: CIRCLE
 * takes a point on the circumference, so the distance is the radius;
 * CIRCLE_DIAMETER takes a point a diameter away, so the distance is the
 * diameter. The number in the box is that distance either way — the R or D
 * in front of it is what says which, which is the whole reason to label it.
 */
export type RadialQuantity = 'radius' | 'diameter';
