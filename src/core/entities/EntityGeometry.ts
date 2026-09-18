import type { Vec2 } from '../../math/geometry';
import { polylineOutline } from './polylineArcs';
import type { ArcEntity, BezierEntity, BezierSegment, CircleEntity, EllipseEntity, LineEntity, PolylineEntity } from './types';

export interface EntityPath {
  points: Vec2[];
  /** The last point joins back to the first; callers choose how to render it. */
  closed: boolean;
}

export interface EntityBounds {
  min: Vec2;
  max: Vec2;
}

export type CanonicalPathEntity = LineEntity | PolylineEntity | CircleEntity | EllipseEntity | ArcEntity | BezierEntity;

export interface GeometryQuality {
  /** Maximum local distance between an analytic curve and its sampled chord. */
  curveTolerance: number;
  /** Lower bound for a whole circular/curved entity, not for every Bezier span. */
  minimumSegments: number;
  /** Safety ceiling; Bezier joins are always retained even when they exceed it. */
  maximumSegments: number;
}

export const DEFAULT_GEOMETRY_QUALITY: GeometryQuality = {
  curveTolerance: 0.05,
  minimumSegments: 64,
  maximumSegments: 2048,
};

export type GeometryQualityInput = number | Partial<GeometryQuality>;

function quality(input: GeometryQualityInput = {}): GeometryQuality {
  if (typeof input === 'number') {
    const segments = Math.max(1, Math.floor(input));
    return { ...DEFAULT_GEOMETRY_QUALITY, minimumSegments: segments, maximumSegments: segments };
  }
  const minimumSegments = Math.max(1, Math.floor(input.minimumSegments ?? DEFAULT_GEOMETRY_QUALITY.minimumSegments));
  return {
    curveTolerance: Math.max(1e-9, input.curveTolerance ?? DEFAULT_GEOMETRY_QUALITY.curveTolerance),
    minimumSegments,
    maximumSegments: Math.max(minimumSegments, Math.floor(input.maximumSegments ?? DEFAULT_GEOMETRY_QUALITY.maximumSegments)),
  };
}

const pointZ = (point: Vec2): number | undefined => (point as Vec2 & { z?: number }).z;
const withZ = (point: Vec2, z: number | undefined): Vec2 => z === undefined ? point : { ...point, z } as Vec2;

function ellipsePath(entity: EllipseEntity, segments: number): Vec2[] {
  const cos = Math.cos(entity.rotation), sin = Math.sin(entity.rotation);
  const z = pointZ(entity.center);
  return Array.from({ length: segments }, (_, index) => {
    const angle = Math.PI * 2 * index / segments;
    const x = Math.cos(angle) * entity.radiusX;
    const y = Math.sin(angle) * entity.radiusY;
    return withZ({
      x: entity.center.x + x * cos - y * sin,
      y: entity.center.y + x * sin + y * cos,
    }, z);
  });
}

function arcSegmentCount(entity: ArcEntity, settings: GeometryQuality): number {
  if (entity.radius <= 0 || Math.abs(entity.sweepAngle) <= 1e-12) return 1;
  const ratio = Math.min(1, settings.curveTolerance / entity.radius);
  const maximumAngle = 2 * Math.acos(1 - ratio);
  const needed = maximumAngle > 1e-12 ? Math.ceil(Math.abs(entity.sweepAngle) / maximumAngle) : settings.maximumSegments;
  return Math.min(settings.maximumSegments, Math.max(settings.minimumSegments, needed));
}

function arcPath(entity: ArcEntity, settings: GeometryQuality): Vec2[] {
  const segments = arcSegmentCount(entity, settings);
  const z = pointZ(entity.center);
  return Array.from({ length: segments + 1 }, (_, index) => {
    const angle = entity.startAngle + entity.sweepAngle * index / segments;
    return withZ({
      x: entity.center.x + Math.cos(angle) * entity.radius,
      y: entity.center.y + Math.sin(angle) * entity.radius,
    }, z);
  });
}

