/**
 * The 2D edits: trimming a line at a cutting edge, extending it to one, drawing
 * a parallel copy, and joining a chain into one polyline.
 *
 * The geometry they need travels with them, because nothing else uses it — it
 * had been sitting in the command manager, which is a place, not a home.
 */
import { AddEntityEdit, ReplaceObjectsEdit, UpdateEntityEdit } from '../../history/edits';
import { cloneEntity, closedVertices, curvePoints, ellipsePoints, isLineLikeEntity, isOffsetEntity, type ArcEntity, type BezierSegment, type CircleEntity, type Entity, type LineEntity, type PolylineEntity } from '../../entities/types';
import { closePolyline, dist2, midpoint2, type Vec2, type Vec3 } from '../../../math/geometry';
import { localToWorld, workPlaneFromXAxis, worldToLocal, WORLD_WORK_PLANE, type WorkPlane } from '../../../math/workplane';
import type { CommandRun, StepOutcome } from '../types';

export function lineIntersectionParameters(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { point: Vec2; t: number; u: number } | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-10) return null;
  const qx = c.x - a.x;
  const qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / denominator;
  const u = (qx * ry - qy * rx) / denominator;
  return { point: { x: a.x + t * rx, y: a.y + t * ry }, t, u };
}

export type LineLikeSegment = { start: Vec2; end: Vec2; startIndex: number; endIndex: number };

export function lineLikeSegments(entity: Extract<Entity, { type: 'line' | 'polyline' }>): LineLikeSegment[] {
  if (entity.type === 'line') return [{ start: entity.start, end: entity.end, startIndex: 0, endIndex: 1 }];
  const segments: LineLikeSegment[] = [];
  const count = entity.closed ? entity.vertices.length : entity.vertices.length - 1;
  for (let index = 0; index < count; index++) {
    const startIndex = index;
    const endIndex = entity.closed ? (index + 1) % entity.vertices.length : index + 1;
    const start = entity.vertices[startIndex];
    const end = entity.vertices[endIndex];
    if (start && end) segments.push({ start, end, startIndex, endIndex });
  }
  return segments;
}

export function segmentDistance(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return dist2(point, start);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / len2));
  const projection = { x: start.x + t * dx, y: start.y + t * dy };
  return dist2(point, projection);
}

export function nearestLineLikeSegment(entity: Extract<Entity, { type: 'line' | 'polyline' }>, point: Vec2): LineLikeSegment {
  const segments = lineLikeSegments(entity);
  if (segments.length === 0) {
    if (entity.type === 'line') return { start: entity.start, end: entity.end, startIndex: 0, endIndex: 1 };
    const fallback = entity.vertices[0] ?? { x: 0, y: 0 };
    return { start: fallback, end: fallback, startIndex: 0, endIndex: 0 };
  }
  let best = segments[0];
  let bestDistance = segmentDistance(point, best.start, best.end);
  for (const segment of segments.slice(1)) {
    const distance = segmentDistance(point, segment.start, segment.end);
    if (distance < bestDistance) { best = segment; bestDistance = distance; }
  }
  return best;
}

export function collectLineLikeIntersections(target: LineLikeSegment, boundary: Extract<Entity, { type: 'line' | 'polyline' }>): Array<{ point: Vec2; t: number; u: number }> {
  const intersections: Array<{ point: Vec2; t: number; u: number }> = [];
  for (const segment of lineLikeSegments(boundary)) {
    const hit = lineIntersectionParameters(target.start, target.end, segment.start, segment.end);
    if (hit) intersections.push(hit);
  }
  return intersections;
}

export function sameWorkPlane(a: Entity, b: Entity): boolean {
  return JSON.stringify(a.workPlane ?? WORLD_WORK_PLANE) === JSON.stringify(b.workPlane ?? WORLD_WORK_PLANE);
}

/**
 * Whether two work planes describe the same infinite plane, regardless of where
 * their origin sits on it or how they are rotated within it. Two objects drawn
 * on one face in different UCS sessions get different work planes (a shifted
 * origin, a turned x-axis) yet are perfectly coplanar — a strict compare would
 * wrongly reject them.
 */
export function coplanarPlanes(a: WorkPlane, b: WorkPlane): boolean {
  const parallel = a.zAxis.x * b.zAxis.x + a.zAxis.y * b.zAxis.y + a.zAxis.z * b.zAxis.z;
  if (Math.abs(Math.abs(parallel) - 1) > 1e-6) return false;
  const dx = b.origin.x - a.origin.x, dy = b.origin.y - a.origin.y, dz = b.origin.z - a.origin.z;
  const offset = dx * a.zAxis.x + dy * a.zAxis.y + dz * a.zAxis.z;
  return Math.abs(offset) < 1e-4;
}

/**
 * A copy of `entity` with its 2D geometry re-expressed in `target`'s work-plane
 * frame. TRIM does its crossing math in one shared 2D frame, so a coplanar
 * cutting edge carrying a different origin or in-plane rotation has to be carried
 * through world into the target's frame first — otherwise its local coordinates
 * are offset from the target's and the crossings land in the wrong place.
 */
function reprojectEntityToPlane(entity: Entity, target: WorkPlane): Entity {
  const source = entity.workPlane ?? WORLD_WORK_PLANE;
  const toTarget = (point: Vec2): Vec2 => {
    const local = worldToLocal(target, localToWorld(source, point));
    return { x: local.x, y: local.y };
  };
  const clone = cloneEntity(entity);
  clone.workPlane = target;
  if (clone.type === 'line') { clone.start = toTarget(clone.start); clone.end = toTarget(clone.end); }
  else if (clone.type === 'polyline') clone.vertices = clone.vertices.map(toTarget);
  else if (clone.type === 'circle') clone.center = toTarget(clone.center);
  else if (clone.type === 'arc') {
    clone.center = toTarget(clone.center);
    // The two frames may be turned relative to each other within the plane; the
    // arc's angles are frame-relative, so rotate them by that twist.
    clone.startAngle += Math.atan2(
      source.xAxis.x * target.yAxis.x + source.xAxis.y * target.yAxis.y + source.xAxis.z * target.yAxis.z,
      source.xAxis.x * target.xAxis.x + source.xAxis.y * target.xAxis.y + source.xAxis.z * target.xAxis.z,
    );
  }
  return clone;
}

const TAU = Math.PI * 2;
/** An angle folded into [0, 2π). */
const wrapAngle = (a: number): number => ((a % TAU) + TAU) % TAU;
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;

/**
 * Where the infinite line through p0→p1 meets the circle, as parameters t along
 * that line (t=0 at p0, t=1 at p1). Zero, one (tangent) or two crossings. The
 * caller decides which t values it will accept.
 */
export function segmentCircleIntersections(p0: Vec2, p1: Vec2, center: Vec2, radius: number): Array<{ point: Vec2; t: number }> {
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const fx = p0.x - center.x, fy = p0.y - center.y;
  const a = dx * dx + dy * dy;
  if (a < 1e-12) return [];
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - radius * radius;
  const disc = b * b - 4 * a * c;
  // A line built to be exactly tangent (e.g. via the tangent snap) can still
  // land its discriminant a hair below zero to floating-point rounding, so
  // reject only discriminants that are negative well beyond that noise floor,
  // and treat anything within it as the single tangent contact point.
  const tangentTolerance = 1e-9 * a * Math.max(radius * radius, 1e-12);
  if (disc < -tangentTolerance) return [];
  const roots = disc <= tangentTolerance ? [-b / (2 * a)] : (() => {
    const sqrt = Math.sqrt(disc);
    return [(-b - sqrt) / (2 * a), (-b + sqrt) / (2 * a)];
  })();
  return roots.map((t) => ({ t, point: { x: p0.x + t * dx, y: p0.y + t * dy } }));
}

/** The one or two points where two circles cross; empty when they miss, nest, or coincide. */
export function circleCircleIntersections(c0: Vec2, r0: number, c1: Vec2, r1: number): Vec2[] {
  const dx = c1.x - c0.x, dy = c1.y - c0.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9 || d > r0 + r1 + 1e-9 || d < Math.abs(r0 - r1) - 1e-9) return [];
  const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  const h2 = r0 * r0 - a * a;
  const h = Math.sqrt(Math.max(0, h2));
  const mx = c0.x + (a * dx) / d, my = c0.y + (a * dy) / d;
  const ox = -dy * (h / d), oy = dx * (h / d);
  if (h < 1e-9) return [{ x: mx, y: my }];
  return [{ x: mx + ox, y: my + oy }, { x: mx - ox, y: my - oy }];
}

