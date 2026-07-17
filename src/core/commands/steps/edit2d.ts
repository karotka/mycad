/**
 * The 2D edits: trimming a line at a cutting edge, extending it to one, drawing
 * a parallel copy, and joining a chain into one polyline.
 *
 * The geometry they need travels with them, because nothing else uses it — it
 * had been sitting in the command manager, which is a place, not a home.
 */
import { AddEntityEdit, ReplaceObjectsEdit, UpdateEntityEdit } from '../../history/edits';
import { cloneEntity, closedVertices, curvePoints, isLineLikeEntity, isOffsetEntity, type Entity } from '../../entities/types';
import { closePolyline, dist2, midpoint2, type Vec2 } from '../../../math/geometry';
import { WORLD_WORK_PLANE } from '../../../math/workplane';
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

export function pointInClosedPolygon(point: Vec2, vertices: Vec2[]): boolean {
  let inside = false;
  for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index++) {
    const a = vertices[index], b = vertices[previous];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function offsetPolygon(vertices: Vec2[], distance: number): Vec2[] | null {
  if (vertices.length < 3) return null;
  let twiceArea = 0;
  for (let index = 0; index < vertices.length; index++) {
    const a = vertices[index], b = vertices[(index + 1) % vertices.length];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  if (Math.abs(twiceArea) < 1e-9) return null;
  const orientation = twiceArea > 0 ? 1 : -1;
  const shiftedEdges = vertices.map((start, index) => {
    const end = vertices[(index + 1) % vertices.length];
    const dx = end.x - start.x, dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return null;
    const normal = orientation > 0 ? { x: dy / length, y: -dx / length } : { x: -dy / length, y: dx / length };
    const offset = { x: normal.x * distance, y: normal.y * distance };
    return {
      start: { x: start.x + offset.x, y: start.y + offset.y },
      end: { x: end.x + offset.x, y: end.y + offset.y },
    };
  });
  if (shiftedEdges.some((edge) => !edge)) return null;
  const result: Vec2[] = [];
  for (let index = 0; index < vertices.length; index++) {
    const previous = shiftedEdges[(index - 1 + vertices.length) % vertices.length]!;
    const current = shiftedEdges[index]!;
    const intersection = lineIntersectionParameters(previous.start, previous.end, current.start, current.end);
    if (!intersection) return null;
    result.push(intersection.point);
  }
  return result;
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

  if (active.stepIndex === 0) {
    const boundary = value as Entity;
    if (!isLineLikeEntity(boundary)) {
      ctx.log(`${mode.toUpperCase()} ${trimming ? 'cutting edge' : 'boundary'} must be a line or polyline.`);
      return 'stay';
    }
    data.boundary = boundary;
    ctx.doc.selectEntity(boundary.id);
    return 'advance';
  }

  const boundary = data.boundary as Entity;
  const target = value as Entity;
  if (!isLineLikeEntity(boundary) || !isLineLikeEntity(target) || boundary.id === target.id) {
    ctx.log(`Select a different line or polyline to ${mode.toLowerCase()}.`);
    return 'stay';
  }
  if (!sameWorkPlane(boundary, target)) {
    ctx.log('Both lines must be on the same work plane.');
    return 'stay';
  }

  const click = data.targetPickPoint as Vec2 | undefined;
  const fallback = target.type === 'line' ? target.start : target.vertices[0] ?? { x: 0, y: 0 };
  const segment = nearestLineLikeSegment(target, click ?? fallback);
  // A trim needs a crossing within the segment; an extend needs one beyond it.
  // Both need the boundary's own segment to actually reach.
  const hits = collectLineLikeIntersections(segment, boundary).filter((hit) => {
    const within = hit.t >= -1e-8 && hit.t <= 1 + 1e-8;
    return (trimming ? within : !within) && hit.u >= -1e-8 && hit.u <= 1 + 1e-8;
  });
  if (hits.length === 0) {
    ctx.log(trimming
      ? 'TRIM failed: the line or polyline does not cross the cutting edge.'
      : 'EXTEND failed: the boundary does not intersect an extension of this line or polyline.');
    return 'stay';
  }
  const hit = click
    ? hits.reduce((best, candidate) => dist2(candidate.point, click) < dist2(best.point, click) ? candidate : best)
    : hits[0];

  // Where along the segment the click was, so the end nearer the click is the
  // one that moves — trimming takes off the side you pointed at, extending
  // reaches out from it.
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const lengthSquared = dx * dx + dy * dy;
  const clickT = click && lengthSquared > 1e-12
    ? ((click.x - segment.start.x) * dx + (click.y - segment.start.y) * dy) / lengthSquared
    : 1;
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
    ? `${noun} trimmed at cutting edge.`
    : `${noun} extended by ${Math.min(dist2(hit.point, segment.start), dist2(hit.point, segment.end)).toFixed(3)} mm.`);
  return 'advance';
}

export const trimEntity = (run: CommandRun): StepOutcome => cutOrStretch(run, 'Trim');
export const extendEntity = (run: CommandRun): StepOutcome => cutOrStretch(run, 'Extend');

export function offsetEntity({ active, data, value, ctx }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) {
    const entity = value as Entity;
    if (!isOffsetEntity(entity)) {
      ctx.log('OFFSET accepts lines, circles, rectangles, and closed polylines.');
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

  const lines = (data.entities as Entity[]).filter((entity) =>
    entity.type === 'line' || entity.type === 'arc' || entity.type === 'bezier' || entity.type === 'polyline');
  if (lines.length < 2) {
    ctx.log('JOIN requires at least two connected objects.');
    return 'stay';
  }
  const planeKey = (entity: Entity): string => JSON.stringify(entity.workPlane ?? WORLD_WORK_PLANE);
  if (lines.some((line) => planeKey(line) !== planeKey(lines[0]))) {
    ctx.log('JOIN requires all lines to be on the same work plane.');
    return 'stay';
  }

  // Grows the chain from one end or the other, taking whichever piece touches
  // it next — so the objects can be picked in any order, which is how anyone
  // picks them.
  const near = (a: Vec2, b: Vec2): boolean => dist2(a, b) <= JOIN_TOLERANCE;
  const vertices: Vec2[] = chainPoints(lines[0]);
  const remaining = lines.slice(1);
  while (remaining.length > 0) {
    const start = vertices[0];
    const end = vertices[vertices.length - 1];
    const index = remaining.findIndex((candidate) => {
      const points = chainPoints(candidate);
      return near(points[0], end) || near(points.at(-1)!, end) || near(points[0], start) || near(points.at(-1)!, start);
    });
    if (index < 0) {
      ctx.log('JOIN failed: the selected objects do not form one connected chain.');
      return 'stay';
    }
    const points = chainPoints(remaining.splice(index, 1)[0]);
    const a = points[0], b = points.at(-1)!;
    if (near(a, end)) vertices.push(...points.slice(1));
    else if (near(b, end)) vertices.push(...points.slice(0, -1).reverse());
    else if (near(b, start)) vertices.unshift(...points.slice(0, -1));
    else vertices.unshift(...points.slice(1).reverse());
  }

  const closed = vertices.length > 2 && near(vertices[0], vertices[vertices.length - 1]);
  if (closed) vertices.pop();
  const joined = ctx.doc.createPolyline(vertices, closed);
  joined.workPlane = cloneEntity(lines[0]).workPlane;
  ctx.history.execute(new ReplaceObjectsEdit('Join', lines, [], [joined], []));
  ctx.doc.selectEntity(joined.id);
  ctx.log(`Joined ${lines.length} objects into one ${closed ? 'closed ' : ''}polyline.`);
  return 'advance';
}
