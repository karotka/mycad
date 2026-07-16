import type { DraftingSettings } from '../core/settings';
import type { Vec2 } from '../math/geometry';

export interface DraftingConstraint {
  point: Vec2;
  angle: number;
  tracked: boolean;
}

/** The dotted line to draw, from where it is anchored to where the point sits. */
export interface AlignmentGuide {
  start: Vec2;
  end: Vec2;
  angle: number;
}

export interface ResolvedPoint {
  point: Vec2;
  guide: AlignmentGuide | null;
}

export interface PointRequest {
  cursor: Vec2;
  /** Ortho and polar measure direction from here: the last point, or the grip's origin. */
  base: Vec2 | null;
  /** A point acquired by hovering it, whose alignment path the cursor can catch (F11). */
  anchor: Vec2 | null;
  /** An exact object snap under the cursor, if any. */
  snap: Vec2 | null;
  settings: DraftingSettings;
  /** How near the cursor must come to an alignment path to be captured, in world units. */
  captureDistance: number;
}

/**
 * Decides where a point lands.
 *
 * 1. An object snap is a request for one exact point and wins outright.
 * 2. Otherwise Ortho/Polar and an acquired point's alignment path both want to
 *    fix where the point goes, and they cannot both hold: a point on the
 *    anchor's path is generally not at 0/90/180/270 from the base, so honouring
 *    the path would mean the line is no longer orthogonal. Ortho wins that
 *    argument — being unbreakable is the whole point of it. The path then acts
 *    as a *target* rather than a constraint: the point runs along the Ortho ray
 *    and catches where the ray crosses the path, which is an extend.
 * 3. With no direction constraint there is nothing to protect, so the path
 *    itself becomes the constraint and the point slides along it (F11).
 */
export function resolveDraftingPoint(request: PointRequest): ResolvedPoint {
  const { cursor, base, anchor, snap, settings, captureDistance } = request;
  if (snap) return { point: snap, guide: null };

  if (settings.orthoEnabled || settings.polarEnabled) {
    const constrained = constrainDraftingPoint(cursor, base, settings);
    if (base && anchor && constrained.tracked) {
      const crossing = nearestCrossing(base, constrained.angle, anchor, constrained.point, captureDistance);
      if (crossing) {
        return {
          point: crossing,
          guide: { start: { ...anchor }, end: crossing, angle: directionDegrees(anchor, crossing) },
        };
      }
    }
    return {
      point: constrained.point,
      guide: constrained.tracked && base
        ? { start: base, end: constrained.point, angle: constrained.angle }
        : null,
    };
  }

  const path = anchor ? alignmentPath(cursor, anchor, captureDistance) : null;
  if (path) return { point: path.end, guide: path };
  return { point: cursor, guide: null };
}

/**
 * Where the constrained ray from `base` crosses the anchor's horizontal or
 * vertical, when that crossing is close enough to reach for. Null otherwise, so
 * the point keeps running freely along the ray.
 */
function nearestCrossing(
  base: Vec2,
  angle: number,
  anchor: Vec2,
  constrained: Vec2,
  captureDistance: number,
): Vec2 | null {
  const radians = angle * Math.PI / 180;
  const direction = { x: Math.cos(radians), y: Math.sin(radians) };
  const crossings: Vec2[] = [];
  if (Math.abs(direction.x) > 1e-9) crossings.push(pointOnRay(base, direction, (anchor.x - base.x) / direction.x));
  if (Math.abs(direction.y) > 1e-9) crossings.push(pointOnRay(base, direction, (anchor.y - base.y) / direction.y));
  let best: Vec2 | null = null;
  let bestDistance = captureDistance;
  for (const crossing of crossings) {
    const distance = Math.hypot(crossing.x - constrained.x, crossing.y - constrained.y);
    if (distance <= bestDistance) { bestDistance = distance; best = crossing; }
  }
  return best;
}

function pointOnRay(base: Vec2, direction: Vec2, t: number): Vec2 {
  return { x: base.x + direction.x * t, y: base.y + direction.y * t };
}

function directionDegrees(from: Vec2, to: Vec2): number {
  return normalizeDegrees(Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI);
}

/**
 * The horizontal or vertical path through an acquired point, whichever the
 * cursor is nearer — or null when it is near neither and should stay free.
 */
function alignmentPath(cursor: Vec2, anchor: Vec2, captureDistance: number): AlignmentGuide | null {
  const dx = cursor.x - anchor.x;
  const dy = cursor.y - anchor.y;
  const horizontal = Math.abs(dy) <= Math.abs(dx);
  if ((horizontal ? Math.abs(dy) : Math.abs(dx)) > captureDistance) return null;
  const end = horizontal ? { x: cursor.x, y: anchor.y } : { x: anchor.x, y: cursor.y };
  return {
    start: { ...anchor },
    end,
    angle: normalizeDegrees(Math.atan2(end.y - anchor.y, end.x - anchor.x) * 180 / Math.PI),
  };
}

export function constrainDraftingPoint(cursor: Vec2, base: Vec2 | null, settings: DraftingSettings, polarTolerance = 4): DraftingConstraint {
  if (!base) return { point: cursor, angle: 0, tracked: false };
  const dx = cursor.x - base.x, dy = cursor.y - base.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-12) return { point: cursor, angle: 0, tracked: false };
  const rawAngle = normalizeDegrees(Math.atan2(dy, dx) * 180 / Math.PI);
  if (settings.orthoEnabled) {
    const angle = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 180) : (dy >= 0 ? 90 : 270);
    const point = Math.abs(dx) >= Math.abs(dy) ? { x: cursor.x, y: base.y } : { x: base.x, y: cursor.y };
    return { point, angle, tracked: true };
  }
  if (!settings.polarEnabled) return { point: cursor, angle: rawAngle, tracked: false };
  const candidates = polarCandidates(settings.polarAngles);
  let bestAngle = rawAngle;
  let bestDifference = Number.POSITIVE_INFINITY;
  for (const angle of candidates) {
    const difference = angularDifference(rawAngle, angle);
    if (difference < bestDifference) { bestDifference = difference; bestAngle = angle; }
  }
  if (bestDifference > polarTolerance) return { point: cursor, angle: rawAngle, tracked: false };
  return { point: pointAt(base, distance, bestAngle), angle: bestAngle, tracked: true };
}

function polarCandidates(increments: readonly number[]): number[] {
  const candidates = new Set<number>([0, 90, 180, 270]);
  for (const increment of increments) {
    if (!Number.isFinite(increment) || increment <= 0) continue;
    for (let angle = 0; angle < 360 - 1e-9; angle += increment) candidates.add(normalizeDegrees(angle));
  }
  return [...candidates];
}

function pointAt(base: Vec2, distance: number, angle: number): Vec2 {
  const radians = angle * Math.PI / 180;
  return { x: base.x + Math.cos(radians) * distance, y: base.y + Math.sin(radians) * distance };
}

function normalizeDegrees(angle: number): number { return (angle % 360 + 360) % 360; }

function angularDifference(a: number, b: number): number {
  const difference = Math.abs(normalizeDegrees(a) - normalizeDegrees(b));
  return Math.min(difference, 360 - difference);
}