/** Whether a point on the arc's own circle lies within its swept span. */
export function angleWithinArc(point: Vec2, arc: ArcEntity): boolean {
  const rel = wrapAngle(Math.atan2(point.y - arc.center.y, point.x - arc.center.x) - arc.startAngle);
  return arc.sweepAngle >= 0 ? rel <= arc.sweepAngle + 1e-9 : rel - TAU >= arc.sweepAngle - 1e-9;
}

/** A boundary a TRIM cutting edge can be: the line kinds, plus circle and arc. */
export function isTrimBoundary(entity: Entity): boolean {
  return isLineLikeEntity(entity) || entity.type === 'circle' || entity.type === 'arc';
}

/**
 * Where a target line segment crosses a boundary, as {point, t (along the
 * target), u (along the boundary)}. Line-like boundaries give a real u; a
 * circle or arc has no single edge to parametrise, so u is reported as 0.5 —
 * always "within" — because any crossing of a closed curve is a real one.
 */
function boundaryIntersections(target: LineLikeSegment, boundary: Entity): Array<{ point: Vec2; t: number; u: number }> {
  if (isLineLikeEntity(boundary)) return collectLineLikeIntersections(target, boundary);
  if (boundary.type === 'circle' || boundary.type === 'arc') {
    return segmentCircleIntersections(target.start, target.end, boundary.center, boundary.radius)
      .filter((hit) => boundary.type !== 'arc' || angleWithinArc(hit.point, boundary))
      .map((hit) => ({ point: hit.point, t: hit.t, u: 0.5 }));
  }
  return [];
}

/** Every point at which a boundary crosses the given circle. */
function circleCrossings(circle: CircleEntity, boundary: Entity): Vec2[] {
  if (boundary.type === 'circle') return circleCircleIntersections(boundary.center, boundary.radius, circle.center, circle.radius);
  if (boundary.type === 'arc') {
    return circleCircleIntersections(boundary.center, boundary.radius, circle.center, circle.radius)
      .filter((point) => angleWithinArc(point, boundary));
  }
  if (isLineLikeEntity(boundary)) {
    const points: Vec2[] = [];
    for (const segment of lineLikeSegments(boundary)) {
      for (const hit of segmentCircleIntersections(segment.start, segment.end, circle.center, circle.radius)) {
        if (hit.t >= -1e-8 && hit.t <= 1 + 1e-8) points.push(hit.point);
      }
    }
    return points;
  }
  return [];
}

/**
 * Trimming a circle removes the span you clicked and leaves the rest as an arc.
 * The cutting edge has to cross the circle at two points; those two points bound
 * the removed span, and the kept arc runs the other way round between them.
 */
function trimCircleTarget(run: CommandRun, circle: CircleEntity, boundaries: Entity[], click: Vec2 | null): StepOutcome {
  const { ctx } = run;

  // Every cutting edge contributes its crossings, so a circle can be bracketed
  // between two different lines — that is what lets two parallel edges cut a
  // circle down to the slot end you clicked.
  const crossings = boundaries.flatMap((boundary) => circleCrossings(circle, boundary));
  // Fold to distinct angles: a cutting edge tangent to the circle, or one that
  // clips it twice at the same place, is not something to trim at.
  const angles: number[] = [];
  for (const point of crossings) {
    const angle = wrapAngle(Math.atan2(point.y - circle.center.y, point.x - circle.center.x));
    if (!angles.some((existing) => Math.abs(existing - angle) < 1e-6 || Math.abs(existing - angle) > TAU - 1e-6)) angles.push(angle);
  }
  if (angles.length < 2) {
    ctx.log('TRIM failed: the cutting edge must cross the circle at two points.');
    return 'stay';
  }
  angles.sort((a, b) => a - b);
  const clickAngle = click ? wrapAngle(Math.atan2(click.y - circle.center.y, click.x - circle.center.x)) : angles[0] + 1e-3;

  // The two crossings that bracket the click bound the span to drop; keep the
  // complement, running CCW from the upper bracket back round to the lower one.
  let lo = angles[angles.length - 1], hi = angles[0];
  for (let index = 0; index < angles.length; index++) {
    const a0 = angles[index], a1 = angles[(index + 1) % angles.length];
    const inside = index + 1 < angles.length ? clickAngle >= a0 && clickAngle < a1 : clickAngle >= a0 || clickAngle < a1;
    if (inside) { lo = a0; hi = a1; break; }
  }
  const start = hi;
  const sweep = wrapAngle(lo - hi) || TAU;

  const arc = ctx.doc.createArc(circle.center, circle.radius, start, sweep);
  arc.workPlane = cloneEntity(circle).workPlane;
  arc.layer = circle.layer;
  arc.aci = circle.aci;
  arc.color = circle.color;
  ctx.history.execute(new ReplaceObjectsEdit('Trim', [circle], [], [arc], []));
  ctx.doc.selectEntity(arc.id);
  ctx.log('Circle trimmed to an arc. Select another object or press Enter.');
  return 'stay';
}

/** Drops points that repeat the one before them, within a hair. */
function dropRepeats(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 1e-9) out.push(point);
  }
  return out;
}

/** The forward distance from one polyline parameter to another, wrapped over a closed loop of `n` segments. */
const forwardSpan = (from: number, to: number, n: number): number => {
  const d = (to - from) % n;
  return d < 0 ? d + n : d;
};

/**
 * Trimming a line removes the span you clicked, same idea as a polyline: every
 * crossing with every cutting edge is found first, then whichever two bracket
 * the click bound what goes. A crossing on only one side shortens that end —
 * the ordinary trim. A crossing on *both* sides means the click landed between
 * two cutting edges, and there is no single line that is both pieces at once,
 * so the line splits into the two that are left after the middle is cut away.
 */
