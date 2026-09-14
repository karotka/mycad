import type { Vec2 } from '../../math/geometry';
import { localToWorld, type WorkPlane } from '../../math/workplane';
import { closedVertices, isClosedBezierEntity, type BezierEntity, type Entity, type PolylineEntity } from '../entities/types';
import { bulgeArc, hasPolylineArcs, polylineSegments } from '../entities/polylineArcs';
import type { Point3, SweepPathSegment3, SweepProfile3 } from './GeometryKernel';

/** Place an entity-local point in world space without discarding its elevation. */
export function entityKernelPoint(plane: WorkPlane, point: Vec2): Point3 {
  return localToWorld(plane, point, (point as Vec2 & { z?: number }).z ?? 0);
}

/** Convert an exact Bezier chain to the edge vocabulary understood by the kernel. */
export function bezierKernelEdges(
  entity: BezierEntity,
  toPoint: (point: Vec2) => Point3,
): SweepPathSegment3[] {
  let previous = toPoint(entity.start);
  return entity.segments.map((segment) => {
    const end = toPoint(segment.end);
    const edge: SweepPathSegment3 = {
      kind: 'bezier',
      poles: [previous, toPoint(segment.control1), toPoint(segment.control2), end],
    };
    previous = end;
    return edge;
  });
}

/** Convert a closed drawing entity to an exact sweep/loft profile. */
export function entityKernelProfile(entity: Entity, plane: WorkPlane): SweepProfile3 | null {
  if (entity.type === 'circle') {
    return {
      kind: 'circle',
      center: entityKernelPoint(plane, entity.center),
      normal: { ...plane.zAxis },
      xAxis: { ...plane.xAxis },
      radius: entity.radius,
    };
  }
  if (entity.type === 'bezier') {
    return isClosedBezierEntity(entity)
      ? { kind: 'wire', edges: bezierKernelEdges(entity, (point) => entityKernelPoint(plane, point)) }
      : null;
  }
  // A polyline with arc segments has to go to the kernel as a wire of real
  // arcs, not as a polygon of sampled points: a slot extruded from a polygon
  // gets a faceted end, and nothing downstream can ever recover the cylinder.
  if (entity.type === 'polyline' && entity.closed && hasPolylineArcs(entity)) {
    const edges = polylineKernelEdges(entity, plane);
    return edges && edges.length >= 2 ? { kind: 'wire', edges } : null;
  }
  const vertices = closedVertices(entity);
  return vertices && vertices.length >= 3
    ? { kind: 'polygon', points: vertices.map((point) => entityKernelPoint(plane, point)) }
    : null;
}

/** A polyline's segments as kernel edges: straight runs stay lines, bulged
 *  ones become true arcs on the entity's own plane. */
function polylineKernelEdges(entity: PolylineEntity, plane: WorkPlane): SweepPathSegment3[] | null {
  if (entity.vertices.length < 2) return null;
  const edges: SweepPathSegment3[] = [];
  for (const segment of polylineSegments(entity)) {
    const arc = bulgeArc(segment.start, segment.end, segment.bulge);
    if (arc) {
      edges.push({
        kind: 'arc',
        center: entityKernelPoint(plane, arc.center),
        normal: { ...plane.zAxis },
        xAxis: { ...plane.xAxis },
        radius: arc.radius,
        startAngle: arc.startAngle,
        sweepAngle: arc.sweepAngle,
      });
      continue;
    }
    const dz = ((segment.end as Vec2 & { z?: number }).z ?? 0) - ((segment.start as Vec2 & { z?: number }).z ?? 0);
    if (Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y, dz) <= 1e-9) continue;
    edges.push({
      kind: 'line',
      start: entityKernelPoint(plane, segment.start),
      end: entityKernelPoint(plane, segment.end),
    });
  }
  return edges.length > 0 ? edges : null;
}

/** Convert an open or closed drawing path to exact world-space kernel edges. */
export function entityKernelPath(entity: Entity, plane: WorkPlane): SweepPathSegment3[] | null {
  switch (entity.type) {
    case 'line':
      return [{
        kind: 'line',
        start: entityKernelPoint(plane, entity.start),
        end: entityKernelPoint(plane, entity.end),
      }];
    case 'polyline':
      return polylineKernelEdges(entity, plane);
    case 'arc':
      return [{
        kind: 'arc',
        center: entityKernelPoint(plane, entity.center),
        normal: { ...plane.zAxis },
        xAxis: { ...plane.xAxis },
        radius: entity.radius,
        startAngle: entity.startAngle,
        sweepAngle: entity.sweepAngle,
      }];
    case 'circle':
      return [{
        kind: 'arc',
        center: entityKernelPoint(plane, entity.center),
        normal: { ...plane.zAxis },
        xAxis: { ...plane.xAxis },
        radius: entity.radius,
        startAngle: 0,
        sweepAngle: Math.PI * 2,
      }];
    case 'bezier':
      return bezierKernelEdges(entity, (point) => entityKernelPoint(plane, point));
    default:
      return null;
  }
}
