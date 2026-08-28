import { closePolyline, dist2, type Vec2, type Vec3 } from '../../math/geometry';
import { localToWorld, worldToLocal, WORLD_WORK_PLANE, type WorkPlane } from '../../math/workplane';
import { isStrokeFont, strokeTextHeight, strokeTextWidth } from '../text/strokeFont';
import type { AffineTransform3, SerializedKernelSolid } from '../geometry/GeometryKernel';

export type EntityType = 'point' | 'line' | 'circle' | 'ellipse' | 'rectangle' | 'octagon' | 'polyline' | 'arc' | 'bezier' | 'hatch' | 'text' | 'dimension' | 'insert';

export interface EntityBase {
  id: string;
  type: EntityType;
  layer: string;
  /**
   * The AutoCAD colour index the object is drawn in: 1–255 for a colour of its
   * own, or 256 (BYLAYER) to take its layer's — which is what almost everything
   * is. This is the truth; `color` is derived from it.
   */
  aci: number;
  /**
   * The resolved RGB the renderer draws, kept in step with `aci` and the layer.
   * A cache, never set by hand: recolouring a layer recomputes it, so an object
   * that is BYLAYER follows its layer instead of carrying a stale copy of it.
   */
  color: number;
  selected: boolean;
  workPlane?: WorkPlane;
}

/** A dimensionless drawing location, corresponding to a native DXF POINT. */
export interface PointEntity extends EntityBase {
  type: 'point';
  position: Vec2;
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
/** One cubic run: `control1`/`control2` shape it, `end` is where it meets the
 *  next segment (or the curve's own end, for the last one). */
export interface BezierSegment { control1: Vec2; control2: Vec2; end: Vec2; }
/**
 * A chain of one or more cubic Bezier segments sharing a single start point —
 * a plain cubic curve is the one-segment case, and JOIN, a fitted multi-point
 * SPLINE, or an imported multi-span DXF spline are the general one.
 */
export interface BezierEntity extends EntityBase { type: 'bezier'; start: Vec2; segments: BezierSegment[]; }
export interface HatchPatternLine { angle: number; base: Vec2; offset: Vec2; }
export interface HatchEntity extends EntityBase {
  type: 'hatch';
  loops: Vec2[][];
  pattern: 'solid' | 'lines' | 'cross' | string;
  /** User-facing primary angle in degrees. */
  angle: number;
  spacing: number;
  /** Exact pattern families, including those read from DXF. */
  patternLines: HatchPatternLine[];
}
export interface TextEntity extends EntityBase { type: 'text'; position: Vec2; text: string; height: number; font?: string; rotation?: number; }
export interface DimensionEntity extends EntityBase {
  type: 'dimension';
  /**
   * `linear` measures along its own `rotation` — the horizontal or vertical
   * distance, which is what a drawing usually wants. `aligned` measures the true
   * point-to-point distance, which is the diagonal.
   */
  dimensionKind: 'linear' | 'aligned' | 'radius' | 'diameter' | 'angular';
  start: Vec2;
  end: Vec2;
  offset: Vec2;
  textHeight: number;
  arrowSize: number;
  arrowType: 'closed' | 'open' | 'tick';
  extensionBeyond: number;
  extensionOffset: number;
  textOffset: number;
  /** Decimal places for length values. */
  precision: number;
  /** Decimal places for angular values; absent in projects created before it existed. */
  angularPrecision?: number;
  /** Whether a length value carries the drawing's millimetre suffix. */
  unitSuffix?: 'none' | 'mm';
  scale: number;
  /** The direction a `linear` dimension measures along, in radians. Ignored by the rest. */
  rotation?: number;
  /**
   * A point on the dimension arc of an angular dimension. Its distance from
   * `start` sets the arc radius and its side chooses the measured sector.
   * Angular dimensions use start as the vertex, end as the first ray and
   * offset as the second ray.
   */
  arcPoint?: Vec2;
  /** Exact displayed text. `<>` inside it is replaced by the measured value. */
  textOverride?: string;
  textPrefix?: string;
  textSuffix?: string;
  toleranceMode?: 'none' | 'symmetric' | 'deviation';
  toleranceUpper?: number;
  toleranceLower?: number;
  /**
   * Where the text was dragged to. Left out, it sits centred and clear of the
   * dimension line, which is what a dimension with room for it wants. A short
   * one has no such room, hence the override.
   */
  textPosition?: Vec2;
}

/** A named DXF BLOCK definition. Its geometry stays in block-local coordinates. */
export interface BlockDefinition {
  name: string;
  /** Base point in `workPlane`; z is optional for old 2D/DXF definitions. */
  basePoint: Vec2 & { z?: number };
  /** Coordinate frame in which native MyCAD block contents were captured. DXF blocks use WCS. */
  workPlane?: WorkPlane;
  entities: Entity[];
  /** Native MyCAD blocks may mix drawing entities and reusable 3D bodies. */
  solids?: Solid[];
}

/** A transformed reference to a block, kept as one selectable drawing object. */
export interface InsertEntity extends EntityBase {
  type: 'insert';
  blockName: string;
  position: Vec2;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  rotation: number;
  columns: number;
  rows: number;
  columnSpacing: number;
  rowSpacing: number;
  /**
   * A snapshot makes bounds, rendering and snaps independent of a Document
   * lookup. Document.blockDefinitions remains the canonical set for DXF export.
   */
  definition: BlockDefinition;
}

export type Entity = PointEntity | LineEntity | CircleEntity | EllipseEntity | RectangleEntity | OctagonEntity | PolylineEntity | ArcEntity | BezierEntity | HatchEntity | TextEntity | DimensionEntity | InsertEntity;

export interface DimensionGeometry {
  extensionStart: [Vec2, Vec2];
  extensionEnd: [Vec2, Vec2];
  /** Two points for a straight dimension line, sampled arc points for angular. */
  dimensionLine: Vec2[];
  arrows: Array<[Vec2, Vec2, Vec2]>;
  textPoint: Vec2;
  textAngle: number;
  text: string;
}

export function dimensionGeometry(entity: DimensionEntity): DimensionGeometry {
  if (entity.dimensionKind === 'angular') return angularDimensionGeometry(entity);

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
      textPoint: entity.offset, textAngle: 0, text: formattedDimensionText(entity, span, 'R'),
    };
  }
  if (entity.dimensionKind === 'diameter') {
    const opposite = { x: entity.start.x - dx, y: entity.start.y - dy };
    return {
      extensionStart: [opposite, opposite], extensionEnd: [entity.end, entity.end],
      dimensionLine: [opposite, entity.end], arrows: [triangle(opposite, 1), triangle(entity.end, -1)],
      textPoint: entity.offset, textAngle: 0, text: formattedDimensionText(entity, span * 2, '\u00d8'),
    };
  }
  return {
    extensionStart: [gapA, extensionA], extensionEnd: [gapB, extensionB], dimensionLine: [a, b],
    arrows: [triangle(a, 1), triangle(b, -1)],
    textPoint: entity.textPosition ?? {
      x: (a.x + b.x) / 2 + nx * textSide * textClearance,
      y: (a.y + b.y) / 2 + ny * textSide * textClearance,
    },
    textAngle, text: formattedDimensionText(entity, length),
  };
}

