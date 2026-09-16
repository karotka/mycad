/**
 * Kernel curves as entities in the drawing.
 *
 * The other half of `KernelCurves`: that says what a B-rep edge IS, this puts
 * it on the sheet. Everything lands in world coordinates on the world plane,
 * carrying its own elevation — a section through a part is a shape in space,
 * not a shape on whatever UCS happened to be current.
 */
import type { KernelCurve } from '../geometry/KernelCurves';
import { cloneWorkPlane, WORLD_WORK_PLANE } from '../../math/workplane';
import type { Document } from '../Document';
import type { Entity } from './types';
import type { Vec2 } from '../../math/geometry';

/** A world point as the drawing stores one: x and y with its height alongside. */
const at = (point: { x: number; y: number; z: number }): Vec2 => ({ x: point.x, y: point.y, z: point.z } as Vec2);

/**
 * One curve as the entity that draws it, already added to nothing — the caller
 * decides whether it goes in through an edit or is thrown away.
 *
 * A circle that goes all the way round becomes a circle rather than an arc of
 * three hundred and sixty degrees, since that is the object anyone would
 * expect to snap a centre from.
 */
export function entityFromKernelCurve(doc: Document, curve: KernelCurve): Entity | null {
  const world = cloneWorkPlane(WORLD_WORK_PLANE);
  if (curve.kind === 'line') {
    const line = doc.createLine(at(curve.start), at(curve.end));
    line.workPlane = world;
    return line;
  }
  if (curve.kind === 'arc') {
    // An arc lives in the plane of its own circle, which is rarely the world's
    // — its centre, normal and reference direction ARE that plane, so the
    // entity is given it rather than being flattened into world x and y.
    const plane = {
      origin: { ...curve.center },
      xAxis: { ...curve.xAxis },
      yAxis: {
        x: curve.normal.y * curve.xAxis.z - curve.normal.z * curve.xAxis.y,
        y: curve.normal.z * curve.xAxis.x - curve.normal.x * curve.xAxis.z,
        z: curve.normal.x * curve.xAxis.y - curve.normal.y * curve.xAxis.x,
      },
      zAxis: { ...curve.normal },
    };
    const full = Math.abs(Math.abs(curve.sweepAngle) - Math.PI * 2) < 1e-9;
    const entity = full
      ? doc.createCircle({ x: 0, y: 0 }, curve.radius)
      : doc.createArc({ x: 0, y: 0 }, curve.radius, curve.startAngle, curve.sweepAngle);
    entity.workPlane = plane;
    return entity;
  }
  if (curve.segments.length === 0) return null;
  const spline = doc.createSpline(at(curve.start), curve.segments.map((segment) => ({
    control1: at(segment.control1),
    control2: at(segment.control2),
    end: at(segment.end),
  })));
  spline.workPlane = world;
  return spline;
}

/** Every curve that could be drawn, in order. */
export function entitiesFromKernelCurves(doc: Document, curves: readonly KernelCurve[]): Entity[] {
  return curves.map((curve) => entityFromKernelCurve(doc, curve)).filter((entity): entity is Entity => entity !== null);
}
