/**
 * Any drawn shape as the spline that traces it.
 *
 * A line, an arc, a circle, a rectangle: each is exact as it stands, and that
 * exactness is why they are worth keeping — an arc holds its radius, a circle
 * its centre. What none of them can do is be reshaped: an arc's grips move its
 * ends and its centre, and that is all an arc is allowed to be. A spline can
 * be pulled anywhere, so turning one into the other is how a drawn shape stops
 * being a shape and starts being a curve.
 *
 * Straight runs come out as the degenerate cubic that draws them exactly;
 * round ones as the cubic that matches an arc of that angle, quarter turn by
 * quarter turn, which is right to under three parts in ten thousand of the
 * radius. Per-point elevation rides along, so a shape drawn through 3D keeps
 * its shape.
 */
import { lerpPoint, type Vec2 } from '../../math/geometry';
import { bulgeArc, polylineSegments } from './polylineArcs';
import { octagonVertices } from '../../math/geometry';
import type { BezierSegment, Entity } from './types';

export interface SplineGeometry {
  start: Vec2;
  segments: BezierSegment[];
}

/** The height a point carries, if it carries one. */
const elevation = (point: Vec2): number | undefined => (point as { z?: number }).z;

/** `point` at `source`'s own height — a generated point has none of its own. */
function at(point: Vec2, source: Vec2): Vec2 {
  const z = elevation(source);
  return z === undefined ? point : ({ ...point, z } as Vec2);
}

/** The exact cubic for a straight run: its controls a third and two thirds
 *  along, which draws the line and nothing else. */
function straightSegment(start: Vec2, end: Vec2): BezierSegment {
  return { control1: lerpPoint(start, end, 1 / 3), control2: lerpPoint(start, end, 2 / 3), end };
}

/** A chain of straight cubics through `points`, closing back to the first when
 *  asked — what a rectangle, an octagon and a straight polyline all are. */
function throughPoints(points: readonly Vec2[], closed: boolean): SplineGeometry | null {
  const walk = closed ? [...points, points[0]] : points;
  if (walk.length < 2) return null;
  return {
    start: walk[0],
    segments: walk.slice(1).map((point, index) => straightSegment(walk[index], point)),
  };
}

/**
 * An arc of `sweepAngle` about `center`, as quarter turns or less.
 *
 * The handle length is the one that makes a cubic match a circular arc of that
 * angle; at a quarter turn the familiar (4/3)·tan(θ/4)·R.
 */
function arcSegments(center: Vec2, radius: number, startAngle: number, sweepAngle: number): BezierSegment[] {
  const spans = Math.max(1, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2)));
  const step = sweepAngle / spans;
  const handle = (4 / 3) * Math.tan(step / 4) * radius;
  const segments: BezierSegment[] = [];
  for (let index = 0; index < spans; index++) {
    const a = startAngle + step * index;
    const b = a + step;
    const from = { x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius };
    const to = { x: center.x + Math.cos(b) * radius, y: center.y + Math.sin(b) * radius };
    segments.push({
      control1: at({ x: from.x - Math.sin(a) * handle, y: from.y + Math.cos(a) * handle }, center),
      control2: at({ x: to.x + Math.sin(b) * handle, y: to.y - Math.cos(b) * handle }, center),
      end: at(to, center),
    });
  }
  return segments;
}

/** An ellipse, as four quarters — the circle's own rule with each axis scaled
 *  and the whole thing turned by the ellipse's rotation. */
