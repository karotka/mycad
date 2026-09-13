import type { Vec2 } from '../../math/geometry';
import { localToWorld, type WorkPlane } from '../../math/workplane';
import { closedVertices, isClosedBezierEntity, type BezierEntity, type Entity } from '../entities/types';
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
  const vertices = closedVertices(entity);
  return vertices && vertices.length >= 3
    ? { kind: 'polygon', points: vertices.map((point) => entityKernelPoint(plane, point)) }
    : null;
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
    case 'polyline': {
      if (entity.vertices.length < 2) return null;
      const segments: SweepPathSegment3[] = [];
      const count = entity.closed ? entity.vertices.length : entity.vertices.length - 1;
      for (let index = 0; index < count; index++) {
        const start = entity.vertices[index];
        const end = entity.vertices[(index + 1) % entity.vertices.length];
        const dz = ((end as Vec2 & { z?: number }).z ?? 0) - ((start as Vec2 & { z?: number }).z ?? 0);
        if (Math.hypot(end.x - start.x, end.y - start.y, dz) <= 1e-9) continue;
        segments.push({
          kind: 'line',
          start: entityKernelPoint(plane, start),
          end: entityKernelPoint(plane, end),
        });
      }
      return segments.length > 0 ? segments : null;
    }
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