function trimLineTarget(run: CommandRun, target: LineEntity, boundaries: Entity[], click: Vec2 | null): StepOutcome {
  const { ctx } = run;
  const segment: LineLikeSegment = { start: target.start, end: target.end, startIndex: 0, endIndex: 1 };
  const hits = boundaries.flatMap((boundary) => boundaryIntersections(segment, boundary))
    .filter((hit) => hit.t >= -1e-8 && hit.t <= 1 + 1e-8 && hit.u >= -1e-8 && hit.u <= 1 + 1e-8);
  if (hits.length === 0) {
    ctx.log('TRIM failed: the line does not cross the cutting edge.');
    return 'stay';
  }
  const crossings: Array<{ t: number; point: Vec2 }> = [];
  for (const hit of hits) {
    if (!crossings.some((existing) => Math.abs(existing.t - hit.t) < 1e-6)) crossings.push({ t: hit.t, point: hit.point });
  }
  crossings.sort((a, b) => a.t - b.t);

  const dx = segment.end.x - segment.start.x, dy = segment.end.y - segment.start.y;
  const lengthSquared = dx * dx + dy * dy;
  const point = click ?? segment.start;
  const clickT = lengthSquared < 1e-12 ? 0
    : ((point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy) / lengthSquared;

  const below = [...crossings].reverse().find((cross) => cross.t < clickT - 1e-9) ?? null;
  const above = crossings.find((cross) => cross.t > clickT + 1e-9) ?? null;
  if (!below && !above) {
    ctx.log('TRIM failed: the line does not cross the cutting edge on the side you picked.');
    return 'stay';
  }
  const pieces: Array<{ start: Vec2; end: Vec2 }> = [];
  if (below) pieces.push({ start: segment.start, end: below.point });
  if (above) pieces.push({ start: above.point, end: segment.end });
  const kept = pieces.filter((piece) => dist2(piece.start, piece.end) > 1e-9);
  if (kept.length === 0) {
    ctx.log('TRIM failed: nothing would be left of the line.');
    return 'stay';
  }

  if (kept.length === 1) {
    const updated = cloneEntity(target);
    updated.start = kept[0].start;
    updated.end = kept[0].end;
    ctx.history.execute(new UpdateEntityEdit('Trim', target, updated));
    ctx.doc.selectEntity(updated.id);
  } else {
    const added = kept.map((piece) => {
      const line = ctx.doc.createLine(piece.start, piece.end);
      line.workPlane = cloneEntity(target).workPlane;
      line.layer = target.layer; line.aci = target.aci; line.color = target.color;
      return line;
    });
    ctx.history.execute(new ReplaceObjectsEdit('Trim', [target], [], added, []));
    added.forEach((entity, index) => ctx.doc.selectEntity(entity.id, index > 0));
  }
  ctx.log('Line trimmed at cutting edge. Select another object or press Enter.');
  return 'stay';
}

/**
 * Trimming a polyline cuts it where it crosses the cutting edge and removes the
 * span you clicked. A closed polyline opens up, kept as the run of vertices the
 * other way round between the two bracketing crossings. An open one is truncated
 * at the crossing, or split in two when the removed span sits in its middle.
 * Moving a single shared vertex — the old behaviour — reshaped the whole loop,
 * which is what turned a clicked corner into a stray line.
 */
function trimPolylineTarget(run: CommandRun, target: PolylineEntity, boundaries: Entity[], click: Vec2 | null): StepOutcome {
  const { ctx } = run;
  const n = target.vertices.length;
  const segments = lineLikeSegments(target);

  // Crossings of the whole polyline with every cutting edge, as s = segmentIndex + t.
  const crossings: Array<{ s: number; point: Vec2 }> = [];
  segments.forEach((segment, index) => {
    for (const boundary of boundaries) {
      for (const hit of boundaryIntersections(segment, boundary)) {
        if (hit.t < -1e-9 || hit.t > 1 + 1e-9 || hit.u < -1e-9 || hit.u > 1 + 1e-9) continue;
        const s = index + Math.min(1, Math.max(0, hit.t));
        if (!crossings.some((existing) => Math.abs(existing.s - s) < 1e-6)) crossings.push({ s, point: hit.point });
      }
    }
  });
  if (crossings.length === 0) {
    ctx.log('TRIM failed: the polyline does not cross any cutting edge.');
    return 'stay';
  }
  crossings.sort((a, b) => a.s - b.s);

  // Where the click lands along the polyline, in the same parameter.
  let sClick = 0, bestDistance = Infinity;
  segments.forEach((segment, index) => {
    const dx = segment.end.x - segment.start.x, dy = segment.end.y - segment.start.y;
    const len2 = dx * dx + dy * dy;
    const point = click ?? segment.start;
    const t = len2 < 1e-12 ? 0 : Math.min(1, Math.max(0, ((point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy) / len2));
    const distance = click ? (click.x - (segment.start.x + t * dx)) ** 2 + (click.y - (segment.start.y + t * dy)) ** 2 : index;
    if (distance < bestDistance) { bestDistance = distance; sClick = index + t; }
  });

  const vertexAt = (index: number): Vec2 => ({ ...target.vertices[((index % n) + n) % n] });
  // From the polyline start up to a crossing, and from a crossing to the end.
  const headPiece = (cross: { s: number; point: Vec2 }): Vec2[] => {
    const points: Vec2[] = [];
    for (let p = 0; p < cross.s - 1e-9; p++) points.push(vertexAt(p));
    points.push(cross.point);
    return points;
  };
  const tailPiece = (cross: { s: number; point: Vec2 }): Vec2[] => {
    const points: Vec2[] = [cross.point];
    for (let p = Math.ceil(cross.s + 1e-9); p <= n - 1; p++) points.push(vertexAt(p));
    return points;
  };

  let pieces: Vec2[][];
  if (target.closed) {
    if (crossings.length < 2) {
      ctx.log('TRIM failed: the cutting edge must cross the closed polyline at two points.');
      return 'stay';
    }
    // The two crossings bracketing the click bound the removed span; keep the
    // rest, walking forward (with wrap) from the upper crossing to the lower.
    let upperIndex = crossings.findIndex((cross) => cross.s > sClick);
    if (upperIndex === -1) upperIndex = 0;
    const upper = crossings[upperIndex];
    const lower = crossings[(upperIndex - 1 + crossings.length) % crossings.length];
    const total = forwardSpan(upper.s, lower.s, n);
    const kept: Vec2[] = [upper.point];
    for (let step = 0; step < n; step++) {
      const p = Math.ceil(upper.s + 1e-9) + step;
      if (forwardSpan(upper.s, p, n) >= total - 1e-9) break;
      kept.push(vertexAt(p));
    }
    kept.push(lower.point);
    pieces = [kept];
  } else {
    const below = [...crossings].reverse().find((cross) => cross.s < sClick - 1e-9) ?? null;
    const above = crossings.find((cross) => cross.s > sClick + 1e-9) ?? null;
    if (!below && !above) {
      ctx.log('TRIM failed: the polyline does not cross the cutting edge.');
      return 'stay';
    }
    // A crossing on each side removes an interior span and splits the polyline;
    // a crossing on one side only truncates that end.
    pieces = [];
    if (below) pieces.push(headPiece(below));
    if (above) pieces.push(tailPiece(above));
  }

  const kept = pieces.map(dropRepeats).filter((piece) => piece.length >= 2);
  if (kept.length === 0) {
    ctx.log('TRIM failed: nothing would be left of the polyline.');
    return 'stay';
  }
  if (kept.length === 1) {
    const updated = cloneEntity(target) as PolylineEntity;
    updated.vertices = kept[0];
    updated.closed = false;
    ctx.history.execute(new UpdateEntityEdit('Trim', target, updated));
    ctx.doc.selectEntity(updated.id);
  } else {
    const added = kept.map((piece) => {
      const polyline = ctx.doc.createPolyline(piece, false);
      polyline.workPlane = cloneEntity(target).workPlane;
      polyline.layer = target.layer;
      polyline.aci = target.aci;
      polyline.color = target.color;
      return polyline;
    });
    ctx.history.execute(new ReplaceObjectsEdit('Trim', [target], [], added, []));
    added.forEach((entity, index) => ctx.doc.selectEntity(entity.id, index > 0));
  }
  ctx.log('Polyline trimmed at cutting edge. Select another object or press Enter.');
  return 'stay';
}

export function pointInClosedPolygon(point: Vec2, vertices: Vec2[]): boolean {
  let inside = false;
  for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index++) {
    const a = vertices[index], b = vertices[previous];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * A real corner gets a sharp miter; a smooth loop sampled into many barely-
 * turning segments — an ellipse, a JOINed closed curve — falls back to the
 * average of its two normals past the same miter limit `offsetOpenPolyline`
 * uses, for the same reason: two nearly-parallel offset edges can meet many
 * times farther out than the offset distance itself.
 */
export function offsetPolygon(vertices: Vec2[], distance: number): Vec2[] | null {
  const n = vertices.length;
  if (n < 3) return null;
  let twiceArea = 0;
  for (let index = 0; index < n; index++) {
    const a = vertices[index], b = vertices[(index + 1) % n];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  if (Math.abs(twiceArea) < 1e-9) return null;
  const orientation = twiceArea > 0 ? 1 : -1;
  const normals: Array<Vec2 | null> = vertices.map((start, index) => {
    const end = vertices[(index + 1) % n];
    const dx = end.x - start.x, dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return null;
    return orientation > 0 ? { x: dy / length, y: -dx / length } : { x: -dy / length, y: dx / length };
  });
  if (normals.some((normal) => !normal)) return null;

  const miterLimit = 4 * Math.abs(distance);
  return vertices.map((vertex, index) => {
    const n1 = normals[(index - 1 + n) % n]!, n2 = normals[index]!;
    const prev = vertices[(index - 1 + n) % n], next = vertices[(index + 1) % n];
    const edgeA = { start: offsetPoint(prev, n1, distance), end: offsetPoint(vertex, n1, distance) };
    const edgeB = { start: offsetPoint(vertex, n2, distance), end: offsetPoint(next, n2, distance) };
    const intersection = lineIntersectionParameters(edgeA.start, edgeA.end, edgeB.start, edgeB.end);
    return intersection && dist2(intersection.point, vertex) <= miterLimit
      ? intersection.point
      : offsetPoint(vertex, averageUnitNormal(n1, n2), distance);
  });
}

function offsetPoint(point: Vec2, normal: Vec2, signedDistance: number): Vec2 {
  return { x: point.x + normal.x * signedDistance, y: point.y + normal.y * signedDistance };
}

/** The unit bisector of two unit normals — the fallback join, which never
 *  moves farther from the vertex than `signedDistance` itself. */
function averageUnitNormal(a: Vec2, b: Vec2): Vec2 {
  const sum = { x: a.x + b.x, y: a.y + b.y };
  const length = Math.hypot(sum.x, sum.y);
  // Exactly opposite normals (the chain doubles straight back on itself) have
  // no single bisector; either one is as good as the other for how rare and
  // degenerate that is.
  return length < 1e-9 ? a : { x: sum.x / length, y: sum.y / length };
}

/**
 * The open counterpart of `offsetPolygon`: no wraparound edge, and the two
 * ends are the plain perpendicular-shifted endpoints rather than a miter —
 * there is no neighbouring edge there to miter against. `signedDistance`
 * carries which side to offset toward, since an open chain has no inside to
 * test the way a closed one does; the caller works that out once, from which
 * side of the chain the pick point fell on, and it holds for every edge.
 *
 * A real corner (two hand-drawn segments meeting at a clear angle) gets a
 * sharp miter, same as a closed polygon. A curve sampled into many almost-
 * straight-through segments — a JOINed Bezier, mainly — does not: two edges
 * barely turning are nearly parallel, and their *exact* intersection can land
 * many times farther out than the offset itself, which reads as the offset
 * "not working" (a spike flying off toward infinity). Past a miter limit —
 * the same idea SVG's stroke-linejoin uses — this falls back to the average
 * of the two normals instead, which stays close to the source by construction
 * and keeps a smooth curve smooth.
 */
export function offsetOpenPolyline(vertices: Vec2[], signedDistance: number): Vec2[] | null {
  if (vertices.length < 2) return null;
  const normals: Vec2[] = [];
  for (let index = 0; index < vertices.length - 1; index++) {
    const start = vertices[index], end = vertices[index + 1];
    const dx = end.x - start.x, dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return null;
    normals.push({ x: -dy / length, y: dx / length });
  }
  const miterLimit = 4 * Math.abs(signedDistance);
  return vertices.map((vertex, index) => {
    if (index === 0) return offsetPoint(vertex, normals[0], signedDistance);
    if (index === vertices.length - 1) return offsetPoint(vertex, normals.at(-1)!, signedDistance);
    const n1 = normals[index - 1], n2 = normals[index];
    const edgeA = { start: offsetPoint(vertices[index - 1], n1, signedDistance), end: offsetPoint(vertex, n1, signedDistance) };
    const edgeB = { start: offsetPoint(vertex, n2, signedDistance), end: offsetPoint(vertices[index + 1], n2, signedDistance) };
    const intersection = lineIntersectionParameters(edgeA.start, edgeA.end, edgeB.start, edgeB.end);
    return intersection && dist2(intersection.point, vertex) <= miterLimit
      ? intersection.point
      : offsetPoint(vertex, averageUnitNormal(n1, n2), signedDistance);
  });
}

/** Which side of an open polyline the pick point falls on, from whichever
 *  segment it is actually nearest — the same question a line's offset asks,
 *  answered once and then held for the whole chain. */
function openPolylineOffsetSign(vertices: Vec2[], sidePoint: Vec2): number {
  let bestIndex = 0;
  let bestDistanceSquared = Infinity;
  for (let index = 0; index < vertices.length - 1; index++) {
    const start = vertices[index], end = vertices[index + 1];
    const dx = end.x - start.x, dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared < 1e-12 ? 0 : Math.max(0, Math.min(1, ((sidePoint.x - start.x) * dx + (sidePoint.y - start.y) * dy) / lengthSquared));
    const projected = { x: start.x + t * dx, y: start.y + t * dy };
    const distanceSquared = (sidePoint.x - projected.x) ** 2 + (sidePoint.y - projected.y) ** 2;
    if (distanceSquared < bestDistanceSquared) { bestDistanceSquared = distanceSquared; bestIndex = index; }
  }
  const start = vertices[bestIndex], end = vertices[bestIndex + 1];
  const dx = end.x - start.x, dy = end.y - start.y;
  const mid = midpoint2(start, end);
  return dx * (sidePoint.y - mid.y) - dy * (sidePoint.x - mid.x) >= 0 ? 1 : -1;
}

export function isSweepPathEntity(entity: Entity): boolean {
  return entity.type === 'line' || entity.type === 'arc' || entity.type === 'bezier'
    || entity.type === 'circle' || entity.type === 'polyline';
}

/**
 * TRIM and EXTEND ask the same two questions and do the same thing to the
 * answer: find where the target crosses the boundary, and move the nearer end
 * of it there. They differ in *which* crossings count — inside the segment for
 * a trim, past its end for an extend — and in which end to move.
 */
function cutOrStretch(run: CommandRun, mode: 'Trim' | 'Extend'): StepOutcome {
  const { active, data, value, ctx } = run;
  const trimming = mode === 'Trim';

  // Step 0 gathers one or more cutting edges (boundaries), finished with Enter.
  if (active.stepIndex === 0) {
    if (value) {
      const boundary = value as Entity;
      // A trim can be cut by a circle or arc as well as a line; an extend reaches
      // only toward a straight boundary.
      if (trimming ? !isTrimBoundary(boundary) : !isLineLikeEntity(boundary)) {
        ctx.log(trimming
          ? 'TRIM cutting edge must be a line, polyline, circle, or arc.'
          : 'EXTEND boundary must be a line or polyline.');
        return 'stay';
      }
      run.gather(boundary);
      const count = (data.entities as Entity[] | undefined)?.length ?? 0;
      ctx.log(`${count} ${trimming ? 'cutting edge' : 'boundary'}(s) selected. Select more or press Enter.`);
      return 'stay';
    }
    // Enter: nothing more to add; move on to picking objects to act on.
    const boundaries = (data.entities as Entity[] | undefined) ?? [];
    if (boundaries.length === 0) {
      ctx.log(trimming ? 'Select at least one cutting edge.' : 'Select at least one boundary.');
      return 'stay';
    }
    return 'advance';
  }

  // Enter on the (optional) target step ends the command; the cutting edges stay
  // active for every object until then, so a whole run of trims is one gesture.
  if (!value) return 'advance';

  const boundaries = (data.entities as Entity[] | undefined) ?? [];
  const target = value as Entity;
  if (boundaries.some((boundary) => boundary.id === target.id)) {
    ctx.log(`Select a different object to ${mode.toLowerCase()}.`);
    return 'stay';
  }
  // Only coplanar cutting edges can cross the target. Each is reprojected into
  // the target's frame so edges drawn on the same face in a different UCS (a
  // shifted origin or turned axes) still work.
  const targetPlane = target.workPlane ?? WORLD_WORK_PLANE;
  const usable = boundaries
    .filter((boundary) => coplanarPlanes(boundary.workPlane ?? WORLD_WORK_PLANE, targetPlane))
    .map((boundary) => reprojectEntityToPlane(boundary, targetPlane));
  if (usable.length === 0) {
    ctx.log(`The ${trimming ? 'cutting edge' : 'boundary'}(s) must be coplanar with the target.`);
    return 'stay';
  }
  // The pick arrives in the *active* work plane's local frame; the crossing math
  // runs in the target's frame. Carry it through world into the target's frame,
  // which is the identity when you are trimming on the plane you drew the target
  // on, and reprojects correctly when the active UCS differs.
  const rawClick = data.targetPickPoint as Vec2 | undefined;
  const localClick = rawClick
    ? (() => { const l = worldToLocal(targetPlane, localToWorld(ctx.doc.activeWorkPlane, rawClick)); return { x: l.x, y: l.y }; })()
    : null;

  // Trimming a circle is its own thing: it becomes an arc, there is no end to move.
  if (trimming && target.type === 'circle') {
    return trimCircleTarget(run, target, usable, localClick);
  }
  // Trimming a polyline cuts it at the crossings rather than dragging a vertex.
  if (trimming && target.type === 'polyline') {
    return trimPolylineTarget(run, target, usable, localClick);
  }
  // A line trimmed between two cutting edges splits in two, same as a polyline
  // does above — dragging just one end (what the shared code below still does,
  // for extend) only ever accounts for the one crossing nearest the click.
  if (trimming && target.type === 'line') {
    return trimLineTarget(run, target, usable, localClick);
  }
  if (!isLineLikeEntity(target)) {
    ctx.log(trimming ? 'Select a line, polyline, or circle to trim.' : 'Select a line or polyline to extend.');
    return 'stay';
  }
  // A line-like target can be cut by a circle or arc (trim only); an extend, and
  // both ends of a trim, still need a boundary that yields a crossing.
  const reaching = usable.filter((boundary) =>
    isLineLikeEntity(boundary) || (trimming && (boundary.type === 'circle' || boundary.type === 'arc')));
  if (reaching.length === 0) {
    ctx.log(`Select a line or polyline to ${mode.toLowerCase()} against.`);
    return 'stay';
  }

  const click = localClick ?? undefined;
  const fallback = target.type === 'line' ? target.start : target.vertices[0] ?? { x: 0, y: 0 };
  const segment = nearestLineLikeSegment(target, click ?? fallback);
  // A trim needs a crossing within the segment; an extend needs one beyond it.
  // Both need the cutting edge's own segment to actually reach.
  const hits = reaching.flatMap((boundary) => boundaryIntersections(segment, boundary)).filter((hit) => {
    const within = hit.t >= -1e-8 && hit.t <= 1 + 1e-8;
    return (trimming ? within : !within) && hit.u >= -1e-8 && hit.u <= 1 + 1e-8;
  });
  if (hits.length === 0) {
    ctx.log(trimming
      ? 'TRIM failed: the line or polyline does not cross the cutting edge.'
      : 'EXTEND failed: the boundary does not intersect an extension of this line or polyline.');
    return 'stay';
  }
  // Where along the segment the click was, so the end nearer the click is the
  // one that moves — trimming takes off the side you pointed at, extending
  // reaches out from it.
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const lengthSquared = dx * dx + dy * dy;
  const clickT = click && lengthSquared > 1e-12
    ? ((click.x - segment.start.x) * dx + (click.y - segment.start.y) * dy) / lengthSquared
    : 1;

  // Extending only ever moves the end nearest the click; a boundary that only
  // reaches past the *other* end must not win just for being close in space,
  // or that far end gets yanked across the whole line, wiping out the span
  // between the two original endpoints instead of extending it.
  const candidates = trimming ? hits : hits.filter((candidate) => (clickT < 0.5 ? candidate.t < 0 : candidate.t > 1));
  if (candidates.length === 0) {
    ctx.log('EXTEND failed: no boundary reaches past the end nearest your pick.');
    return 'stay';
  }
  const hit = click
    ? candidates.reduce((best, candidate) => dist2(candidate.point, click) < dist2(best.point, click) ? candidate : best)
    : candidates[0];
  const useStart = trimming ? clickT < hit.t : clickT < 0.5;

  const updated = cloneEntity(target);
  if (updated.type === 'line') {
    if (useStart) updated.start = hit.point; else updated.end = hit.point;
  } else if (updated.type === 'polyline') {
    updated.vertices[useStart ? segment.startIndex : segment.endIndex] = hit.point;
  }
  ctx.history.execute(new UpdateEntityEdit(mode, target, updated));
  ctx.doc.selectEntity(updated.id);
  const noun = target.type === 'line' ? 'Line' : 'Polyline';
  ctx.log(trimming
    ? `${noun} trimmed at cutting edge. Select another object or press Enter.`
    : `${noun} extended by ${Math.min(dist2(hit.point, segment.start), dist2(hit.point, segment.end)).toFixed(3)} mm. Select another object or press Enter.`);
  return 'stay';
}

export const trimEntity = (run: CommandRun): StepOutcome => cutOrStretch(run, 'Trim');
export const extendEntity = (run: CommandRun): StepOutcome => cutOrStretch(run, 'Extend');

/** Parses the size step into chamfer face distances or a fillet radius. */
function readCornerSize(value: unknown, rounded: boolean, ctx: CommandRun['ctx']): { radius: number; d1: number; d2: number } | null {
  if (rounded) {
    const radius = Math.abs(value as number);
    if (!Number.isFinite(radius) || radius < 1e-9) { ctx.log('Enter a fillet radius greater than zero.'); return null; }
    return { radius, d1: 0, d2: 0 };
  }
  const pair = (value as [number, number]).map(Math.abs) as [number, number];
  if (!pair.every(Number.isFinite)) { ctx.log('Enter valid chamfer distances.'); return null; }
  if (pair[0] < 1e-9 && pair[1] < 1e-9) { ctx.log('Enter chamfer distances greater than zero.'); return null; }
  return { radius: 0, d1: pair[0], d2: pair[1] };
}

/** The distinct vertices of a polyline; a closed one repeats its first point at the end. */
function polylineRing(polyline: PolylineEntity): Vec2[] {
  const v = polyline.vertices;
  if (polyline.closed && v.length > 1 && dist2(v[0], v[v.length - 1]) < 1e-6) return v.slice(0, -1);
  return [...v];
}

/** Index i of the ring segment ring[i]→ring[i+1] nearest the point. */
function nearestRingSegment(ring: Vec2[], closed: boolean, point: Vec2): number {
  const count = closed ? ring.length : ring.length - 1;
  let best = 0, bestDistance = Infinity;
  for (let i = 0; i < count; i++) {
    const distance = segmentDistance(point, ring[i], ring[(i + 1) % ring.length]);
    if (distance < bestDistance) { bestDistance = distance; best = i; }
  }
  return best;
}

/**
 * The points that replace a corner vertex V: two cut points for a chamfer, or a
 * tessellated arc for a fillet, running from the edge toward `prev` to the edge
 * toward `next`. Null (with a logged reason) when the corner cannot take it.
 */
function cornerReplacement(V: Vec2, prev: Vec2, next: Vec2, size: { radius: number; d1: number; d2: number }, rounded: boolean, ctx: CommandRun['ctx']): Vec2[] | null {
  const lenP = Math.hypot(prev.x - V.x, prev.y - V.y), lenN = Math.hypot(next.x - V.x, next.y - V.y);
  if (lenP < 1e-9 || lenN < 1e-9) { ctx.log('Cannot modify a corner with a zero-length edge.'); return null; }
  const uP = { x: (prev.x - V.x) / lenP, y: (prev.y - V.y) / lenP };
  const uN = { x: (next.x - V.x) / lenN, y: (next.y - V.y) / lenN };
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(uP, uN))));
  if (theta < 1e-4 || theta > Math.PI - 1e-4) { ctx.log(`${rounded ? 'FILLET' : 'CHAMFER'} failed: this corner is a straight line.`); return null; }
  if (rounded) {
    const half = theta / 2;
    const tangent = size.radius / Math.tan(half);
    if (tangent > lenP - 1e-9 || tangent > lenN - 1e-9) { ctx.log('FILLET failed: the radius is too large for this corner.'); return null; }
    const T1 = { x: V.x + uP.x * tangent, y: V.y + uP.y * tangent };
    const T2 = { x: V.x + uN.x * tangent, y: V.y + uN.y * tangent };
    const bisector = { x: uP.x + uN.x, y: uP.y + uN.y };
    const blen = Math.hypot(bisector.x, bisector.y);
    const centre = { x: V.x + (bisector.x / blen) * (size.radius / Math.sin(half)), y: V.y + (bisector.y / blen) * (size.radius / Math.sin(half)) };
    const a1 = Math.atan2(T1.y - centre.y, T1.x - centre.x);
    const a2 = Math.atan2(T2.y - centre.y, T2.x - centre.x);
    const sweep = Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)); // shortest span = the fillet
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 24))); // ~7.5° per segment
    const arc: Vec2[] = [];
    for (let step = 0; step <= steps; step++) {
      const angle = a1 + (sweep * step) / steps;
      arc.push({ x: centre.x + Math.cos(angle) * size.radius, y: centre.y + Math.sin(angle) * size.radius });
    }
    return arc;
  }
  const cutP = Math.min(size.d1, lenP), cutN = Math.min(size.d2, lenN);
  return [
    { x: V.x + uP.x * cutP, y: V.y + uP.y * cutP },
    { x: V.x + uN.x * cutN, y: V.y + uN.y * cutN },
  ];
}