function angularDimensionGeometry(entity: DimensionEntity): DimensionGeometry {
  const center = entity.start;
  const ray1 = { x: entity.end.x - center.x, y: entity.end.y - center.y };
  const ray2 = { x: entity.offset.x - center.x, y: entity.offset.y - center.y };
  const length1 = Math.hypot(ray1.x, ray1.y);
  const length2 = Math.hypot(ray2.x, ray2.y);
  const unit1 = length1 > 1e-9 ? { x: ray1.x / length1, y: ray1.y / length1 } : { x: 1, y: 0 };
  const unit2 = length2 > 1e-9 ? { x: ray2.x / length2, y: ray2.y / length2 } : { x: 0, y: 1 };
  const angle1 = Math.atan2(unit1.y, unit1.x);
  const angle2 = Math.atan2(unit2.y, unit2.x);
  const positive = (angle: number): number => {
    let value = angle % (Math.PI * 2);
    if (value < 0) value += Math.PI * 2;
    return value;
  };
  const ccwSweep = positive(angle2 - angle1);
  const fallbackAngle = angle1 + ccwSweep / 2;
  const chosenPoint = entity.arcPoint ?? {
    x: center.x + Math.cos(fallbackAngle) * Math.max(length1, length2, entity.arrowSize * entity.scale * 2),
    y: center.y + Math.sin(fallbackAngle) * Math.max(length1, length2, entity.arrowSize * entity.scale * 2),
  };
  const chosenAngle = Math.atan2(chosenPoint.y - center.y, chosenPoint.x - center.x);
  const chosenFromFirst = positive(chosenAngle - angle1);
  // The cursor decides which of the two sectors is dimensioned. On a ray the
  // smaller sector is the stable answer, avoiding a 360° jump at its boundary.
  const sweep = chosenFromFirst <= ccwSweep + 1e-9
    ? ccwSweep
    : -(Math.PI * 2 - ccwSweep);
  const radius = Math.max(
    Math.hypot(chosenPoint.x - center.x, chosenPoint.y - center.y),
    entity.arrowSize * entity.scale * 1.5,
  );
  const segments = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 36)));
  const dimensionLine: Vec2[] = [];
  for (let index = 0; index <= segments; index++) {
    const angle = angle1 + sweep * index / segments;
    dimensionLine.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  }

  const extension = (unit: Vec2): [Vec2, Vec2] => [
    {
      x: center.x + unit.x * entity.extensionOffset * entity.scale,
      y: center.y + unit.y * entity.extensionOffset * entity.scale,
    },
    {
      x: center.x + unit.x * (radius + entity.extensionBeyond * entity.scale),
      y: center.y + unit.y * (radius + entity.extensionBeyond * entity.scale),
    },
  ];
  const arrow = entity.arrowSize * entity.scale;
  const wing = arrow * 0.36;
  const arrowAt = (tip: Vec2, inward: Vec2): [Vec2, Vec2, Vec2] => {
    const normal = { x: -inward.y, y: inward.x };
    if (entity.arrowType === 'tick') return [
      tip,
      { x: tip.x - inward.x * arrow * 0.45 + normal.x * arrow * 0.45, y: tip.y - inward.y * arrow * 0.45 + normal.y * arrow * 0.45 },
      { x: tip.x + inward.x * arrow * 0.45 - normal.x * arrow * 0.45, y: tip.y + inward.y * arrow * 0.45 - normal.y * arrow * 0.45 },
    ];
    return [
      tip,
      { x: tip.x + inward.x * arrow + normal.x * wing, y: tip.y + inward.y * arrow + normal.y * wing },
      { x: tip.x + inward.x * arrow - normal.x * wing, y: tip.y + inward.y * arrow - normal.y * wing },
    ];
  };
  const sign = sweep < 0 ? -1 : 1;
  const startTangent = { x: -Math.sin(angle1) * sign, y: Math.cos(angle1) * sign };
  const endAngle = angle1 + sweep;
  const endTangent = { x: -Math.sin(endAngle) * sign, y: Math.cos(endAngle) * sign };
  const middleAngle = angle1 + sweep / 2;
  const textClearance = (entity.textOffset + entity.textHeight / 2) * entity.scale;
  let textAngle = middleAngle + (sweep < 0 ? -Math.PI / 2 : Math.PI / 2);
  while (textAngle >= Math.PI / 2) textAngle -= Math.PI;
  while (textAngle < -Math.PI / 2) textAngle += Math.PI;

  return {
    extensionStart: extension(unit1),
    extensionEnd: extension(unit2),
    dimensionLine,
    arrows: [
      arrowAt(dimensionLine[0], startTangent),
      arrowAt(dimensionLine[dimensionLine.length - 1], { x: -endTangent.x, y: -endTangent.y }),
    ],
    textPoint: entity.textPosition ?? {
      x: center.x + Math.cos(middleAngle) * (radius + textClearance),
      y: center.y + Math.sin(middleAngle) * (radius + textClearance),
    },
    textAngle,
    text: formattedDimensionText(entity, Math.abs(sweep) * 180 / Math.PI, '', true),
  };
}

