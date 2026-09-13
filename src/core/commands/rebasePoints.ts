import type { Vec2 } from '../../math/geometry';
import { localToWorld, worldToLocal, type WorkPlane } from '../../math/workplane';

/**
 * Moving a half-drawn shape from one work plane to another without moving it
 * in space.
 *
 * A drawing command stores its points in the plane it is being drawn in, so
 * changing that plane under it silently re-reads every point already placed as
 * if it had been given in the new frame — the shape jumps somewhere else
 * entirely. Dynamic UCS does exactly that whenever it adopts a face after the
 * first point has landed, which is the ordinary way of starting at a corner
 * and then pointing at the face the shape belongs on.
 *
 * So the points are re-expressed instead, and only when they can be: every
 * one of them has to still lie in the new plane afterwards. Anything else is
 * not the same shape on a better-described plane, it is a different shape, and
 * the caller is told to leave the plane alone.
 */

/**
 * Keys holding world coordinates rather than points in the command's own
 * plane. The convention this codebase follows is to say so in the name —
 * `startWorld`, `worldPoints` — which is exactly why re-expressing them would
 * be wrong: they already mean the same thing in every plane.
 */
const WORLD_SPACE_KEYS = new Set([
  'drawingPlaneAnchor',
  'startWorld',
  'worldPoints',
  'pendingMoveWorldPoint',
]);

/** Anything shaped like a point, elevated or not. */
function isPointLike(value: unknown): value is Vec2 & { z?: number } {
  if (!value || typeof value !== 'object') return false;
  const point = value as Record<string, unknown>;
  return typeof point.x === 'number' && typeof point.y === 'number';
}

/**
 * A point carrying its own `z` sits at an elevation off the plane its command
 * is drawing in (the per-point convention a 3D curve uses). Those commands
 * never freeze a drawing plane in the first place, so re-basing one is a case
 * with no caller and no obviously right answer — met here, it refuses the
 * whole re-base rather than quietly leaving one stale point behind in the old
 * frame while every other point moves.
 */
function isElevated(value: Vec2 & { z?: number }): boolean {
  return value.z !== undefined;
}

/**
 * The already-placed points of `data`, expressed in `to` instead of `from`, or
 * null when at least one of them would not lie in `to` — i.e. when the two
 * planes describe genuinely different places and the shape must stay where it
 * was drawn.
 *
 * A command with nothing placed yet returns an empty object: there is nothing
 * to move, and the plane may change freely.
 *
 * `tolerance` is generous next to the 1e-9 this codebase uses for exact plane
 * arithmetic, because both the point and the plane here come from a
 * tessellated solid, whose vertex positions are 32-bit floats: a coordinate
 * that is not exactly representable puts a face's own corner slightly off it.
 * (Measured on the part this was found on, the corner sat exactly on its face
 * plane — 10.75 survives the round trip — which is precisely why the margin
 * cannot be read off one example.) Still orders of magnitude tighter than the
 * distance between any two real faces of a part.
 */
export function rebasedCommandPoints(
  data: Record<string, unknown>,
  from: WorkPlane,
  to: WorkPlane,
  tolerance = 1e-4,
): Record<string, Vec2 | Vec2[]> | null {
  const rebased: Record<string, Vec2 | Vec2[]> = {};
  const move = (point: Vec2): Vec2 | null => {
    const local = worldToLocal(to, localToWorld(from, point));
    return Math.abs(local.z) <= tolerance ? { x: local.x, y: local.y } : null;
  };
  for (const [key, value] of Object.entries(data)) {
    if (WORLD_SPACE_KEYS.has(key)) continue;
    if (isPointLike(value)) {
      if (isElevated(value)) return null;
      const moved = move(value);
      if (!moved) return null;
      rebased[key] = moved;
      continue;
    }
    if (!Array.isArray(value) || value.length === 0 || !value.every(isPointLike)) continue;
    if ((value as (Vec2 & { z?: number })[]).some(isElevated)) return null;
    const moved = (value as Vec2[]).map(move);
    if (moved.some((point) => point === null)) return null;
    rebased[key] = moved as Vec2[];
  }
  return rebased;
}