/**
 * 2D chamfer/fillet. Both take two sides as input: two separate straight lines,
 * or two sides of one polyline. The two picked sides and their pick points
 * arrive in `data.first`/`data.second`; the size arrives as the step's value.
 */
export function apply2dCornerModification(run: CommandRun, rounded: boolean): StepOutcome {
  const { data, ctx } = run;
  const first = data.first as { entity: Entity; pick?: Vec2 } | undefined;
  const second = data.second as { entity: Entity; pick?: Vec2 } | undefined;
  if (!first || !second) { ctx.log('Select two sides first.'); return 'stay'; }

  if (first.entity.id === second.entity.id) {
    if (first.entity.type === 'polyline') return polylineCornerModification(run, first.entity, first.pick, second.pick, rounded);
    ctx.log(`${rounded ? 'FILLET' : 'CHAMFER'}: pick two different lines, or two sides of one polyline.`);
    return 'stay';
  }
  if (first.entity.type === 'line' && second.entity.type === 'line') {
    return twoLineCornerModification(run, first.entity, first.pick, second.entity, second.pick, rounded);
  }
  ctx.log(`${rounded ? 'FILLET' : 'CHAMFER'} needs two straight lines, or two sides of one polyline.`);
  return 'stay';
}

/**
 * A chamfer or fillet at the vertex two picked sides of one polyline share. The
 * polyline holds only straight segments, so a chamfer inserts the two cut points
 * and a fillet inserts a tessellated arc — the object stays one polyline, which
 * keeps a closed profile closed.
 */
