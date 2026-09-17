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
  /** The dotted paths to draw — none, one, or the pair whose crossing caught
   *  the point. */
  guides: AlignmentGuide[];
  /**
   * Whether an acquired point's path is what put the point here, rather than
   * the cursor or a plain Ortho direction. Worth telling apart because it is
   * the one case with nothing drawn at the answer: the marker is all there is
   * to say the point was caught at all.
   */
  anchored?: boolean;
}

export interface PointRequest {
  cursor: Vec2;
  /** Ortho and polar measure direction from here: the last point, or the grip's origin. */
  base: Vec2 | null;
  /**
   * Points acquired by hovering them, whose alignment paths the cursor can
   * catch (F11). Two of them can be caught where their paths cross — which is
   * how a rectangle's centre is reached without anything drawn there: hover
   * the midpoint of one side, then of an adjacent side, and aim at the middle.
   */
  anchors: Vec2[];
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
  const { cursor, base, snap, settings, captureDistance } = request;
  if (snap) return { point: snap, guides: [] };
  // F11 off means an acquired point lays no path, so it has nothing to say here.
  const anchors = settings.objectSnapTrackingEnabled ? request.anchors : [];
  const anchor = anchors[0] ?? null;

  // Two acquired points beat everything below: their paths cross at exactly
  // one place, which is a point the drawing does not contain and no single
  // constraint could have named. Ortho does not get to overrule that, because
  // the crossing IS the answer being aimed at.
  const crossed = crossingOfTwoAnchors(anchors, cursor, captureDistance, settings);
  if (crossed) return crossed;

  if (settings.orthoEnabled || settings.polarEnabled) {
    const constrained = constrainDraftingPoint(cursor, base, settings);
    if (base && anchor && constrained.tracked) {
      const crossing = nearestCrossing(base, constrained.angle, anchor, constrained.point, captureDistance);
      if (crossing) {
        return {
          point: crossing,
          anchored: true,
          guides: [{ start: { ...anchor }, end: crossing, angle: directionDegrees(anchor, crossing) }],
        };
      }
    }
    return {
      point: constrained.point,
      guides: constrained.tracked && base
        ? [{ start: base, end: constrained.point, angle: constrained.angle }]
        : [],
    };
  }

  const path = anchor ? alignmentPath(cursor, anchor, captureDistance) : null;
  if (path) return { point: path.end, anchored: true, guides: [path] };
  return { point: cursor, guides: [] };
}

/**
 * The directions an acquired point lays a path along: the two axes always, and
 * the polar angles as well while polar tracking is on — the same set the cursor
 * is already being steered by, so the paths and the steering agree.
 *
 * Each is a line rather than a ray: an alignment path shows on both sides of
 * the point it comes from, as AutoCAD draws it.
 */
export function trackingAngles(settings: DraftingSettings): number[] {
  const angles = [0, 90];
  if (settings.polarEnabled) {
    for (const angle of settings.polarAngles) {
      const reduced = ((angle % 180) + 180) % 180;
      if (!angles.some((existing) => Math.abs(existing - reduced) < 1e-9)) angles.push(reduced);
    }
  }
  return angles;
}

/**
 * Where a path from one acquired point crosses a path from another, when the
 * cursor is near enough to that crossing to be asking for it. The nearest such
 * crossing wins, so two anchors offering several do not fight.
 */
function crossingOfTwoAnchors(
  anchors: readonly Vec2[],
  cursor: Vec2,
  captureDistance: number,
  settings: DraftingSettings,
): ResolvedPoint | null {
  if (anchors.length < 2) return null;
  const angles = trackingAngles(settings);
  let best: ResolvedPoint | null = null;
  let bestDistance = captureDistance;
  for (let a = 0; a < anchors.length; a++) {
    for (let b = a + 1; b < anchors.length; b++) {
      for (const angleA of angles) {
        for (const angleB of angles) {
          const point = lineCrossing(anchors[a], angleA, anchors[b], angleB);
          if (!point) continue;
          const distance = Math.hypot(point.x - cursor.x, point.y - cursor.y);
          if (distance > bestDistance) continue;
          bestDistance = distance;
          best = {
            point,
            anchored: true,
            guides: [
              { start: { ...anchors[a] }, end: point, angle: angleA },
              { start: { ...anchors[b] }, end: point, angle: angleB },
            ],
          };
        }
      }
    }
  }
  return best;
}

/** Where the infinite lines through two points at two angles meet, or null
 *  when they run parallel. */
function lineCrossing(a: Vec2, angleA: number, b: Vec2, angleB: number): Vec2 | null {
  const da = { x: Math.cos(angleA * Math.PI / 180), y: Math.sin(angleA * Math.PI / 180) };
  const db = { x: Math.cos(angleB * Math.PI / 180), y: Math.sin(angleB * Math.PI / 180) };
  const denominator = da.x * db.y - da.y * db.x;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((b.x - a.x) * db.y - (b.y - a.y) * db.x) / denominator;
  return { x: a.x + da.x * t, y: a.y + da.y * t };
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