function formattedDimensionText(
  entity: DimensionEntity,
  value: number,
  symbol = '',
  angular = false,
): string {
  const precision = angular ? entity.angularPrecision ?? entity.precision : entity.precision;
  const upper = Math.max(0, entity.toleranceUpper ?? 0).toFixed(precision);
  const lower = Math.max(0, entity.toleranceLower ?? 0).toFixed(precision);
  const mode = entity.toleranceMode ?? 'none';
  let measured = `${symbol}${value.toFixed(precision)}${angular ? '°' : ''}`;
  if (mode === 'symmetric') {
    measured += ` ±${upper}${angular ? '°' : ''}`;
  } else if (mode === 'deviation') {
    measured += ` +${upper}${angular ? '°' : ''}/-${lower}${angular ? '°' : ''}`;
  }
  if (!angular && entity.unitSuffix === 'mm') measured += ' mm';

  const override = entity.textOverride ?? '';
  const body = override
    ? (override.includes('<>') ? override.replaceAll('<>', measured) : override)
    : measured;
  return `${entity.textPrefix ?? ''}${body}${entity.textSuffix ?? ''}`;
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

/** The Z a point carries off its work plane, if any. */
const pointZ = (point: Vec2): number | undefined => (point as Vec2 & { z?: number }).z;
/** Attaches Z only when there is one, so a plain 2D point stays plain. */
const withZ = (point: Vec2, z: number | undefined): Vec2 => (z === undefined ? point : { ...point, z } as Vec2);

/** Samples a rotated ellipse; `segments` points around it, first point repeated last. */
export function ellipsePoints(e: EllipseEntity, segments = 64): Vec2[] {
  const cos = Math.cos(e.rotation), sin = Math.sin(e.rotation);
  const z = pointZ(e.center);
  const points: Vec2[] = [];
  for (let index = 0; index <= segments; index++) {
    const t = (Math.PI * 2 * index) / segments;
    const x = Math.cos(t) * e.radiusX;
    const y = Math.sin(t) * e.radiusY;
    points.push(withZ({ x: e.center.x + x * cos - y * sin, y: e.center.y + x * sin + y * cos }, z));
  }
  return points;
}

/** The four axis endpoints, in world space — the ellipse's own quadrant points. */
export function ellipseAxisPoints(e: EllipseEntity): Vec2[] {
  const cos = Math.cos(e.rotation), sin = Math.sin(e.rotation);
  const z = pointZ(e.center);
  const at = (x: number, y: number): Vec2 => withZ({ x: e.center.x + x * cos - y * sin, y: e.center.y + x * sin + y * cos }, z);
  return [at(e.radiusX, 0), at(0, e.radiusY), at(-e.radiusX, 0), at(0, -e.radiusY)];
}

/**
 * A sampled arc, or a sampled Bezier chain — each segment gets its own share
 * of `resolution`, so a JOINed multi-segment curve keeps the same per-length
 * smoothness a single cubic gets, rather than spreading one fixed point count
 * across however many pieces happen to make it up. The join between two
 * segments is one point, not two: each segment after the first starts
 * sampling past its own t = 0, which is exactly where the previous one ended.
 */
export function curvePoints(e: ArcEntity | BezierEntity, resolution = 64): Vec2[] {
  if (e.type === 'arc') {
    const arcZ = pointZ(e.center);
    const points: Vec2[] = [];
    for (let i = 0; i <= resolution; i++) {
      const t = i / resolution;
      const a = e.startAngle + e.sweepAngle * t;
      points.push(withZ({ x: e.center.x + Math.cos(a) * e.radius, y: e.center.y + Math.sin(a) * e.radius }, arcZ));
    }
    return points;
  }
  const steps = Math.max(1, Math.round(resolution / e.segments.length));
  const points: Vec2[] = [];
  let segmentStart = e.start;
  let startZ = pointZ(e.start);
  e.segments.forEach((segment, segmentIndex) => {
    const controlZ1 = pointZ(segment.control1), controlZ2 = pointZ(segment.control2), endZ = pointZ(segment.end);
    const hasZ = startZ !== undefined || controlZ1 !== undefined || controlZ2 !== undefined || endZ !== undefined;
    for (let i = segmentIndex === 0 ? 0 : 1; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const point: Vec2 = {
        x: u ** 3 * segmentStart.x + 3 * u ** 2 * t * segment.control1.x + 3 * u * t ** 2 * segment.control2.x + t ** 3 * segment.end.x,
        y: u ** 3 * segmentStart.y + 3 * u ** 2 * t * segment.control1.y + 3 * u * t ** 2 * segment.control2.y + t ** 3 * segment.end.y,
      };
      if (hasZ) {
        (point as Vec2 & { z: number }).z = u ** 3 * (startZ ?? 0) + 3 * u ** 2 * t * (controlZ1 ?? 0) + 3 * u * t ** 2 * (controlZ2 ?? 0) + t ** 3 * (endZ ?? 0);
      }
      points.push(point);
    }
    segmentStart = segment.end;
    startZ = endZ;
  });
  return points;
}

export interface SolidMesh {
  positions: Float32Array;
  indices: Uint32Array;
  /** B-rep face behind each triangle when the mesh was derived from an exact solid. */
  triangleFaceIds?: Uint32Array;
}

export interface ExactSolidGeometry {
  kernel: 'opencascade';
  /** Must equal `Solid.revision`; otherwise a mesh-only edit made this snapshot stale. */
  revision: number;
  shape: SerializedKernelSolid;
  /** Placement accumulated since `shape` was serialized; omitted for identity. */
  transform?: AffineTransform3;
}

export interface SolidFaceSelection {
  solidId: string;
  /** Zero-based face in the current exact B-rep, when this came from exact tessellation. */
  topologyFaceId?: number;
  vertexIndices: number[];
  normal: Vec3;
  /** Exact world-space point where the pointer ray met the planar face. */
  hitPoint?: Vec3;
  /** The bounded planar region under the pointer, in its own 2D face frame. */
  region?: SolidFaceRegion;
}

/** JSON-safe geometry of one selectable part of a planar solid face. */
export interface SolidFaceRegion {
  plane: WorkPlane;
  /** Outer loop first (CCW), then holes (CW), with no repeated closing point. */
  loops: Vec2[][];
}

export interface SolidEdgeSelection {
  solidId: string;
  /** The two exact B-rep faces whose common edge was picked. */
  topologyFaceIds?: [number, number];
  start: Vec3;
  end: Vec3;
  normalA: Vec3;
  normalB: Vec3;
  /** Present when the selected mesh segment belongs to a recognised circular feature edge. */
  circular?: {
    center: Vec3;
    normal: Vec3;
    radius: number;
    /** Tessellation used by the recognised source loop. */
    segments?: number;
  };
}

export interface ExtrusionFeature {
  kind: 'extrusion';
  profile: Entity;
  /** Local vector in the feature work plane. Absent means its positive Z axis. */
  direction?: Vec3;
  /** Degrees. Positive angles narrow the profile towards the far cap. */
  taperAngle?: number;
  /** The original signed height pointed below the profile plane. */
  reverse?: boolean;
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
  operation: 'union' | 'subtract' | 'intersect';
  operands: SolidFeature[];
}

export interface SweepFeature {
  kind: 'sweep';
  /** EXTRUDE Path reuses the sweep engine but keeps EXTRUDE terminology in UI. */
  createdBy?: 'extrude';
  profile: Entity;
  path: Entity;
  workPlane?: WorkPlane;
}

export interface MeshFeature {
  kind: 'mesh';
}

/**
 * A JSON-safe copy of a mesh. Feature trees are written straight into project
 * files, so typed arrays cannot live here: JSON would turn them into objects
 * with numeric keys instead of arrays that can be restored reliably.
 */
export interface SerializedSolidMesh {
  positions: number[];
  indices: number[];
}

/** A reversible operation on one solid edge. */
export interface EdgeModificationFeature {
  kind: 'edge-modification';
  operation: 'chamfer' | 'fillet';
  source: SolidFeature;
  edge: SolidEdgeSelection;
  /** Radius for FILLET, or distance on the face identified by `edge.normalA`. */
  amount: number;
  /** CHAMFER distance on the face identified by `edge.normalB`; old projects use `amount`. */
  amount2?: number;
  /** Geometry immediately before this operation — kept only when the source is a
   * baked mesh with no recipe; a regenerable source drops it to keep files small. */
  sourceMesh?: SerializedSolidMesh;
}

/** A reversible union/subtraction made by pulling a bounded planar face region. */
export interface PressPullFeature {
  kind: 'presspull-region';
  source: SolidFeature;
  region: SolidFaceRegion;
  distance: number;
  /** Geometry immediately before this operation — kept only when the source is a
   * baked mesh with no recipe; a regenerable source drops it to keep files small. */
  sourceMesh?: SerializedSolidMesh;
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

export type SolidFeature = ExtrusionFeature | BooleanFeature | SweepFeature | PrimitiveFeature | MeshFeature | EdgeModificationFeature | PressPullFeature;

export interface Solid {
  id: string;
  name: string;
  layer: string;
  mesh: SolidMesh;
  /** AutoCAD colour index, 1–255 or 256 (BYLAYER). The truth; `color` is derived. */
  aci: number;
  /** Resolved RGB the renderer draws — a cache of `aci` against the layer. */
  color: number;
  selected: boolean;
  height: number;
  sourceEntityIds: string[];
  feature: SolidFeature;
  /** Exact source geometry. `mesh` remains a disposable rendering/picking cache. */
  exact?: ExactSolidGeometry;
  revision: number;
}

let nextId = 1;
export function genId(prefix = 'e'): string {
  return `${prefix}_${nextId++}`;
}

export function resetIdCounter(): void {
  nextId = 1;
}

/**
 * Advance the shared counter past every `prefix_N` id in `ids`. Ids minted after
 * a project loads must never collide with the ones that came from the file:
 * `replaceSolid`/`replaceEntity` upsert by id, so a reused id silently overwrites
 * a loaded object (a new solid could make a loaded one vanish).
 */
export function ensureIdAbove(ids: Iterable<string>): void {
  for (const id of ids) {
    const match = /_(\d+)$/.exec(id);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value >= nextId) nextId = value + 1;
  }
}

export function cloneEntity<T extends Entity>(e: T): T {
  if (e.type !== 'insert') return JSON.parse(JSON.stringify(e)) as T;
  return {
    ...JSON.parse(JSON.stringify({ ...e, definition: undefined })),
    definition: cloneBlockDefinition(e.definition),
  } as T;
}

/** Typed mesh arrays need a real copy; JSON turns them into numeric-key objects. */
export function cloneSolidValue(solid: Solid): Solid {
  return {
    ...solid,
    mesh: {
      positions: solid.mesh.positions.slice(),
      indices: solid.mesh.indices.slice(),
      triangleFaceIds: solid.mesh.triangleFaceIds?.slice(),
    },
    exact: solid.exact ? {
      ...solid.exact,
      shape: { ...solid.exact.shape },
      transform: solid.exact.transform ? [...solid.exact.transform] as AffineTransform3 : undefined,
    } : undefined,
    sourceEntityIds: [...solid.sourceEntityIds],
    feature: JSON.parse(JSON.stringify(solid.feature)) as SolidFeature,
  };
}

export function cloneBlockDefinition(definition: BlockDefinition): BlockDefinition {
  return {
    name: definition.name,
    basePoint: { ...definition.basePoint },
    workPlane: definition.workPlane ? JSON.parse(JSON.stringify(definition.workPlane)) as WorkPlane : undefined,
    entities: definition.entities.map(cloneEntity),
    solids: definition.solids?.map(cloneSolidValue),
  };
}

/**
 * Expands an INSERT into drawing primitives while keeping the INSERT itself as
 * the object stored in Document. Array rows/columns are expanded here too.
 */
function computeExpandedInsertEntities(insert: InsertEntity): Entity[] {
  const result: Entity[] = [];
  const scaleZ = insert.scaleZ ?? 1;
  const cos = Math.cos(insert.rotation), sin = Math.sin(insert.rotation);
  const transformPoint = (point: Vec2, column: number, row: number): Vec2 => {
    const x = (point.x - insert.definition.basePoint.x + column * insert.columnSpacing) * insert.scaleX;
    const y = (point.y - insert.definition.basePoint.y + row * insert.rowSpacing) * insert.scaleY;
    const sourceZ = (point as Vec2 & { z?: number }).z ?? 0;
    const z = (((insert.position as Vec2 & { z?: number }).z ?? 0)
      + (sourceZ - (insert.definition.basePoint.z ?? 0)) * scaleZ);
    return {
      x: insert.position.x + x * cos - y * sin,
      y: insert.position.y + x * sin + y * cos,
      ...(Math.abs(z) > 1e-12 ? { z } : {}),
    } as Vec2;
  };
  const transformVector = (point: Vec2): Vec2 => ({
    x: point.x * insert.scaleX * cos - point.y * insert.scaleY * sin,
    y: point.x * insert.scaleX * sin + point.y * insert.scaleY * cos,
  });
  const finish = (entity: Entity, source: Entity, column: number, row: number): Entity => {
    entity.id = `${insert.id}:${column}:${row}:${source.id}`;
    entity.selected = insert.selected;
    entity.workPlane = insert.workPlane ? JSON.parse(JSON.stringify(insert.workPlane)) : undefined;
    if (source.layer === '0') {
      entity.layer = insert.layer;
      if (source.aci === 256) entity.color = insert.color;
    }
    if (source.aci === 0) {
      entity.aci = insert.aci;
      entity.color = insert.color;
    }
    return entity;
  };
  const transformed = (source: Entity, column: number, row: number): Entity[] => {
    const at = (point: Vec2): Vec2 => transformPoint(point, column, row);
    let entity: Entity;
    switch (source.type) {
      case 'point': entity = { ...cloneEntity(source), position: at(source.position) }; break;
      case 'line': entity = { ...cloneEntity(source), start: at(source.start), end: at(source.end) }; break;
      case 'rectangle': entity = {
        ...cloneEntity(source), type: 'polyline',
        vertices: [source.first, { x: source.opposite.x, y: source.first.y }, source.opposite, { x: source.first.x, y: source.opposite.y }].map(at),
        closed: true,
      } as PolylineEntity; break;
      case 'octagon': entity = { ...cloneEntity(source), type: 'polyline', vertices: source.vertices.map(at), closed: true } as PolylineEntity; break;
      case 'polyline': entity = { ...cloneEntity(source), vertices: source.vertices.map(at) }; break;
      case 'circle': {
        const xAxis = transformVector({ x: source.radius, y: 0 });
        const yAxis = transformVector({ x: 0, y: source.radius });
        const radiusX = Math.hypot(xAxis.x, xAxis.y), radiusY = Math.hypot(yAxis.x, yAxis.y);
        if (Math.abs(radiusX - radiusY) <= Math.max(radiusX, radiusY) * 1e-9) {
          entity = { ...cloneEntity(source), center: at(source.center), radius: radiusX };
        } else {
          entity = {
            ...cloneEntity(source), type: 'ellipse', center: at(source.center), radiusX, radiusY,
            rotation: Math.atan2(xAxis.y, xAxis.x),
          } as EllipseEntity;
        }
        break;
      }
      case 'ellipse':
        entity = { ...cloneEntity(source), type: 'polyline', vertices: ellipsePoints(source).slice(0, -1).map(at), closed: true } as PolylineEntity;
        break;
      case 'arc':
        entity = { ...cloneEntity(source), type: 'polyline', vertices: curvePoints(source).map(at), closed: false } as PolylineEntity;
        break;
      case 'bezier': entity = {
        ...cloneEntity(source), start: at(source.start),
        segments: source.segments.map((segment) => ({ control1: at(segment.control1), control2: at(segment.control2), end: at(segment.end) })),
      }; break;
      case 'hatch': entity = {
        ...cloneEntity(source),
        loops: source.loops.map((loop) => loop.map(at)),
        patternLines: source.patternLines.map((line) => ({
          angle: Math.atan2(transformVector({ x: Math.cos(line.angle), y: Math.sin(line.angle) }).y, transformVector({ x: Math.cos(line.angle), y: Math.sin(line.angle) }).x),
          base: at(line.base),
          offset: transformVector(line.offset),
        })),
        spacing: source.spacing * Math.max(Math.abs(insert.scaleX), Math.abs(insert.scaleY)),
      }; break;
      case 'text': {
        const textAxis = transformVector({ x: Math.cos(source.rotation ?? 0), y: Math.sin(source.rotation ?? 0) });
        entity = {
          ...cloneEntity(source), position: at(source.position), rotation: Math.atan2(textAxis.y, textAxis.x),
          height: source.height * Math.max(Math.abs(insert.scaleX), Math.abs(insert.scaleY)),
        };
        break;
      }
      case 'dimension': {
        const scale = Math.max(Math.abs(insert.scaleX), Math.abs(insert.scaleY));
        entity = {
          ...cloneEntity(source), start: at(source.start), end: at(source.end), offset: at(source.offset),
          arcPoint: source.arcPoint ? at(source.arcPoint) : undefined,
          textPosition: source.textPosition ? at(source.textPosition) : undefined,
          scale: source.scale * scale,
          rotation: source.rotation === undefined ? undefined : source.rotation + insert.rotation,
        };
        break;
      }
      case 'insert': {
        // Expand the child in its parent-block coordinates first, then apply
        // this INSERT's affine transform to every primitive. Decomposing two
        // nested non-uniform scales into one rotation/scale would lose the shear
        // that their exact matrix composition creates.
        return expandedInsertEntities(source).flatMap((child) => transformed(child, column, row));
      }
    }
    return [finish(entity, source, column, row)];
  };

  const columns = Math.max(1, Math.floor(insert.columns));
  const rows = Math.max(1, Math.floor(insert.rows));
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    for (const entity of insert.definition.entities) result.push(...transformed(entity, column, row));
  }
  return result;
}