function polylineCornerModification(run: CommandRun, polyline: PolylineEntity, pickA: Vec2 | undefined, pickB: Vec2 | undefined, rounded: boolean): StepOutcome {
  const { value, ctx } = run;
  const size = readCornerSize(value, rounded, ctx);
  if (!size) return 'stay';
  const ring = polylineRing(polyline);
  const len = ring.length;
  if (len < 3) { ctx.log('This polyline is too small to modify.'); return 'stay'; }

  const segA = nearestRingSegment(ring, polyline.closed, pickA ?? ring[0]);
  const segB = nearestRingSegment(ring, polyline.closed, pickB ?? ring[0]);
  if (segA === segB) { ctx.log(`${rounded ? 'FILLET' : 'CHAMFER'}: pick two different sides that meet at a corner.`); return 'stay'; }
  const setA = [segA, (segA + 1) % len], setB = [segB, (segB + 1) % len];
  const shared = setA.find((index) => setB.includes(index));
  if (shared === undefined) { ctx.log(`${rounded ? 'FILLET' : 'CHAMFER'}: the two sides do not meet at a corner.`); return 'stay'; }

  const V = ring[shared];
  const prev = ring[(shared - 1 + len) % len];
  const next = ring[(shared + 1) % len];
  const replacement = cornerReplacement(V, prev, next, size, rounded, ctx);
  if (!replacement) return 'stay';

  const newRing = [...ring.slice(0, shared), ...replacement, ...ring.slice(shared + 1)];
  const updated = cloneEntity(polyline) as PolylineEntity;
  updated.vertices = polyline.closed ? closePolyline(newRing) : newRing;
  ctx.history.execute(new UpdateEntityEdit(rounded ? 'Fillet' : 'Chamfer', polyline, updated));
  ctx.doc.selectEntity(updated.id);
  ctx.log(rounded ? `Fillet complete: R${size.radius.toFixed(3)} mm.` : `Chamfer complete: ${size.d1.toFixed(3)} × ${size.d2.toFixed(3)} mm.`);
  return 'advance';
}

