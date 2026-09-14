/**
 * Arc segments inside a polyline.
 *
 * A polyline used to be a chain of straight segments and nothing else, so any
 * arc that met one had to be approximated to join it: JOIN turned a slot's two
 * semicircular ends into cubic Beziers, and DXF import expanded every imported
 * bulge into sampled points. Both read back as "some curve" — the radius that
 * says what the slot actually is was gone, and nothing downstream could ever
 * cut a true cylinder from it again.
 *
 * DXF has always stored this on the polyline itself, as a *bulge* per segment:
 * `tan(θ/4)` of the segment's included angle, signed so that a positive value
 * turns counter-clockwise. Zero is a straight segment, 1 a half circle. That is
 * what is stored here, so an arc survives a round trip through a polyline
 * exactly rather than approximately.
 *
 * `bulges[i]` belongs to the segment *leaving* vertex `i`, the way DXF puts it
 * on that vertex — and the array may be short or absent, which simply means the
 * rest are straight.
 */
import type { Vec2 } from '../../math/geometry';
import type { ArcEntity, PolylineEntity } from './types';

/** One piece of a polyline: two ends, and how much it bows between them. */
export interface PolylineSegment {
  start: Vec2;
  end: Vec2;
  /** 0 for a straight segment. */
  bulge: number;
  /** Index of the vertex the segment leaves. */
  index: number;
}

/** The arc a bulge describes, in the same terms an ArcEntity uses. */
export interface BulgeArc {
  center: Vec2;
  radius: number;
  startAngle: number;
  /** Signed: positive turns counter-clockwise, like the bulge itself. */
  sweepAngle: number;
}

/** Below this a bulge is a rounding error, not an arc. */
const STRAIGHT = 1e-9;

export function polylineBulgeAt(entity: PolylineEntity, index: number): number {
  const bulge = entity.bulges?.[index];
  return typeof bulge === 'number' && Number.isFinite(bulge) ? bulge : 0;
}

/** Whether any segment of this polyline actually curves. */
export function hasPolylineArcs(entity: PolylineEntity): boolean {
  return Boolean(entity.bulges?.some((bulge) => Number.isFinite(bulge) && Math.abs(bulge) > STRAIGHT));
}

/**
 * Whether a closed polyline already repeats its first vertex at the end, which
 * is how `Document.createPolyline` stores one. Both shapes are met in practice
 * (a file, or a caller that closed it itself), so the segment walk below reads
 * either without inventing a zero-length segment between the duplicate pair.
 */
function closesWithDuplicate(entity: PolylineEntity): boolean {
  const vertices = entity.vertices;
  return entity.closed && vertices.length > 1
    && Math.abs(vertices[0].x - vertices[vertices.length - 1].x) < 1e-9
    && Math.abs(vertices[0].y - vertices[vertices.length - 1].y) < 1e-9;
}

/**
 * The segments, in order — one per straight run or arc. A closed polyline has
 * one more than an open one: the segment back from the last vertex to the
 * first, unless that vertex is already stored a second time.
 */
export function polylineSegments(entity: PolylineEntity): PolylineSegment[] {
  const vertices = entity.vertices;
  if (vertices.length < 2) return [];
  const count = entity.closed && !closesWithDuplicate(entity) ? vertices.length : vertices.length - 1;
  const segments: PolylineSegment[] = [];
  for (let index = 0; index < count; index++) {
    segments.push({
      start: vertices[index],
      end: vertices[(index + 1) % vertices.length],
      bulge: polylineBulgeAt(entity, index),
      index,
    });
  }
  return segments;
}

/**
 * The arc a bulged segment draws, or null when it is straight (or degenerate —
 * two coincident vertices have no arc between them however they are bulged).
 *
 * The centre sits on the chord's perpendicular bisector; the *signed* apothem
 * is what puts it on the correct side, so an arc of more than a half turn
 * (whose centre lies on the far side of its own chord) comes out right without
 * a special case.
 */