function ellipseSegments(
  center: Vec2, radiusX: number, radiusY: number, rotation: number,
): SplineGeometry | null {
  if (radiusX <= 0 || radiusY <= 0) return null;
  const cosine = Math.cos(rotation), sine = Math.sin(rotation);
  const place = (x: number, y: number): Vec2 =>
    at({ x: center.x + x * cosine - y * sine, y: center.y + x * sine + y * cosine }, center);
  const k = (4 / 3) * (Math.SQRT2 - 1);
  const corners = [
    { x: radiusX, y: 0 }, { x: 0, y: radiusY }, { x: -radiusX, y: 0 }, { x: 0, y: -radiusY },
  ];
  const tangents = [
    { x: 0, y: radiusY * k }, { x: -radiusX * k, y: 0 }, { x: 0, y: -radiusY * k }, { x: radiusX * k, y: 0 },
  ];
  const segments: BezierSegment[] = [];
  for (let index = 0; index < 4; index++) {
    const from = corners[index], to = corners[(index + 1) % 4];
    const out = tangents[index], into = tangents[(index + 1) % 4];
    segments.push({
      control1: place(from.x + out.x, from.y + out.y),
      control2: place(to.x - into.x, to.y - into.y),
      end: place(to.x, to.y),
    });
  }
  return { start: place(radiusX, 0), segments };
}

/** A polyline, arc segments and all — each bulge becomes the arc it stands for
 *  rather than the chord across it. */
function polylineGeometry(entity: Extract<Entity, { type: 'polyline' }>): SplineGeometry | null {
  const segments = polylineSegments(entity);
  if (segments.length === 0) return null;
  const chain: BezierSegment[] = [];
  for (const segment of segments) {
    const arc = bulgeArc(segment.start, segment.end, segment.bulge);
    if (!arc) { chain.push(straightSegment(segment.start, segment.end)); continue; }
    chain.push(...arcSegments(arc.center, arc.radius, arc.startAngle, arc.sweepAngle)
      .map((span, index, all) => (index === all.length - 1 ? { ...span, end: segment.end } : span)));
  }
  return { start: segments[0].start, segments: chain };
}

/** Whether this is a shape a spline can be made of. */
export function isSplineConvertible(entity: Entity): boolean {
  return ['line', 'arc', 'circle', 'ellipse', 'rectangle', 'octagon', 'polyline'].includes(entity.type);
}

/**
 * `entity` as the spline that traces it, in its own work plane — or null for
 * something a single curve cannot stand for (a block, a dimension, text) or
 * for one that has no length to trace.
 *
 * A Bezier comes back as itself rather than as null: asking for a spline of a
 * spline is not a mistake, it just has nothing to do.
 */
export function entityAsSpline(entity: Entity): SplineGeometry | null {
  switch (entity.type) {
    case 'bezier':
      return { start: entity.start, segments: entity.segments };
    case 'line':
      return { start: entity.start, segments: [straightSegment(entity.start, entity.end)] };
    case 'arc': {
      if (entity.radius <= 0 || Math.abs(entity.sweepAngle) < 1e-12) return null;
      const start = at({
        x: entity.center.x + Math.cos(entity.startAngle) * entity.radius,
        y: entity.center.y + Math.sin(entity.startAngle) * entity.radius,
      }, entity.center);
      return { start, segments: arcSegments(entity.center, entity.radius, entity.startAngle, entity.sweepAngle) };
    }
    case 'circle': {
      if (entity.radius <= 0) return null;
      const start = at({ x: entity.center.x + entity.radius, y: entity.center.y }, entity.center);
      const segments = arcSegments(entity.center, entity.radius, 0, Math.PI * 2);
      // Exactly back to where it started, so the ends meet to the last digit
      // rather than to the last rounding — which is how a closed curve is
      // recognised everywhere else.
      return { start, segments: segments.map((span, index, all) => (index === all.length - 1 ? { ...span, end: start } : span)) };
    }
    case 'ellipse':
      return ellipseSegments(entity.center, entity.radiusX, entity.radiusY, entity.rotation);
    case 'rectangle':
      return throughPoints([
        entity.first,
        at({ x: entity.opposite.x, y: entity.first.y }, entity.first),
        entity.opposite,
        at({ x: entity.first.x, y: entity.opposite.y }, entity.opposite),
      ], true);
    case 'octagon':
      return throughPoints(entity.vertices.length > 0 ? entity.vertices : octagonVertices(entity.center, entity.radius), true);
    case 'polyline':
      return polylineGeometry(entity);
    default:
      return null;
  }
}
