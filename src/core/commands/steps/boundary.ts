/**
 * BOUNDARY: the outline round a point, as one closed object.
 *
 * Click inside an area and the loop of drawn geometry that encloses it becomes
 * a closed polyline — arcs kept as arcs. The objects it was traced from are
 * left exactly as they were; this adds, it never edits.
 *
 * The tracing itself is `core/geometry/boundaryTrace`, which knows only lines
 * and arcs. This is the part that speaks the drawing's language: which entities
 * can bound an area, how each becomes pieces, and what plane the whole thing
 * happens in.
 */
import { AddEntityEdit } from '../../history/edits';
import { cloneWorkPlane, localToWorld, WORLD_WORK_PLANE, worldToLocal, type WorkPlane } from '../../../math/workplane';
import type { Vec2 } from '../../../math/geometry';
import { curvePoints, ellipsePoints, expandedInsertEntities, type Entity } from '../../entities/types';
import { bulgeArc, polylineSegments } from '../../entities/polylineArcs';
import { traceBoundary, type BoundaryPiece } from '../../geometry/boundaryTrace';
import type { CommandRun, StepOutcome } from '../types';

/**
 * Whether an entity's own plane is the one being worked in, near enough that
 * its points can be used as they stand.
 *
 * Deliberately strict: a boundary is a flat thing, and geometry drawn on a
 * plane tilted away from this one has no honest place in it. A plane parallel
 * to this one but shifted (which is how a 3D-snapped COPY leaves things) is
 * fine — its points still need converting, which `entityPieces` does through
 * the plane pair.
 */
function sharesPlane(entity: Entity, plane: WorkPlane, tolerance: number): boolean {
  const own = entity.workPlane ?? WORLD_WORK_PLANE;
  const parallel = Math.abs(own.zAxis.x * plane.zAxis.x + own.zAxis.y * plane.zAxis.y + own.zAxis.z * plane.zAxis.z);
  if (Math.abs(parallel - 1) > 1e-6) return false;
  const offset = worldToLocal(plane, own.origin).z;
  return Math.abs(offset) <= tolerance;
}

/** An entity as lines and arcs in `plane`'s own 2D frame, or nothing when it
 *  cannot bound an area (a point, a dimension, text). */
export function entityPieces(entity: Entity, plane: WorkPlane, tolerance: number): BoundaryPiece[] {
  const own = entity.workPlane ?? WORLD_WORK_PLANE;
  const to = (point: Vec2): Vec2 => {
    const local = worldToLocal(plane, localToWorld(own, point, (point as Vec2 & { z?: number }).z ?? 0));
    return { x: local.x, y: local.y };
  };
  /** An arc's own frame turns with its plane, so its angles are re-read from
   *  the converted centre and start point rather than carried across. */
  const arcIn = (center: Vec2, radius: number, startAngle: number, sweepAngle: number): BoundaryPiece => {
    const movedCenter = to(center);
    const start = to({ x: center.x + Math.cos(startAngle) * radius, y: center.y + Math.sin(startAngle) * radius });
    const mid = to({
      x: center.x + Math.cos(startAngle + sweepAngle / 2) * radius,
      y: center.y + Math.sin(startAngle + sweepAngle / 2) * radius,
    });
    const movedStart = Math.atan2(start.y - movedCenter.y, start.x - movedCenter.x);
    const movedMid = Math.atan2(mid.y - movedCenter.y, mid.x - movedCenter.x);
    // Which way it turns is decided by where its own middle landed, so a
    // mirrored plane reverses the sweep instead of drawing the other arc.
    const full = Math.PI * 2;
    const forward = ((movedMid - movedStart) % full + full) % full;
    const sign = forward <= Math.PI ? 1 : -1;
    return { kind: 'arc', center: movedCenter, radius, startAngle: movedStart, sweepAngle: sign * Math.abs(sweepAngle) };
  };
  const chain = (points: readonly Vec2[], closed: boolean): BoundaryPiece[] => {
    const pieces: BoundaryPiece[] = [];
    const count = closed ? points.length : points.length - 1;
    for (let index = 0; index < count; index++) {
      const start = to(points[index]), end = to(points[(index + 1) % points.length]);
      if (Math.hypot(end.x - start.x, end.y - start.y) > tolerance) pieces.push({ kind: 'line', start, end });
    }
    return pieces;
  };

  switch (entity.type) {
    case 'insert':
      return expandedInsertEntities(entity).flatMap((child) => entityPieces(child, plane, tolerance));
    case 'line':
      return chain([entity.start, entity.end], false);
    case 'rectangle':
      return chain([entity.first, { x: entity.opposite.x, y: entity.first.y }, entity.opposite, { x: entity.first.x, y: entity.opposite.y }], true);
    case 'octagon':
      return chain(entity.vertices, true);
    case 'mline':
      return chain(entity.vertices, entity.closed);
    case 'polyline': {
      const pieces: BoundaryPiece[] = [];
      for (const segment of polylineSegments(entity)) {
        const arc = bulgeArc(segment.start, segment.end, segment.bulge);
        if (arc) pieces.push(arcIn(arc.center, arc.radius, arc.startAngle, arc.sweepAngle));
        else pieces.push(...chain([segment.start, segment.end], false));
      }
      return pieces;
    }
    case 'arc':
      return [arcIn(entity.center, entity.radius, entity.startAngle, entity.sweepAngle)];
    case 'circle':
      // Two halves rather than one full turn: a closed piece has no ends for
      // the graph to hang on, and every crossing would have to split it anyway.
      return [
        arcIn(entity.center, entity.radius, 0, Math.PI),
        arcIn(entity.center, entity.radius, Math.PI, Math.PI),
      ];
    case 'ellipse':
      return chain(ellipsePoints(entity, 96).slice(0, -1), true);
    case 'bezier':
      return chain(curvePoints(entity, 96), false);
    default:
      // Points, text, dimensions and hatches bound nothing.
      return [];
  }
}