/**
 * 3D bodies inside an INSERT, transformed into world coordinates. They remain
 * owned by the INSERT — the derived ids exist only for rendering/snaps and are
 * never stored in Document.solids or selected independently.
 */
function computeExpandedInsertSolids(insert: InsertEntity): Solid[] {
  const sourcePlane = insert.definition.workPlane ?? WORLD_WORK_PLANE;
  const targetPlane = insert.workPlane ?? WORLD_WORK_PLANE;
  const baseZ = insert.definition.basePoint.z ?? 0;
  const positionZ = (insert.position as Vec2 & { z?: number }).z ?? 0;
  const scaleZ = insert.scaleZ ?? 1;
  const cos = Math.cos(insert.rotation), sin = Math.sin(insert.rotation);
  const nested = insert.definition.entities
    .filter((entity): entity is InsertEntity => entity.type === 'insert')
    .flatMap(expandedInsertSolids);
  const sources = [...(insert.definition.solids ?? []), ...nested];
  const result: Solid[] = [];
  const columns = Math.max(1, Math.floor(insert.columns));
  const rows = Math.max(1, Math.floor(insert.rows));

  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    for (const source of sources) {
      const solid = cloneSolidValue(source);
      for (let index = 0; index < solid.mesh.positions.length; index += 3) {
        const local = worldToLocal(sourcePlane, {
          x: solid.mesh.positions[index],
          y: solid.mesh.positions[index + 1],
          z: solid.mesh.positions[index + 2],
        });
        const x = (local.x - insert.definition.basePoint.x + column * insert.columnSpacing) * insert.scaleX;
        const y = (local.y - insert.definition.basePoint.y + row * insert.rowSpacing) * insert.scaleY;
        const target = localToWorld(targetPlane, {
          x: insert.position.x + x * cos - y * sin,
          y: insert.position.y + x * sin + y * cos,
        }, positionZ + (local.z - baseZ) * scaleZ);
        solid.mesh.positions[index] = target.x;
        solid.mesh.positions[index + 1] = target.y;
        solid.mesh.positions[index + 2] = target.z;
      }
      // A reflected instance reverses handedness; keep triangle normals outward.
      if (insert.scaleX * insert.scaleY * scaleZ < 0) {
        for (let index = 0; index + 2 < solid.mesh.indices.length; index += 3) {
          const swap = solid.mesh.indices[index + 1];
          solid.mesh.indices[index + 1] = solid.mesh.indices[index + 2];
          solid.mesh.indices[index + 2] = swap;
        }
      }
      solid.id = `${insert.id}:${column}:${row}:solid:${source.id}`;
      solid.name = `${insert.blockName}:${source.name}`;
      solid.selected = insert.selected;
      solid.height *= Math.abs(scaleZ);
      solid.feature = { kind: 'mesh' };
      solid.revision++;
      if (source.layer === '0') {
        solid.layer = insert.layer;
        if (source.aci === 256) solid.color = insert.color;
      }
      if (source.aci === 0) {
        solid.aci = insert.aci;
        solid.color = insert.color;
      }
      result.push(solid);
    }
  }
  return result;
}

