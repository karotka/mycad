import { dist2, type Vec2, type Vec3 } from '../../math/geometry';
import type { WorkPlane } from '../../math/workplane';
import { isStrokeFont, strokeTextWidth } from '../text/strokeFont';

export type EntityType = 'line' | 'circle' | 'ellipse' | 'rectangle' | 'octagon' | 'polyline' | 'arc' | 'bezier' | 'text' | 'dimension';

export interface EntityBase {
  id: string;
  type: EntityType;
  layer: string;
  color: number;
  selected: boolean;
  workPlane?: WorkPlane;
}

export interface LineEntity extends EntityBase {
  type: 'line';
  start: Vec2;
  end: Vec2;
}

export interface CircleEntity extends EntityBase {
  type: 'circle';
  center: Vec2;
  radius: number;
}

/** An axis-aligned ellipse turned by `rotation` (radians) about its centre. */
export interface EllipseEntity extends EntityBase {
  type: 'ellipse';
  center: Vec2;
  /** Semi-axis along the ellipse's own X, before rotation. */
  radiusX: number;
  /** Semi-axis along the ellipse's own Y, before rotation. */
  radiusY: number;
  rotation: number;
}

export interface RectangleEntity extends EntityBase {
  type: 'rectangle';
  first: Vec2;
  opposite: Vec2;
}

export interface OctagonEntity extends EntityBase {
  type: 'octagon';
  center: Vec2;
  radius: number;
  vertices: Vec2[];
}

export interface PolylineEntity extends EntityBase {
  type: 'polyline';
  vertices: Vec2[];
  closed: boolean;
}
export interface ArcEntity extends EntityBase { type: 'arc'; center: Vec2; radius: number; startAngle: number; sweepAngle: number; }
export interface BezierEntity extends EntityBase { type: 'bezier'; start: Vec2; control1: Vec2; control2: Vec2; end: Vec2; }
export interface TextEntity extends EntityBase { type: 'text'; position: Vec2; text: string; height: number; font?: string; rotation?: number; }
export interface DimensionEntity extends EntityBase {
  type: 'dimension';
  /**
   * `linear` measures along its own `rotation` — the horizontal or vertical
   * distance, which is what a drawing usually wants. `aligned` measures the true
   * point-to-point distance, which is the diagonal.
   */
  dimensionKind: 'linear' | 'aligned' | 'radius' | 'diameter';
  start: Vec2;
  end: Vec2;
  offset: Vec2;
  textHeight: number;
  arrowSize: number;
  arrowType: 'closed' | 'open' | 'tick';
  extensionBeyond: number;
  extensionOffset: number;
  textOffset: number;
  precision: number;
  scale: number;
  /** The direction a `linear` dimension measures along, in radians. Ignored by the rest. */
  rotation?: number;
  /**
   * Where the text was dragged to. Left out, it sits centred and clear of the
   * dimension line, which is what a dimension with room for it wants. A short
   * one has no such room, hence the override.
   */
  textPosition?: Vec2;
}

export type Entity = LineEntity | CircleEntity | EllipseEntity | RectangleEntity | OctagonEntity | PolylineEntity | ArcEntity | BezierEntity | TextEntity | DimensionEntity;

export interface DimensionGeometry {
  extensionStart: [Vec2, Vec2];
  extensionEnd: [Vec2, Vec2];
  dimensionLine: [Vec2, Vec2];
  arrows: Array<[Vec2, Vec2, Vec2]>;
  textPoint: Vec2;
  textAngle: number;
  text: string;
}