export function traceBoundaryAt(run: CommandRun): StepOutcome {
  const { ctx, value } = run;
  const plane = ctx.doc.activeWorkPlane;
  const inside = value as Vec2;
  // Scaled to the drawing, so the same tolerance works on a 3 mm part and a
  // 300 m site: two points a millionth of the drawing apart are the same point.
  const tolerance = drawingTolerance(ctx.doc.entities);

  const usable = ctx.doc.entities.filter((entity) => !ctx.doc.hiddenLayers.has(entity.layer));
  const offPlane = usable.filter((entity) => !sharesPlane(entity, plane, tolerance));
  const pieces = usable
    .filter((entity) => sharesPlane(entity, plane, tolerance))
    .flatMap((entity) => entityPieces(entity, plane, tolerance));
  if (pieces.length === 0) {
    ctx.log('BOUNDARY found nothing to trace on this plane.');
    return 'stay';
  }

  const traced = traceBoundary(pieces, inside, tolerance);
  if (!traced) {
    ctx.log('No enclosed area found at that point. Pick a point inside a closed region.');
    return 'stay';
  }

  const boundary = ctx.doc.createPolyline(traced.vertices, true);
  boundary.bulges = traced.bulges.some((bulge) => Math.abs(bulge) > 1e-9) ? traced.bulges : undefined;
  boundary.workPlane = cloneWorkPlane(plane);
  ctx.history.execute(new AddEntityEdit('Boundary', boundary));
  ctx.doc.selectEntity(boundary.id);
  const arcs = traced.bulges.filter((bulge) => Math.abs(bulge) > 1e-9).length;
  ctx.log(
    `Boundary created: closed polyline, ${traced.vertices.length} segment(s)${arcs ? `, ${arcs} of them arcs` : ''}`
    + `${offPlane.length ? `; ${offPlane.length} object(s) on another plane ignored` : ''}.`,
  );
  return 'advance';
}

/** A length small enough to be nothing and large enough to absorb the rounding
 *  in the drawing's own coordinates — a millionth of what it spans. */
export function drawingTolerance(entities: readonly Entity[]): number {
  let span = 0;
  for (const entity of entities) {
    for (const value of [entity.workPlane?.origin.x ?? 0, entity.workPlane?.origin.y ?? 0]) span = Math.max(span, Math.abs(value));
  }
  return Math.max(1e-7, span * 1e-6);
}