/**
 * Expanding a nested block (rendering, snapping, bounds, picking — every
 * caller below) walks and clones its whole subtree; for a deeply nested
 * symbol that is expensive enough to stutter the pointer on every move, so
 * the result is cached per INSERT. `definition` is treated as replace-only
 * (renaming a block swaps in a new object rather than mutating in place — see
 * BlockController), so identity is enough to catch that without hashing the
 * potentially huge nested geometry; only the small transform fields are
 * actually re-stringified on every call.
 */
interface InsertExpansion { definitionRef: BlockDefinition; transformKey: string; entities: Entity[]; solids: Solid[] }
const insertExpansionCache = new Map<string, InsertExpansion>();

function insertTransformKey(insert: InsertEntity): string {
  const { definition: _definition, ...rest } = insert;
  return JSON.stringify(rest);
}

function expandInsert(insert: InsertEntity): InsertExpansion {
  const cached = insertExpansionCache.get(insert.id);
  const transformKey = insertTransformKey(insert);
  if (cached && cached.definitionRef === insert.definition && cached.transformKey === transformKey) return cached;
  const entry: InsertExpansion = {
    definitionRef: insert.definition,
    transformKey,
    entities: computeExpandedInsertEntities(insert),
    solids: computeExpandedInsertSolids(insert),
  };
  insertExpansionCache.set(insert.id, entry);
  return entry;
}