type LiftedPoint = Vec2 & { z?: number };

function cubicPoint(start: LiftedPoint, segment: BezierSegment, t: number): Vec2 {
  const u = 1 - t;
  const weights = [u ** 3, 3 * u * u * t, 3 * u * t * t, t ** 3];
  const controls = [start, segment.control1, segment.control2, segment.end] as LiftedPoint[];
  const point: Vec2 = {
    x: controls.reduce((sum, control, index) => sum + control.x * weights[index], 0),
    y: controls.reduce((sum, control, index) => sum + control.y * weights[index], 0),
  };
  if (controls.some((control) => control.z !== undefined)) {
    (point as LiftedPoint).z = controls.reduce((sum, control, index) => sum + (control.z ?? 0) * weights[index], 0);
  }
  return point;
}

function distanceToChord(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end.x - start.x, dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-24) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
}

function adaptiveBezierSpan(start: LiftedPoint, segment: BezierSegment, tolerance: number, maxDepth: number): Vec2[] {
  const points: Vec2[] = [{ ...start }];
  const visit = (fromT: number, from: Vec2, toT: number, to: Vec2, depth: number): void => {
    const midT = (fromT + toT) / 2;
    const mid = cubicPoint(start, segment, midT);
    const quarter = cubicPoint(start, segment, (fromT + midT) / 2);
    const threeQuarter = cubicPoint(start, segment, (midT + toT) / 2);
    const error = Math.max(
      distanceToChord(quarter, from, to),
      distanceToChord(mid, from, to),
      distanceToChord(threeQuarter, from, to),
    );
    if (depth >= maxDepth || error <= tolerance) {
      points.push(to);
      return;
    }
    visit(fromT, from, midT, mid, depth + 1);
    visit(midT, mid, toT, to, depth + 1);
  };
  visit(0, start, 1, segment.end, 0);
  return points;
}

function uniformBezierPath(entity: BezierEntity, segments: number): Vec2[] {
  if (entity.segments.length === 0) return [{ ...entity.start }];
  const perSpan = Math.max(1, Math.ceil(segments / entity.segments.length));
  const points: Vec2[] = [{ ...entity.start }];
  let start = entity.start;
  for (const segment of entity.segments) {
    for (let index = 1; index <= perSpan; index++) points.push(cubicPoint(start, segment, index / perSpan));
    start = segment.end;
  }
  return points;
}

function bezierPath(entity: BezierEntity, settings: GeometryQuality): Vec2[] {
  if (entity.segments.length === 0) return [];
  const maxPerSpan = Math.max(1, Math.floor(settings.maximumSegments / entity.segments.length));
  const maxDepth = Math.max(0, Math.floor(Math.log2(maxPerSpan)));
  const points: Vec2[] = [];
  let start = entity.start;
  for (const segment of entity.segments) {
    const span = adaptiveBezierSpan(start, segment, settings.curveTolerance, maxDepth);
    points.push(...(points.length === 0 ? span : span.slice(1)));
    start = segment.end;
  }
  return points.length - 1 >= settings.minimumSegments ? points : uniformBezierPath(entity, settings.minimumSegments);
}

/** Canonical sampled paths for display, projected picking and path export. */
export function canonicalEntityPaths(entity: CanonicalPathEntity, input: GeometryQualityInput = {}): EntityPath[] {
  const settings = quality(input);
  switch (entity.type) {
    case 'line':
      return [{ points: [entity.start, entity.end], closed: false }];
    case 'polyline': {
      const points = [...polylineOutline(entity)];
      return points.length >= 2 ? [{ points, closed: entity.closed }] : [];
    }
    case 'circle': {
      const z = pointZ(entity.center);
      return [{
        points: Array.from({ length: settings.minimumSegments }, (_, index) => {
          const angle = Math.PI * 2 * index / settings.minimumSegments;
          return withZ({
            x: entity.center.x + Math.cos(angle) * entity.radius,
            y: entity.center.y + Math.sin(angle) * entity.radius,
          }, z);
        }),
        closed: true,
      }];
    }
    case 'ellipse':
      return [{ points: ellipsePath(entity, settings.minimumSegments), closed: true }];
    case 'arc':
      return [{ points: arcPath(entity, settings), closed: false }];
    case 'bezier':
      {
        const points = bezierPath(entity, settings);
        return points.length >= 2 ? [{ points, closed: false }] : [];
      }
  }
}