export function dimensionGeometry(entity: DimensionEntity): DimensionGeometry {
  const dx = entity.end.x - entity.start.x, dy = entity.end.y - entity.start.y;
  const span = Math.hypot(dx, dy);
  // Every kind is the same construction, differing only in which way the
  // dimension line runs: a linear one runs along its own rotation, and the rest
  // run from start to end. An aligned dimension is that with the direction taken
  // from the points, which is why there is no separate case for it.
  const linear = entity.dimensionKind === 'linear';
  const direction = linear ? entity.rotation ?? 0 : Math.atan2(dy, dx);
  // Taken from the points rather than from the angle where it can be: dx / span
  // is exact for an axis-aligned dimension, where cos(atan2(...)) is 6e-17.
  const ux = linear ? Math.cos(direction) : (span > 1e-9 ? dx / span : 1);
  const uy = linear ? Math.sin(direction) : (span > 1e-9 ? dy / span : 0);
  const nx = -uy, ny = ux;
  // What it reads: how far the points are apart *along the dimension line*. For
  // an aligned one that is the full distance; for a linear one it is the leg.
  const length = Math.abs(dx * ux + dy * uy);
  // Each end reaches the dimension line by its own distance, because the line
  // runs through `offset` in direction u — it is not the pair of points shifted
  // sideways. The two agree only when u is the direction from start to end, so
  // an aligned dimension cannot tell the difference and a linear one across a
  // slope comes out running parallel to the slope: no longer level, and no
  // longer reading the leg it drew.
  const offsetA = (entity.offset.x - entity.start.x) * nx + (entity.offset.y - entity.start.y) * ny;
  const offsetB = (entity.offset.x - entity.end.x) * nx + (entity.offset.y - entity.end.y) * ny;
  const a = { x: entity.start.x + nx * offsetA, y: entity.start.y + ny * offsetA };
  const b = { x: entity.end.x + nx * offsetB, y: entity.end.y + ny * offsetB };
  // Which way each extension line grows, and each is asked separately: a
  // dimension line drawn between its points has one reaching up and one down.
  const sideA = offsetA < 0 ? -1 : 1;
  const sideB = offsetB < 0 ? -1 : 1;
  // The text sits clear of the dimension line, away from the points. With the
  // line drawn between them there is no such side, so it takes the start's.
  const textSide = sideA;
  const extensionA: Vec2 = { x: a.x + nx * sideA * entity.extensionBeyond * entity.scale, y: a.y + ny * sideA * entity.extensionBeyond * entity.scale };
  const extensionB: Vec2 = { x: b.x + nx * sideB * entity.extensionBeyond * entity.scale, y: b.y + ny * sideB * entity.extensionBeyond * entity.scale };
  const gapA: Vec2 = { x: entity.start.x + nx * sideA * entity.extensionOffset * entity.scale, y: entity.start.y + ny * sideA * entity.extensionOffset * entity.scale };
  const gapB: Vec2 = { x: entity.end.x + nx * sideB * entity.extensionOffset * entity.scale, y: entity.end.y + ny * sideB * entity.extensionOffset * entity.scale };
  const arrow = entity.arrowSize * entity.scale;
  const wing = arrow * 0.36;
  const textClearance = (entity.textOffset + entity.textHeight / 2) * entity.scale;
  let textAngle = direction;
  if (textAngle >= Math.PI / 2) textAngle -= Math.PI;
  else if (textAngle < -Math.PI / 2) textAngle += Math.PI;
  const triangle = (tip: Vec2, direction: number): [Vec2, Vec2, Vec2] => [
    tip,
    entity.arrowType === 'tick'
      ? { x: tip.x - ux * arrow * 0.45 + nx * arrow * 0.45, y: tip.y - uy * arrow * 0.45 + ny * arrow * 0.45 }
      : { x: tip.x + ux * arrow * direction + nx * wing, y: tip.y + uy * arrow * direction + ny * wing },
    entity.arrowType === 'tick'
      ? { x: tip.x + ux * arrow * 0.45 - nx * arrow * 0.45, y: tip.y + uy * arrow * 0.45 - ny * arrow * 0.45 }
      : { x: tip.x + ux * arrow * direction - nx * wing, y: tip.y + uy * arrow * direction - ny * wing },
  ];
  if (entity.dimensionKind === 'radius') {
    return {
      extensionStart: [entity.start, entity.start], extensionEnd: [entity.end, entity.end],
      dimensionLine: [entity.start, entity.offset], arrows: [triangle(entity.end, -1)],
      textPoint: entity.offset, textAngle: 0, text: `R${span.toFixed(entity.precision)}`,
    };
  }
  if (entity.dimensionKind === 'diameter') {
    const opposite = { x: entity.start.x - dx, y: entity.start.y - dy };
    return {
      extensionStart: [opposite, opposite], extensionEnd: [entity.end, entity.end],
      dimensionLine: [opposite, entity.end], arrows: [triangle(opposite, 1), triangle(entity.end, -1)],
      textPoint: entity.offset, textAngle: 0, text: `\u00d8${(span * 2).toFixed(entity.precision)}`,
    };
  }
  return {
    extensionStart: [gapA, extensionA], extensionEnd: [gapB, extensionB], dimensionLine: [a, b],
    arrows: [triangle(a, 1), triangle(b, -1)],
    textPoint: entity.textPosition ?? {
      x: (a.x + b.x) / 2 + nx * textSide * textClearance,
      y: (a.y + b.y) / 2 + ny * textSide * textClearance,
    },
    textAngle, text: length.toFixed(entity.precision),
  };
}