export function expandedInsertEntities(insert: InsertEntity): Entity[] { return expandInsert(insert).entities; }
export function expandedInsertSolids(insert: InsertEntity): Solid[] { return expandInsert(insert).solids; }

/** Call when swapping documents (new/open project) so inserts from a previous
    document don't linger in the cache for the rest of the session. */
export function clearInsertExpansionCache(): void { insertExpansionCache.clear(); }

export function entityBounds(e: Entity): { min: Vec2; max: Vec2 } {
  switch (e.type) {
    case 'insert': {
      const children = expandedInsertEntities(e);
      const bounds = children.map(entityBounds);
      const plane = e.workPlane ?? WORLD_WORK_PLANE;
      for (const solid of expandedInsertSolids(e)) {
        for (let index = 0; index < solid.mesh.positions.length; index += 3) {
          const local = worldToLocal(plane, {
            x: solid.mesh.positions[index], y: solid.mesh.positions[index + 1], z: solid.mesh.positions[index + 2],
          });
          bounds.push({ min: { x: local.x, y: local.y }, max: { x: local.x, y: local.y } });
        }
      }
      if (bounds.length === 0) return { min: { ...e.position }, max: { ...e.position } };
      return {
        min: { x: Math.min(...bounds.map((item) => item.min.x)), y: Math.min(...bounds.map((item) => item.min.y)) },
        max: { x: Math.max(...bounds.map((item) => item.max.x)), y: Math.max(...bounds.map((item) => item.max.y)) },
      };
    }
    case 'point':
      return { min: { ...e.position }, max: { ...e.position } };
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
    case 'hatch': {
      const points = e.loops.flat();
      if (points.length === 0) return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
      return {
        min: { x: Math.min(...points.map((point) => point.x)), y: Math.min(...points.map((point) => point.y)) },
        max: { x: Math.max(...points.map((point) => point.x)), y: Math.max(...points.map((point) => point.y)) },
      };
    }
    case 'arc':
    case 'bezier': { const p = curvePoints(e); return { min: { x: Math.min(...p.map(v => v.x)), y: Math.min(...p.map(v => v.y)) }, max: { x: Math.max(...p.map(v => v.x)), y: Math.max(...p.map(v => v.y)) } }; }
    case 'text': {
      const lines = e.text.split('\n');
      // A stroke font knows its own width exactly, so the box is the letters
      // rather than a guess at them — which is what picking and zoom-extents
      // work off. The .62 stays for system fonts, where measuring the glyphs
      // needs a canvas this has no business holding.
      const width = isStrokeFont(e.font)
        ? strokeTextWidth(e.text, e.height, e.font)
        : Math.max(...lines.map((line) => line.length)) * e.height * .62;
      // Line 1 sits between its baseline (y=0) and cap height above it; the
      // block extends below that by however far the rest of the lines drop.
      const bottom = e.height - strokeTextHeight(e.text, e.height);
      const angle = e.rotation ?? 0;
      const rotate = (point: Vec2): Vec2 => ({
        x: e.position.x + point.x * Math.cos(angle) - point.y * Math.sin(angle),
        y: e.position.y + point.x * Math.sin(angle) + point.y * Math.cos(angle),
      });
      const points = [rotate({ x: 0, y: bottom }), rotate({ x: width, y: bottom }), rotate({ x: width, y: e.height }), rotate({ x: 0, y: e.height })];
      return {
        min: { x: Math.min(...points.map((point) => point.x)), y: Math.min(...points.map((point) => point.y)) },
        max: { x: Math.max(...points.map((point) => point.x)), y: Math.max(...points.map((point) => point.y)) },
      };
    }
    case 'dimension': {
      const geometry = dimensionGeometry(e);
      const points = [e.start, e.end, geometry.textPoint, ...geometry.dimensionLine, ...geometry.arrows.flat()];
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

/**
 * Removes one vertex from a polyline, keeping a closed one closed (and its
 * closing duplicate in sync) — or null if there are too few left for it to
 * still be a shape: a triangle cannot lose a corner and remain a polyline, nor
 * a line its one other end.
 */
export function removePolylineVertex(entity: PolylineEntity, index: number): PolylineEntity | null {
  const closingDuplicate = entity.closed && entity.vertices.length > 1
    && dist2(entity.vertices[0], entity.vertices.at(-1)!) < 1e-6;
  const unique = closingDuplicate ? entity.vertices.slice(0, -1) : entity.vertices;
  if (index < 0 || index >= unique.length) return null;
  const minCount = entity.closed ? 3 : 2;
  if (unique.length <= minCount) return null;
  const remaining = unique.filter((_, vertexIndex) => vertexIndex !== index);
  return { ...cloneEntity(entity), vertices: entity.closed ? closePolyline(remaining) : remaining };
}

/**
 * Removes one internal joint from a Bezier chain — where segment
 * `segmentBoundary` meets the next one — merging the two into a single
 * segment that keeps each survivor's own tangent handle (its `control1` from
 * the first segment, its `control2` from the second) rather than refitting
 * the curve. The curve's own first and final point cannot be removed this
 * way: there is nothing on the far side of either to reconnect it to.
 */
export function removeBezierNode(entity: BezierEntity, segmentBoundary: number): BezierEntity | null {
  if (entity.segments.length < 2) return null;
  if (segmentBoundary < 0 || segmentBoundary >= entity.segments.length - 1) return null;
  const before = entity.segments[segmentBoundary];
  const after = entity.segments[segmentBoundary + 1];
  const merged: BezierSegment = { control1: before.control1, control2: after.control2, end: after.end };
  const segments = [...entity.segments.slice(0, segmentBoundary), merged, ...entity.segments.slice(segmentBoundary + 2)];
  return { ...cloneEntity(entity), segments };
}

export function getEntityPoints(e: Entity): Vec2[] {
  switch (e.type) {
    case 'insert': return [e.position, ...expandedInsertEntities(e).flatMap(getEntityPoints)];
    case 'point':
      return [e.position];
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
    case 'hatch': return e.loops.flat();
    case 'arc': return [e.center, ...curvePoints(e, 2)];
    case 'bezier': return [e.start, ...e.segments.flatMap((segment) => [segment.control1, segment.control2, segment.end])];
    case 'text': return [e.position];
    case 'dimension': return [e.start, e.end, e.offset, ...(e.arcPoint ? [e.arcPoint] : []), ...(e.textPosition ? [e.textPosition] : [])];
  }
}

export function transformEntityPoints(e: Entity, fn: (p: Vec2) => Vec2): Entity {
  const copy = cloneEntity(e);
  switch (copy.type) {
    case 'insert': {
      const cos = Math.cos(copy.rotation), sin = Math.sin(copy.rotation);
      const origin = copy.position;
      const xPoint = { x: origin.x + cos * copy.scaleX, y: origin.y + sin * copy.scaleX };
      const yPoint = { x: origin.x - sin * copy.scaleY, y: origin.y + cos * copy.scaleY };
      const transformedOrigin = fn(origin), transformedX = fn(xPoint), transformedY = fn(yPoint);
      const xAxis = { x: transformedX.x - transformedOrigin.x, y: transformedX.y - transformedOrigin.y };
      const yAxis = { x: transformedY.x - transformedOrigin.x, y: transformedY.y - transformedOrigin.y };
      copy.position = transformedOrigin;
      copy.scaleX = Math.hypot(xAxis.x, xAxis.y);
      copy.scaleY = (xAxis.x * yAxis.y - xAxis.y * yAxis.x < 0 ? -1 : 1) * Math.hypot(yAxis.x, yAxis.y);
      copy.rotation = Math.atan2(xAxis.y, xAxis.x);
      break;
    }
    case 'point':
      copy.position = fn(copy.position);
      break;
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
    case 'hatch':
      copy.loops = copy.loops.map((loop) => loop.map(fn));
      copy.patternLines = copy.patternLines.map((line) => ({ ...line, base: fn(line.base) }));
      break;
    case 'arc': copy.center = fn(copy.center); break;
    case 'bezier':
      copy.start = fn(copy.start);
      copy.segments = copy.segments.map((segment) => ({ control1: fn(segment.control1), control2: fn(segment.control2), end: fn(segment.end) }));
      break;
    case 'text': copy.position = fn(copy.position); break;
    // A dragged text is an absolute point like the rest, so it has to travel
    // with them — left behind, it would drift off its own dimension on a move.
    case 'dimension': copy.start = fn(copy.start); copy.end = fn(copy.end); copy.offset = fn(copy.offset); if (copy.arcPoint) copy.arcPoint = fn(copy.arcPoint); if (copy.textPosition) copy.textPosition = fn(copy.textPosition); break;
  }
  return copy;
}

/** A line or polyline: what TRIM and EXTEND can cut against or reach to. */
export function isLineLikeEntity(entity: Entity): entity is Extract<Entity, { type: 'line' | 'polyline' }> {
  return entity.type === 'line' || entity.type === 'polyline';
}

/** Something OFFSET can make a parallel copy of. */
export function isOffsetEntity(entity: Entity): boolean {
  return entity.type === 'line' || entity.type === 'arc' || entity.type === 'circle' || entity.type === 'ellipse'
    || entity.type === 'rectangle' || entity.type === 'octagon' || entity.type === 'polyline';
}

/** A closed shape that can be swept or extruded into a solid. */
export function isSweepProfileEntity(entity: Entity): boolean {
  return entity.type === 'circle' || entity.type === 'rectangle' || entity.type === 'octagon'
    || (entity.type === 'polyline' && entity.closed);
}