/**
 * A 2D chamfer or fillet between two separate straight lines. Each line is
 * trimmed (or extended) back to the corner and a straight connector (chamfer)
 * or a tangent arc (fillet) is dropped in between; which side of each line is
 * kept is decided by where it was picked.
 */
function twoLineCornerModification(run: CommandRun, line1: LineEntity, pick1: Vec2 | undefined, line2: LineEntity, pick2: Vec2 | undefined, rounded: boolean): StepOutcome {
  const { value, ctx } = run;
  const size = readCornerSize(value, rounded, ctx);
  if (!size) return 'stay';
  const { radius, d1, d2 } = size;

  const meet = lineIntersectionParameters(line1.start, line1.end, line2.start, line2.end);
  if (!meet) { ctx.log(`${rounded ? 'FILLET' : 'CHAMFER'} failed: the two lines are parallel.`); return 'stay'; }
  const corner = meet.point;

  // The kept direction along each line runs from the corner toward the side that
  // was picked (or, with no pick, toward the farther endpoint).
  const keepDir = (line: LineEntity, pick: Vec2 | undefined): Vec2 | null => {
    const dx = line.end.x - line.start.x, dy = line.end.y - line.start.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return null;
    const unit = { x: dx / length, y: dy / length };
    const toward = pick ? dot(sub(pick, corner), unit)
      : Math.max(dot(sub(line.start, corner), unit), dot(sub(line.end, corner), unit));
    return toward >= 0 ? unit : { x: -unit.x, y: -unit.y };
  };
  const u1 = keepDir(line1, pick1);
  const u2 = keepDir(line2, pick2);
  if (!u1 || !u2) { ctx.log('Cannot use a zero-length line.'); return 'stay'; }

  // Move each line's corner-side endpoint (the one farther from the kept side)
  // onto the cut point; the picked side stays put.
  const trimToward = (line: LineEntity, keep: Vec2, target: Vec2): LineEntity => {
    const clone = cloneEntity(line) as LineEntity;
    const keepStart = dot(sub(clone.start, corner), keep) >= dot(sub(clone.end, corner), keep);
    if (keepStart) clone.end = target; else clone.start = target;
    return clone;
  };

  const style = (entity: Entity): void => {
    entity.workPlane = cloneEntity(line1).workPlane;
    entity.layer = line1.layer;
    entity.aci = line1.aci;
    entity.color = line1.color;
  };

  let point1: Vec2, point2: Vec2, connector: Entity | null = null;
  if (rounded) {
    const theta = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2)))); // corner angle on the kept side
    if (theta < 1e-4 || theta > Math.PI - 1e-4) { ctx.log('FILLET failed: the lines are collinear.'); return 'stay'; }
    if (radius < 1e-9) {
      point1 = point2 = corner; // R0 just closes the corner
    } else {
      const half = theta / 2;
      const tangent = radius / Math.tan(half);
      point1 = { x: corner.x + u1.x * tangent, y: corner.y + u1.y * tangent };
      point2 = { x: corner.x + u2.x * tangent, y: corner.y + u2.y * tangent };
      const bisector = { x: u1.x + u2.x, y: u1.y + u2.y };
      const blen = Math.hypot(bisector.x, bisector.y);
      const reach = radius / Math.sin(half);
      const centre = { x: corner.x + (bisector.x / blen) * reach, y: corner.y + (bisector.y / blen) * reach };
      const a1 = Math.atan2(point1.y - centre.y, point1.x - centre.x);
      const a2 = Math.atan2(point2.y - centre.y, point2.x - centre.x);
      const sweep = Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)); // shortest span = the fillet
      const arc = ctx.doc.createArc(centre, radius, a1, sweep);
      style(arc);
      connector = arc;
    }
  } else {
    point1 = { x: corner.x + u1.x * d1, y: corner.y + u1.y * d1 };
    point2 = { x: corner.x + u2.x * d2, y: corner.y + u2.y * d2 };
    if (dist2(point1, point2) > 1e-9) {
      const line = ctx.doc.createLine(point1, point2);
      style(line);
      connector = line;
    }
  }

  const updated1 = trimToward(line1, u1, point1);
  const updated2 = trimToward(line2, u2, point2);
  const added = connector ? [updated1, updated2, connector] : [updated1, updated2];
  ctx.history.execute(new ReplaceObjectsEdit(rounded ? 'Fillet' : 'Chamfer', [line1, line2], [], added, []));
  ctx.doc.selectEntity(updated1.id);
  ctx.doc.selectEntity(updated2.id, true);
  ctx.log(rounded
    ? `Fillet complete: R${radius.toFixed(3)} mm.`
    : `Chamfer complete: ${d1.toFixed(3)} × ${d2.toFixed(3)} mm.`);
  return 'advance';
}

export function offsetEntity({ active, data, value, ctx }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) {
    const entity = value as Entity;
    if (!isOffsetEntity(entity)) {
      ctx.log('OFFSET accepts lines, arcs, circles, ellipses, rectangles, and polylines.');
      return 'stay';
    }
    data.entity = entity;
    ctx.doc.selectEntity(entity.id);
    return 'advance';
  }
  if (active.stepIndex === 1) {
    const distance = Math.abs(value as number);
    if (distance < 1e-9) {
      ctx.log('Offset distance must be greater than zero.');
      return 'stay';
    }
    data.distance = distance;
    return 'advance';
  }

  const entity = data.entity as Entity;
  const sidePoint = value as Vec2;
  const distance = data.distance as number;
  // The last point says which side, so every shape asks it in its own terms:
  // which side of the line, in or out of the circle, in or out of the polygon.
  let parallel: Entity | null = null;
  if (entity.type === 'line') {
    const dx = entity.end.x - entity.start.x, dy = entity.end.y - entity.start.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) {
      ctx.log('Cannot offset a zero-length line.');
      return 'stay';
    }
    const centre = midpoint2(entity.start, entity.end);
    const sign = dx * (sidePoint.y - centre.y) - dy * (sidePoint.x - centre.x) >= 0 ? 1 : -1;
    const offset = { x: -dy / length * distance * sign, y: dx / length * distance * sign };
    parallel = ctx.doc.createLine(
      { x: entity.start.x + offset.x, y: entity.start.y + offset.y },
      { x: entity.end.x + offset.x, y: entity.end.y + offset.y },
    );
  } else if (entity.type === 'circle') {
    const outward = dist2(sidePoint, entity.center) >= entity.radius;
    const radius = entity.radius + (outward ? distance : -distance);
    if (radius <= 1e-6) {
      ctx.log('The inward offset is larger than the circle radius.');
      return 'stay';
    }
    parallel = ctx.doc.createCircle(entity.center, radius);
  } else if (entity.type === 'arc') {
    const outward = dist2(sidePoint, entity.center) >= entity.radius;
    const radius = entity.radius + (outward ? distance : -distance);
    if (radius <= 1e-6) {
      ctx.log('The inward offset is larger than the arc radius.');
      return 'stay';
    }
    parallel = ctx.doc.createArc(entity.center, radius, entity.startAngle, entity.sweepAngle);
  } else if (entity.type === 'ellipse') {
    // Unlike a circle, an ellipse offset at a constant distance is not itself
    // an ellipse — no closed form gives one — so it is sampled into a polygon
    // dense enough to look smooth and offset the same way a closed polyline is.
    const vertices = ellipsePoints(entity, 96).slice(0, -1);
    const outward = !pointInClosedPolygon(sidePoint, vertices);
    const offsetVertices = offsetPolygon(vertices, outward ? distance : -distance);
    if (!offsetVertices) {
      ctx.log('OFFSET failed for this shape and distance.');
      return 'stay';
    }
    parallel = ctx.doc.createPolyline(offsetVertices, true);
  } else if (entity.type === 'polyline' && !entity.closed) {
    const sign = openPolylineOffsetSign(entity.vertices, sidePoint);
    const offsetVertices = offsetOpenPolyline(entity.vertices, distance * sign);
    if (!offsetVertices) {
      ctx.log('OFFSET failed for this shape and distance.');
      return 'stay';
    }
    parallel = ctx.doc.createPolyline(offsetVertices, false);
  } else {
    const vertices = closedVertices(entity);
    if (!vertices) return 'stay';
    const outward = !pointInClosedPolygon(sidePoint, vertices);
    const offsetVertices = offsetPolygon(vertices, outward ? distance : -distance);
    if (!offsetVertices) {
      ctx.log('OFFSET failed for this shape and distance.');
      return 'stay';
    }
    parallel = entity.type === 'rectangle'
      ? ctx.doc.createRectangle(offsetVertices[0], offsetVertices[2])
      : ctx.doc.createPolyline(offsetVertices, true);
  }
  parallel.workPlane = cloneEntity(entity).workPlane;
  ctx.history.execute(new AddEntityEdit('Offset', parallel));
  ctx.doc.selectEntity(parallel.id);
  ctx.log(`Offset object created at ${distance.toFixed(3)} mm.`);
  return 'advance';
}