export function linearDimensionRotation(start: Vec2, end: Vec2, offset: Vec2): number {
  // A leg of zero has nothing to dimension, so the other one is the only answer
  // there is: an axis-aligned line always reads its own length.
  if (Math.abs(end.y - start.y) <= 1e-9) return 0;
  if (Math.abs(end.x - start.x) <= 1e-9) return Math.PI / 2;

  // Otherwise it is where the dimension line was pulled *past the points*: above
  // or below them reads across, beside them reads up. Measuring from their
  // midpoint instead would make a point that is merely far along the line look
  // like it was pulled sideways.
  const beyond = (value: number, low: number, high: number): number =>
    Math.max(low - value, value - high, 0);
  const outsideX = beyond(offset.x, Math.min(start.x, end.x), Math.max(start.x, end.x));
  const outsideY = beyond(offset.y, Math.min(start.y, end.y), Math.max(start.y, end.y));
  return outsideX > outsideY ? Math.PI / 2 : 0;
}

/** Samples a rotated ellipse; `segments` points around it, first point repeated last. */
export function ellipsePoints(e: EllipseEntity, segments = 64): Vec2[] {
  const cos = Math.cos(e.rotation), sin = Math.sin(e.rotation);
  const points: Vec2[] = [];
  for (let index = 0; index <= segments; index++) {
    const t = (Math.PI * 2 * index) / segments;
    const x = Math.cos(t) * e.radiusX;
    const y = Math.sin(t) * e.radiusY;
    points.push({ x: e.center.x + x * cos - y * sin, y: e.center.y + x * sin + y * cos });
  }
  return points;
}

/** The four axis endpoints, in world space — the ellipse's own quadrant points. */
export function ellipseAxisPoints(e: EllipseEntity): Vec2[] {
  const cos = Math.cos(e.rotation), sin = Math.sin(e.rotation);
  const at = (x: number, y: number): Vec2 => ({ x: e.center.x + x * cos - y * sin, y: e.center.y + x * sin + y * cos });
  return [at(e.radiusX, 0), at(0, e.radiusY), at(-e.radiusX, 0), at(0, -e.radiusY)];
}

export function curvePoints(e: ArcEntity | BezierEntity, segments = 64): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    if (e.type === 'arc') {
      const a = e.startAngle + e.sweepAngle * t;
      points.push({ x: e.center.x + Math.cos(a) * e.radius, y: e.center.y + Math.sin(a) * e.radius });
    } else {
      const u = 1 - t;
      points.push({ x: u ** 3 * e.start.x + 3 * u ** 2 * t * e.control1.x + 3 * u * t ** 2 * e.control2.x + t ** 3 * e.end.x, y: u ** 3 * e.start.y + 3 * u ** 2 * t * e.control1.y + 3 * u * t ** 2 * e.control2.y + t ** 3 * e.end.y });
    }
  }
  return points;
}

export interface SolidMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface SolidFaceSelection {
  solidId: string;
  vertexIndices: number[];
  normal: Vec3;
}

export interface SolidEdgeSelection {
  solidId: string;
  start: Vec3;
  end: Vec3;
  normalA: Vec3;
  normalB: Vec3;
}

export interface ExtrusionFeature {
  kind: 'extrusion';
  profile: Entity;
  height: number;
  workPlane?: WorkPlane;
  transform: {
    translateX: number;
    translateY: number;
    scaleX: number;
    scaleY: number;
    translateZ?: number;
  };
}

export interface BooleanFeature {
  kind: 'boolean';
  operation: 'union' | 'subtract';
  operands: SolidFeature[];
}

export interface SweepFeature {
  kind: 'sweep';
  profile: Entity;
  path: Entity;
  workPlane?: WorkPlane;
}

export interface MeshFeature {
  kind: 'mesh';
}