export function bulgeArc(start: Vec2, end: Vec2, bulge: number): BulgeArc | null {
  if (!Number.isFinite(bulge) || Math.abs(bulge) <= STRAIGHT) return null;
  const chord = Math.hypot(end.x - start.x, end.y - start.y);
  if (chord < 1e-12) return null;
  const sweepAngle = 4 * Math.atan(bulge);
  // Signed, so that a clockwise turn puts the centre on the other side of the
  // chord. Taking |sweep| here (which is what the DXF importer this replaces
  // did) mirrors every clockwise arc that is not exactly a half circle onto
  // the wrong side and then sweeps it the long way round; at exactly a half
  // circle the apothem is zero, which is why it went unnoticed.
  const signedRadius = chord / (2 * Math.sin(sweepAngle / 2));
  const radius = Math.abs(signedRadius);
  const ux = (end.x - start.x) / chord;
  const uy = (end.y - start.y) / chord;
  const apothem = signedRadius * Math.cos(sweepAngle / 2);
  const center = {
    x: (start.x + end.x) / 2 - uy * apothem,
    y: (start.y + end.y) / 2 + ux * apothem,
  };
  return { center, radius, startAngle: Math.atan2(start.y - center.y, start.x - center.x), sweepAngle };
}

/**
 * The bulge that reproduces `arc` as one polyline segment, travelling from its
 * start point to its end point — or from its end to its start when `reversed`,
 * which flips the direction of turn and so the sign.
 *
 * The inverse of `bulgeArc`, and what lets JOIN keep an arc exactly instead of
 * approximating it.
 */
export function bulgeForArc(sweepAngle: number, reversed = false): number {
  return Math.tan((reversed ? -sweepAngle : sweepAngle) / 4);
}

/** Where a bulged segment's arc starts and ends, in world-free local terms. */
export function segmentArcEndpoints(segment: PolylineSegment): { start: Vec2; end: Vec2 } {
  return { start: segment.start, end: segment.end };
}

/**
 * How many straight pieces one arc is drawn with. An angular step rather than a
 * fixed count, so a quarter turn is not given the same 64 pieces as a full
 * circle and a tiny fillet is not given 64 at all.
 */
export const ARC_SEGMENT_ANGLE = Math.PI / 32;

/** The points strictly between a bulged segment's own two vertices. */
export function arcInteriorPoints(segment: PolylineSegment, segmentAngle = ARC_SEGMENT_ANGLE): Vec2[] {
  const arc = bulgeArc(segment.start, segment.end, segment.bulge);
  if (!arc) return [];
  const count = Math.max(1, Math.ceil(Math.abs(arc.sweepAngle) / segmentAngle));
  const points: Vec2[] = [];
  for (let step = 1; step < count; step++) {
    const angle = arc.startAngle + (arc.sweepAngle * step) / count;
    points.push({ x: arc.center.x + Math.cos(angle) * arc.radius, y: arc.center.y + Math.sin(angle) * arc.radius });
  }
  return points;
}

/**
 * The polyline drawn out as a plain point chain — vertices with each arc's own
 * points filled in between them. A closed polyline does *not* repeat its first
 * point at the end; callers already know to close it, exactly as before.
 *
 * This is what everything that only needs to draw, measure or hit-test a
 * polyline uses, so none of them has to know a bulge exists. A polyline with no
 * arcs returns its own vertices, so the ordinary case costs nothing and reads
 * identically to what it read before.
 */
export function polylineOutline(entity: PolylineEntity, segmentAngle = ARC_SEGMENT_ANGLE): Vec2[] {
  if (!hasPolylineArcs(entity)) return entity.vertices;
  const points: Vec2[] = [];
  for (const segment of polylineSegments(entity)) {
    points.push(segment.start);
    points.push(...arcInteriorPoints(segment, segmentAngle));
  }
  // The far end, except where the walk above already came back round to the
  // first point — so the chain reads exactly as `entity.vertices` does for a
  // polyline with no arcs at all, duplicate closing vertex and all.
  if (!entity.closed || closesWithDuplicate(entity)) points.push(entity.vertices[entity.vertices.length - 1]);
  return points;
}