/** Bounds of a path collection, or null when it contains no points. */
export function boundsFromPaths(paths: readonly EntityPath[]): EntityBounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let found = false;
  for (const path of paths) {
    for (const point of path.points) {
      found = true;
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  return found ? { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } } : null;
}

/** Exact bounds for analytic entities; path-derived bounds for line/polyline. */
export function canonicalEntityBounds(entity: CanonicalPathEntity): EntityBounds {
  if (entity.type === 'circle') return {
    min: { x: entity.center.x - entity.radius, y: entity.center.y - entity.radius },
    max: { x: entity.center.x + entity.radius, y: entity.center.y + entity.radius },
  };
  if (entity.type === 'ellipse') {
    const cos = Math.cos(entity.rotation), sin = Math.sin(entity.rotation);
    const halfWidth = Math.hypot(entity.radiusX * cos, entity.radiusY * sin);
    const halfHeight = Math.hypot(entity.radiusX * sin, entity.radiusY * cos);
    return {
      min: { x: entity.center.x - halfWidth, y: entity.center.y - halfHeight },
      max: { x: entity.center.x + halfWidth, y: entity.center.y + halfHeight },
    };
  }
  if (entity.type === 'arc') return arcBounds(entity);
  if (entity.type === 'bezier') return bezierBounds(entity);
  return boundsFromPaths(canonicalEntityPaths(entity))
    ?? ('start' in entity
      ? { min: { ...entity.start }, max: { ...entity.start } }
      : { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } });
}

function normalizedAngle(angle: number): number {
  const turn = Math.PI * 2;
  return ((angle % turn) + turn) % turn;
}

function angleOnArc(angle: number, start: number, sweep: number): boolean {
  if (Math.abs(sweep) >= Math.PI * 2 - 1e-12) return true;
  return sweep >= 0
    ? normalizedAngle(angle - start) <= sweep + 1e-12
    : normalizedAngle(start - angle) <= -sweep + 1e-12;
}

function arcBounds(entity: ArcEntity): EntityBounds {
  const angles = [entity.startAngle, entity.startAngle + entity.sweepAngle];
  for (const cardinal of [0, Math.PI / 2, Math.PI, Math.PI * 3 / 2]) {
    if (angleOnArc(cardinal, entity.startAngle, entity.sweepAngle)) angles.push(cardinal);
  }
  const points = angles.map((angle) => ({
    x: entity.center.x + Math.cos(angle) * entity.radius,
    y: entity.center.y + Math.sin(angle) * entity.radius,
  }));
  return boundsFromPaths([{ points, closed: false }])!;
}

function derivativeRoots(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  if (Math.abs(a) <= 1e-12) return Math.abs(b) <= 1e-12 ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  return [(-b + root) / (2 * a), (-b - root) / (2 * a)];
}

function bezierBounds(entity: BezierEntity): EntityBounds {
  if (entity.segments.length === 0) return { min: { ...entity.start }, max: { ...entity.start } };
  const points: Vec2[] = [{ ...entity.start }];
  let start = entity.start;
  for (const segment of entity.segments) {
    points.push(segment.end);
    const roots = [
      ...derivativeRoots(start.x, segment.control1.x, segment.control2.x, segment.end.x),
      ...derivativeRoots(start.y, segment.control1.y, segment.control2.y, segment.end.y),
    ];
    for (const t of roots) if (t > 0 && t < 1) points.push(cubicPoint(start, segment, t));
    start = segment.end;
  }
  return boundsFromPaths([{ points, closed: false }])!;
}