function perpendicularDistance(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return Math.hypot(point.x - a.x, point.y - a.y);
  return Math.abs(dy * point.x - dx * point.y + b.x * a.y - b.y * a.x) / length;
}

/**
 * Ramer–Douglas–Peucker: keeps a run's two ends, and recursively keeps
 * whichever interior point sits farthest from the straight line between
 * whatever currently bounds it, as long as that farthest point is still
 * outside `tolerance` — everything closer than that is redundant, since the
 * straight line already stands in for it within the asked-for accuracy.
 */
function simplifyRun(points: Vec2[], tolerance: number): Vec2[] {
  if (points.length < 3) return points;
  const start = points[0], end = points[points.length - 1];
  let maxDistance = 0;
  let splitIndex = -1;
  for (let index = 1; index < points.length - 1; index++) {
    const distance = perpendicularDistance(points[index], start, end);
    if (distance > maxDistance) { maxDistance = distance; splitIndex = index; }
  }
  if (maxDistance <= tolerance) return [start, end];
  const left = simplifyRun(points.slice(0, splitIndex + 1), tolerance);
  const right = simplifyRun(points.slice(splitIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

/**
 * The same reduction for a polyline, open or closed — a JOINed curve's own
 * problem, not just OFFSET's: two sampled Beziers leave dozens of points a
 * plotter, a G-code file or a saved project all have to carry for no visual
 * gain. A closed loop has no two ends to run Douglas-Peucker between, so it
 * is split at the vertex farthest from the first one — an approximate "far
 * side" — into two open runs, each simplified on its own and stitched back
 * into a loop.
 */
export function simplifyPolyline(vertices: Vec2[], tolerance: number, closed: boolean): Vec2[] {
  if (!closed) return simplifyRun(vertices, tolerance);
  const unique = vertices.length > 1 && dist2(vertices[0], vertices.at(-1)!) < 1e-9 ? vertices.slice(0, -1) : vertices;
  if (unique.length < 4) return closePolyline(unique);
  let splitIndex = 1;
  let maxDistanceSquared = 0;
  for (let index = 1; index < unique.length; index++) {
    const dx = unique[index].x - unique[0].x, dy = unique[index].y - unique[0].y;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared > maxDistanceSquared) { maxDistanceSquared = distanceSquared; splitIndex = index; }
  }
  const runA = simplifyRun(unique.slice(0, splitIndex + 1), tolerance);
  const runB = simplifyRun([...unique.slice(splitIndex), unique[0]], tolerance);
  return closePolyline([...runA.slice(0, -1), ...runB.slice(0, -1)]);
}

export function simplifyEntity({ active, data, value, ctx }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) {
    const entity = value as Entity;
    if (entity.type !== 'polyline') {
      ctx.log('SIMPLIFY accepts polylines.');
      return 'stay';
    }
    data.entity = entity;
    ctx.doc.selectEntity(entity.id);
    return 'advance';
  }
  const entity = data.entity as PolylineEntity;
  const tolerance = value as number;
  if (tolerance <= 0) {
    ctx.log('Tolerance must be greater than zero.');
    return 'stay';
  }
  const vertices = simplifyPolyline(entity.vertices, tolerance, entity.closed);
  const after: PolylineEntity = { ...cloneEntity(entity), vertices };
  ctx.history.execute(new ReplaceObjectsEdit('Simplify', [entity], [], [after], []));
  ctx.doc.selectEntity(after.id);
  ctx.log(`Simplified: ${entity.vertices.length} → ${vertices.length} vertices.`);
  return 'advance';
}

/** How close two ends must be to count as the same point, in millimetres. */
const JOIN_TOLERANCE = 0.5;

/** The points that walk an entity from one end to the other. */
function chainPoints(entity: Entity): Vec2[] {
  if (entity.type === 'line') return [{ ...entity.start }, { ...entity.end }];
  if (entity.type === 'arc' || entity.type === 'bezier') return curvePoints(entity, 48);
  if (entity.type === 'polyline') {
    return entity.closed ? closePolyline(entity.vertices).slice(0, -1) : [...entity.vertices];
  }
  return [];
}

/** A straight run, as the degenerate cubic that draws it exactly. */
function straightBezierSegment(start: Vec2, end: Vec2): BezierSegment {
  return {
    control1: { x: start.x + (end.x - start.x) / 3, y: start.y + (end.y - start.y) / 3 },
    control2: { x: start.x + (end.x - start.x) * 2 / 3, y: start.y + (end.y - start.y) * 2 / 3 },
    end,
  };
}

/**
 * The standard circular-arc-to-cubic-Bezier approximation (the same one SVG
 * and PDF renderers use for arcs): split into spans of at most 90°, each
 * matched to its arc by position and tangent at both ends, closely enough
 * that the difference is not something a plotter — or a JOINed exact-Bezier
 * neighbour it isn't allowed to look worse than — would ever show.
 */
function arcToBezierSegments(center: Vec2, radius: number, startAngle: number, sweepAngle: number): BezierSegment[] {
  const spanCount = Math.max(1, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2)));
  const step = sweepAngle / spanCount;
  const k = (4 / 3) * Math.tan(step / 4);
  const segments: BezierSegment[] = [];
  for (let index = 0; index < spanCount; index++) {
    const a0 = startAngle + step * index;
    const a1 = a0 + step;
    const p0 = { x: center.x + radius * Math.cos(a0), y: center.y + radius * Math.sin(a0) };
    const p3 = { x: center.x + radius * Math.cos(a1), y: center.y + radius * Math.sin(a1) };
    segments.push({
      control1: { x: p0.x - k * radius * Math.sin(a0), y: p0.y + k * radius * Math.cos(a0) },
      control2: { x: p3.x + k * radius * Math.sin(a1), y: p3.y - k * radius * Math.cos(a1) },
      end: p3,
    });
  }
  return segments;
}

/** Walking a Bezier chain backward reverses this same flat point list end to
 *  end — see the identical reasoning in OVERKILL's duplicate key. */
function reverseBezierChain(start: Vec2, segments: BezierSegment[]): { start: Vec2; segments: BezierSegment[] } {
  const points = [start, ...segments.flatMap((segment) => [segment.control1, segment.control2, segment.end])];
  const reversed = [...points].reverse();
  const reversedSegments: BezierSegment[] = [];
  for (let index = 1; index < reversed.length; index += 3) {
    reversedSegments.push({ control1: reversed[index], control2: reversed[index + 1], end: reversed[index + 2] });
  }
  return { start: reversed[0], segments: reversedSegments };
}

/**
 * One joined piece's exact Bezier equivalent, in world space and in the
 * direction the chain actually walks it — a line and an arc get an exact (or,
 * for the arc, all-but-exact) cubic form instead of the many sampled points
 * `chainPoints` uses for stitching the chain together in the first place; an
 * already-Bezier piece needs no conversion at all, only carrying through.
 */