/**
 * The arcs a polyline holds, as standalone arc descriptions — what EXPLODE
 * hands back, and what the exact kernel builds a true cylindrical face from.
 */
export function polylineArcPieces(entity: PolylineEntity): Array<{ segment: PolylineSegment; arc: BulgeArc }> {
  const pieces: Array<{ segment: PolylineSegment; arc: BulgeArc }> = [];
  for (const segment of polylineSegments(entity)) {
    const arc = bulgeArc(segment.start, segment.end, segment.bulge);
    if (arc) pieces.push({ segment, arc });
  }
  return pieces;
}

/** An arc entity's own sweep, expressed as the bulge of the equivalent segment. */
export function arcEntityBulge(arc: Pick<ArcEntity, 'sweepAngle'>, reversed = false): number {
  return bulgeForArc(arc.sweepAngle, reversed);
}

/**
 * `bulges` trimmed to what a polyline with these vertices can use, or undefined
 * when every segment is straight — so an ordinary polyline never carries an
 * array of zeroes, and nothing downstream has to tell "no arcs" from "no field".
 */
export function normalizedBulges(bulges: readonly number[] | undefined, segmentCount: number): number[] | undefined {
  if (!bulges) return undefined;
  const trimmed = Array.from({ length: segmentCount }, (_, index) => {
    const bulge = bulges[index];
    return typeof bulge === 'number' && Number.isFinite(bulge) ? bulge : 0;
  });
  return trimmed.some((bulge) => Math.abs(bulge) > STRAIGHT) ? trimmed : undefined;
}

/**
 * The bulge of the segment from `start` to `end` that also passes through
 * `mid` — zero when the three are in a line (or two of them coincide), which
 * is exactly the answer a straight segment wants.
 *
 * Measured from the three points rather than copied from the arc they came
 * from, because a bulge is signed by the turn as seen *in the plane it is
 * stored in*: an arc drawn on a work plane whose normal points the other way
 * turns the opposite way once it is expressed in the joined polyline's plane,
 * and copying its own sweep angle across would bow it the wrong side.
 */
export function bulgeThroughPoints(start: Vec2, mid: Vec2, end: Vec2): number {
  const center = circleCenterThrough(start, mid, end);
  if (!center) return 0;
  const angleOf = (point: Vec2): number => Math.atan2(point.y - center.y, point.x - center.x);
  const startAngle = angleOf(start);
  const turn = (angle: number): number => {
    const delta = (angle - startAngle) % (Math.PI * 2);
    return delta < 0 ? delta + Math.PI * 2 : delta;
  };
  const toEnd = turn(angleOf(end));
  // `mid` decides which way round: on the counter-clockwise path from start to
  // end, or on the other one.
  const sweepAngle = turn(angleOf(mid)) < toEnd ? toEnd : toEnd - Math.PI * 2;
  return Math.tan(sweepAngle / 4);
}

/** The centre of the circle through three points, or null when they are in a
 *  line (or two of them are the same point). */
function circleCenterThrough(a: Vec2, b: Vec2, c: Vec2): Vec2 | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const sa = a.x * a.x + a.y * a.y, sb = b.x * b.x + b.y * b.y, sc = c.x * c.x + c.y * c.y;
  return {
    x: (sa * (b.y - c.y) + sb * (c.y - a.y) + sc * (a.y - b.y)) / d,
    y: (sa * (c.x - b.x) + sb * (a.x - c.x) + sc * (b.x - a.x)) / d,
  };
}

/** The point halfway along a bulged segment's own arc — the third point
 *  `bulgeThroughPoints` needs to read it back, and the middle a Midpoint snap
 *  should catch. Null for a straight segment. */
export function bulgeMidpoint(start: Vec2, end: Vec2, bulge: number): Vec2 | null {
  const arc = bulgeArc(start, end, bulge);
  if (!arc) return null;
  const angle = arc.startAngle + arc.sweepAngle / 2;
  return { x: arc.center.x + Math.cos(angle) * arc.radius, y: arc.center.y + Math.sin(angle) * arc.radius };
}
