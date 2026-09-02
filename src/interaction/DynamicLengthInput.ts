import type { Vec2 } from '../math/geometry';

/**
 * Where a line's (or one polyline segment's) free end should currently land:
 * the live cursor's direction from `start`, at either the live distance or a
 * typed override length. Typing only ever fixes the distance — the mouse
 * still controls which way the segment points, the same way a typed
 * rectangle dimension still lets the mouse choose which side of the fixed
 * corner it's on.
 */
export function dynamicLengthPoint(start: Vec2, cursor: Vec2, text: string): Vec2 {
  const dx = cursor.x - start.x;
  const dy = cursor.y - start.y;
  const liveDistance = Math.hypot(dx, dy);
  const trimmed = text.trim();
  const typed = trimmed === '' ? NaN : Number(trimmed);
  const overridden = Number.isFinite(typed);
  const distance = overridden ? Math.abs(typed) : liveDistance;
  if (liveDistance < 1e-9) {
    // No direction to go on yet (the cursor hasn't moved off the start
    // point) — an override still needs somewhere to point, so pick +x
    // arbitrarily; with no override there is nothing sensible to return but
    // the start itself.
    return overridden ? { x: start.x + distance, y: start.y } : { ...cursor };
  }
  return { x: start.x + (dx / liveDistance) * distance, y: start.y + (dy / liveDistance) * distance };
}