export interface PrimitiveFeature {
  kind: 'primitive';
  primitive: 'box' | 'wedge' | 'sphere' | 'cone' | 'cylinder' | 'pyramid' | 'torus';
  center: Vec2;
  width?: number;
  depth?: number;
  radius?: number;
  /** Minor radius of a torus; `radius` is the distance from centre to tube centre. */
  tubeRadius?: number;
  /**
   * The far radius of a cone, cutting its point off: absent or 0 is a cone,
   * anything else a frustum. `radius` is the one at the work plane.
   */
  radiusTop?: number;
  height: number;
  /**
   * Stretches the primitive along its own axes before the work plane places it.
   * A sphere with a scale is an ellipsoid — the shape most rounded things
   * actually are, and the one no primitive here draws. Without it an egg costs
   * forty spheres unioned into a blob.
   *
   * Applied in the primitive's own frame, about the work plane origin: for a
   * sphere at center {0,0} that is its centre, and for a cylinder it is the
   * middle of the base, so scaling z lengthens it away from there.
   */
  scale?: Vec3;
  workPlane?: WorkPlane;
}

export type SolidFeature = ExtrusionFeature | BooleanFeature | SweepFeature | PrimitiveFeature | MeshFeature;

export interface Solid {
  id: string;
  name: string;
  layer: string;
  mesh: SolidMesh;
  color: number;
  selected: boolean;
  height: number;
  sourceEntityIds: string[];
  feature: SolidFeature;
  revision: number;
}

let nextId = 1;
export function genId(prefix = 'e'): string {
  return `${prefix}_${nextId++}`;
}

export function resetIdCounter(): void {
  nextId = 1;
}

export function cloneEntity(e: Entity): Entity {
  return JSON.parse(JSON.stringify(e));
}

export function entityBounds(e: Entity): { min: Vec2; max: Vec2 } {
  switch (e.type) {
    case 'ellipse': {
      // Exact extent of a rotated ellipse.
      const cos = Math.cos(e.rotation), sin = Math.sin(e.rotation);
      const halfWidth = Math.hypot(e.radiusX * cos, e.radiusY * sin);
      const halfHeight = Math.hypot(e.radiusX * sin, e.radiusY * cos);
      return {
        min: { x: e.center.x - halfWidth, y: e.center.y - halfHeight },
        max: { x: e.center.x + halfWidth, y: e.center.y + halfHeight },
      };
    }
    case 'line':
      return {
        min: { x: Math.min(e.start.x, e.end.x), y: Math.min(e.start.y, e.end.y) },
        max: { x: Math.max(e.start.x, e.end.x), y: Math.max(e.start.y, e.end.y) },
      };
    case 'circle':
      return {
        min: { x: e.center.x - e.radius, y: e.center.y - e.radius },
        max: { x: e.center.x + e.radius, y: e.center.y + e.radius },
      };
    case 'rectangle':
      return {
        min: { x: Math.min(e.first.x, e.opposite.x), y: Math.min(e.first.y, e.opposite.y) },
        max: { x: Math.max(e.first.x, e.opposite.x), y: Math.max(e.first.y, e.opposite.y) },
      };
    case 'octagon': {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const v of e.vertices) {
        minX = Math.min(minX, v.x);
        minY = Math.min(minY, v.y);
        maxX = Math.max(maxX, v.x);
        maxY = Math.max(maxY, v.y);
      }
      return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
    }
    case 'polyline': {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const v of e.vertices) {
        minX = Math.min(minX, v.x);
        minY = Math.min(minY, v.y);
        maxX = Math.max(maxX, v.x);
        maxY = Math.max(maxY, v.y);
      }
      return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
    }
    case 'arc':
    case 'bezier': { const p = curvePoints(e); return { min: { x: Math.min(...p.map(v => v.x)), y: Math.min(...p.map(v => v.y)) }, max: { x: Math.max(...p.map(v => v.x)), y: Math.max(...p.map(v => v.y)) } }; }
    case 'text': {
      // A stroke font knows its own width exactly, so the box is the letters
      // rather than a guess at them — which is what picking and zoom-extents
      // work off. The .62 stays for system fonts, where measuring the glyphs
      // needs a canvas this has no business holding.
      const width = isStrokeFont(e.font) ? strokeTextWidth(e.text, e.height) : e.text.length * e.height * .62;
      const angle = e.rotation ?? 0;
      const rotate = (point: Vec2): Vec2 => ({
        x: e.position.x + point.x * Math.cos(angle) - point.y * Math.sin(angle),
        y: e.position.y + point.x * Math.sin(angle) + point.y * Math.cos(angle),
      });
      const points = [rotate({ x: 0, y: 0 }), rotate({ x: width, y: 0 }), rotate({ x: width, y: e.height }), rotate({ x: 0, y: e.height })];
      return {
        min: { x: Math.min(...points.map((point) => point.x)), y: Math.min(...points.map((point) => point.y)) },
        max: { x: Math.max(...points.map((point) => point.x)), y: Math.max(...points.map((point) => point.y)) },
      };
    }
    case 'dimension': {
      const geometry = dimensionGeometry(e);
      const points = [e.start, e.end, ...geometry.dimensionLine, ...geometry.arrows.flat()];
      return { min: { x: Math.min(...points.map(p => p.x)), y: Math.min(...points.map(p => p.y)) }, max: { x: Math.max(...points.map(p => p.x)), y: Math.max(...points.map(p => p.y)) } };
    }
  }
}