function worldBezierSegments(
  entity: Extract<Entity, { type: 'line' | 'arc' | 'bezier' | 'polyline' }>,
  reversed: boolean,
): { start: Vec3; segments: Array<{ control1: Vec3; control2: Vec3; end: Vec3 }> } {
  const plane = entity.workPlane ?? WORLD_WORK_PLANE;
  const toWorld = (point: Vec2): Vec3 => localToWorld(plane, point, (point as Vec2 & { z?: number }).z ?? 0);
  let start: Vec2;
  let segments: BezierSegment[];
  if (entity.type === 'bezier') {
    start = entity.start;
    segments = entity.segments;
  } else if (entity.type === 'arc') {
    start = { x: entity.center.x + Math.cos(entity.startAngle) * entity.radius, y: entity.center.y + Math.sin(entity.startAngle) * entity.radius };
    segments = arcToBezierSegments(entity.center, entity.radius, entity.startAngle, entity.sweepAngle);
  } else if (entity.type === 'polyline') {
    const verts = entity.closed ? closePolyline(entity.vertices) : entity.vertices;
    start = verts[0];
    segments = verts.slice(1).map((point, index) => straightBezierSegment(verts[index], point));
  } else {
    start = entity.start;
    segments = [straightBezierSegment(entity.start, entity.end)];
  }
  const oriented = reversed ? reverseBezierChain(start, segments) : { start, segments };
  return {
    start: toWorld(oriented.start),
    segments: oriented.segments.map((segment) => ({
      control1: toWorld(segment.control1), control2: toWorld(segment.control2), end: toWorld(segment.end),
    })),
  };
}

export function joinObjects(run: CommandRun): StepOutcome {
  const { data, value, step, ctx } = run;
  if (step.kind === 'entity' && value) {
    const entity = value as Entity;
    if (entity.type !== 'line' && entity.type !== 'arc' && entity.type !== 'bezier' && entity.type !== 'polyline') {
      ctx.log('JOIN accepts line, polyline, arc, and Bezier objects.');
      return 'stay';
    }
    const entities = data.entities as Entity[];
    if (!entities.some((item) => item.id === entity.id)) {
      entities.push(entity);
      ctx.doc.selectEntity(entity.id, true);
    }
    ctx.log('Object added. Select another or press Enter.');
    return 'stay';
  }

  const lines = (data.entities as Entity[]).filter(
    (entity): entity is Extract<Entity, { type: 'line' | 'arc' | 'bezier' | 'polyline' }> =>
      entity.type === 'line' || entity.type === 'arc' || entity.type === 'bezier' || entity.type === 'polyline',
  );
  if (lines.length < 2) {
    ctx.log('JOIN requires at least two connected objects.');
    return 'stay';
  }
  // Work in world space, not each object's own plane: pieces drawn on different
  // faces/UCS meet where they physically touch, and the plane the result lives in
  // is fitted from the geometry — the two legs of an L in space share a plane
  // that is neither leg's own work plane.
  const worldChain = (entity: Entity): Vec3[] => {
    const plane = entity.workPlane ?? WORLD_WORK_PLANE;
    return chainPoints(entity).map((point) => localToWorld(plane, point, (point as Vec2 & { z?: number }).z ?? 0));
  };
  const sub3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const cross3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
  const len3 = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

  // Grows the chain from one end or the other, taking whichever piece touches
  // it next — so the objects can be picked in any order, which is how anyone
  // picks them.
  const near = (a: Vec3, b: Vec3): boolean => len3(sub3(a, b)) <= JOIN_TOLERANCE;
  const vertices: Vec3[] = worldChain(lines[0]);
  // Tracked alongside `vertices`, in the same order and the same end each
  // piece landed at — the exact Bezier reconstruction later needs the pieces
  // themselves, not only the points they were stitched together with.
  const orderedPieces: Array<{ entity: (typeof lines)[number]; reversed: boolean }> = [{ entity: lines[0], reversed: false }];
  const remaining = lines.slice(1);
  while (remaining.length > 0) {
    const start = vertices[0];
    const end = vertices[vertices.length - 1];
    const index = remaining.findIndex((candidate) => {
      const points = worldChain(candidate);
      return near(points[0], end) || near(points.at(-1)!, end) || near(points[0], start) || near(points.at(-1)!, start);
    });
    if (index < 0) {
      ctx.log('JOIN failed: the selected objects do not form one connected chain.');
      return 'stay';
    }
    const nextEntity = remaining.splice(index, 1)[0];
    const points = worldChain(nextEntity);
    const a = points[0], b = points.at(-1)!;
    if (near(a, end)) { vertices.push(...points.slice(1)); orderedPieces.push({ entity: nextEntity, reversed: false }); }
    else if (near(b, end)) { vertices.push(...points.slice(0, -1).reverse()); orderedPieces.push({ entity: nextEntity, reversed: true }); }
    else if (near(b, start)) { vertices.unshift(...points.slice(0, -1)); orderedPieces.unshift({ entity: nextEntity, reversed: false }); }
    else { vertices.unshift(...points.slice(1).reverse()); orderedPieces.unshift({ entity: nextEntity, reversed: true }); }
  }

  const closed = vertices.length > 2 && near(vertices[0], vertices[vertices.length - 1]);
  if (closed) vertices.pop();

  // Fit the plane the chain lies in: X along its first real leg, the normal the
  // widest turn away from that leg (so nearly-straight chains pick a stable one).
  const origin = vertices[0];
  let axis: Vec3 | null = null;
  for (let index = 1; index < vertices.length; index++) { const delta = sub3(vertices[index], origin); if (len3(delta) > 1e-9) { axis = delta; break; } }
  if (!axis) { ctx.log('JOIN failed: the objects have no length.'); return 'stay'; }
  let normal: Vec3 | null = null;
  let widest = 1e-9;
  for (const point of vertices) { const perp = cross3(axis, sub3(point, origin)); const length = len3(perp); if (length > widest) { widest = length; normal = perp; } }
  if (!normal) {
    // A straight chain lies in many planes; keep one that contains it.
    const up: Vec3 = Math.abs(axis.z) < 0.9 * len3(axis) ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    normal = cross3(axis, up);
  }
  const normalLength = len3(normal) || 1;
  if (vertices.some((point) => Math.abs(dot3(sub3(point, origin), normal!)) / normalLength > JOIN_TOLERANCE)) {
    ctx.log('JOIN requires all objects to lie in one plane.');
    return 'stay';
  }
  // A chain that already lies flat and parallel to the world XY plane — by far
  // the ordinary case, two 2D objects joined on the ground plane — needs no
  // work plane of its own: it can keep world coordinates directly, exactly
  // like every other plain 2D entity. That matters because grip dragging and
  // 2D grip hit-testing compare a grip's point straight against the mouse's
  // world position, with no work-plane transform in between; a chain whose
  // first leg does not run along world X still passes the "one plane" check
  // above yet would get a plane rotated to match that leg, and every grip on
  // it would then sit and drag in the wrong place, though the outline itself
  // still draws correctly (that one goes through the transform).
  const flat = Math.abs(normal.x) < 1e-6 * normalLength && Math.abs(normal.y) < 1e-6 * normalLength;
  const fittedPlane = flat ? null : workPlaneFromXAxis(origin, { x: origin.x + axis.x, y: origin.y + axis.y, z: origin.z + axis.z }, normal);
  const toLocal2d = (point: Vec3): Vec2 => {
    if (!fittedPlane) {
      const vertex: Vec2 & { z?: number } = { x: point.x, y: point.y };
      if (Math.abs(point.z) > 1e-9) vertex.z = point.z;
      return vertex;
    }
    const local = worldToLocal(fittedPlane, point);
    return { x: local.x, y: local.y };
  };
  const hasCurve = orderedPieces.some(({ entity }) => entity.type === 'arc' || entity.type === 'bezier');
  let joined: Entity;
  let noun: string;
  if (hasCurve) {
    // A line's or a polyline's straight runs go in as the exact degenerate
    // cubic that draws them; an arc goes in as its close cubic approximation;
    // a Bezier piece already selected needs no conversion at all. Flattening
    // every piece into 48 sampled points and calling it a polyline — which is
    // what a mixed chain like this used to become — is what this replaces.
    const worldSegments = orderedPieces.map(({ entity, reversed }) => worldBezierSegments(entity, reversed));
    joined = ctx.doc.createSpline(
      toLocal2d(worldSegments[0].start),
      worldSegments.flatMap((piece) => piece.segments.map((segment) => ({
        control1: toLocal2d(segment.control1), control2: toLocal2d(segment.control2), end: toLocal2d(segment.end),
      }))),
    );
    noun = 'spline';
  } else {
    joined = ctx.doc.createPolyline(vertices.map(toLocal2d), closed);
    noun = closed ? 'closed polyline' : 'polyline';
  }
  if (fittedPlane) joined.workPlane = fittedPlane;
  ctx.history.execute(new ReplaceObjectsEdit('Join', lines, [], [joined], []));
  ctx.doc.selectEntity(joined.id);
  ctx.log(`Joined ${lines.length} objects into one ${noun}.`);
  return 'advance';
}