/**
 * The corners of an entity that encloses an area, without the repeated closing
 * point — or null for one that does not enclose anything. A rectangle keeps its
 * corners implicit and an octagon keeps them explicit, so asking each in its own
 * words is what this saves the caller.
 */
export function closedVertices(entity: Entity): Vec2[] | null {
  if (entity.type === 'rectangle') return [
    entity.first,
    { x: entity.opposite.x, y: entity.first.y },
    entity.opposite,
    { x: entity.first.x, y: entity.opposite.y },
  ];
  if (entity.type === 'octagon') return entity.vertices.map((point) => ({ ...point }));
  if (entity.type === 'polyline' && entity.closed) {
    const vertices = entity.vertices.map((point) => ({ ...point }));
    if (vertices.length > 1 && dist2(vertices[0], vertices.at(-1)!) < 1e-9) vertices.pop();
    return vertices;
  }
  return null;
}

export function getEntityPoints(e: Entity): Vec2[] {
  switch (e.type) {
    case 'line':
      return [e.start, e.end];
    case 'circle':
    case 'ellipse':
      return [e.center];
    case 'rectangle':
      return [
        e.first,
        { x: e.opposite.x, y: e.first.y },
        e.opposite,
        { x: e.first.x, y: e.opposite.y },
      ];
    case 'octagon':
      return e.vertices;
    case 'polyline':
      return e.vertices;
    case 'arc': return [e.center, ...curvePoints(e, 2)];
    case 'bezier': return [e.start, e.control1, e.control2, e.end];
    case 'text': return [e.position];
    case 'dimension': return [e.start, e.end, e.offset];
  }
}

export function transformEntityPoints(e: Entity, fn: (p: Vec2) => Vec2): Entity {
  const copy = cloneEntity(e);
  switch (copy.type) {
    case 'line':
      copy.start = fn(copy.start);
      copy.end = fn(copy.end);
      break;
    case 'circle':
    case 'ellipse':
      copy.center = fn(copy.center);
      break;
    case 'rectangle':
      copy.first = fn(copy.first);
      copy.opposite = fn(copy.opposite);
      break;
    case 'octagon':
      copy.center = fn(copy.center);
      copy.vertices = copy.vertices.map(fn);
      break;
    case 'polyline':
      copy.vertices = copy.vertices.map(fn);
      break;
    case 'arc': copy.center = fn(copy.center); break;
    case 'bezier': copy.start = fn(copy.start); copy.control1 = fn(copy.control1); copy.control2 = fn(copy.control2); copy.end = fn(copy.end); break;
    case 'text': copy.position = fn(copy.position); break;
    // A dragged text is an absolute point like the rest, so it has to travel
    // with them — left behind, it would drift off its own dimension on a move.
    case 'dimension': copy.start = fn(copy.start); copy.end = fn(copy.end); copy.offset = fn(copy.offset); if (copy.textPosition) copy.textPosition = fn(copy.textPosition); break;
  }
  return copy;
}

/** A line or polyline: what TRIM and EXTEND can cut against or reach to. */
export function isLineLikeEntity(entity: Entity): entity is Extract<Entity, { type: 'line' | 'polyline' }> {
  return entity.type === 'line' || entity.type === 'polyline';
}

/** Something OFFSET can make a parallel copy of. */
export function isOffsetEntity(entity: Entity): boolean {
  return entity.type === 'line' || entity.type === 'circle' || entity.type === 'rectangle'
    || entity.type === 'octagon' || (entity.type === 'polyline' && entity.closed);
}

/** A closed shape that can be swept or extruded into a solid. */
export function isSweepProfileEntity(entity: Entity): boolean {
  return entity.type === 'circle' || entity.type === 'rectangle' || entity.type === 'octagon'
    || (entity.type === 'polyline' && entity.closed);
}
