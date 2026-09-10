import type { Document } from '../core/Document';
import { cloneEntity, cloneSurfaceValue, dimensionGeometry, ellipseAxisPoints, getEntityPoints, transformEntityPoints, type Entity, type ExactSolidGeometry, type LoftFeature, type Solid, type SolidFeature, type Surface } from '../core/entities/types';
import type { CommandHistory } from '../core/history/CommandHistory';
import { UpdateEntityEdit, UpdateSolidEdit, UpdateSurfaceEdit, cloneSolid } from '../core/history/edits';
import { arcFromSagitta } from '../math/arcFit';
import { midpoint2, type Vec2, type Vec3 } from '../math/geometry';
import { localToWorld, WORLD_WORK_PLANE, type WorkPlane } from '../math/workplane';
import { solidBounds } from './PickingService';
import { translatedFeature } from '../core/solids/featureTransform';
import { scaleAffine, transformedExactGeometry, translationAffine } from '../core/geometry/ExactTransform';
import { buildExactFeature } from '../core/geometry/ExactSolid';

/** A loft's own boundary — its embedded profiles, guides and optional path,
 *  each a real Entity value with its own work plane — flattened into one
 *  list in a fixed order (profiles, then guides, then path), which is the
 *  order grip indices (`objectIndex * 100 + localIndex`) and
 *  `setEmbeddedLoftEntity` below both key off of. */
export function embeddedLoftEntities(feature: SolidFeature): Entity[] {
  if (feature.kind !== 'loft') return [];
  return [...feature.profiles, ...(feature.guides ?? []), ...(feature.path ? [feature.path] : [])];
}

/** The inverse of embeddedLoftEntities' flattening: a copy of `feature` with
 *  the entity at flat position `index` replaced by `entity`. */
function setEmbeddedLoftEntity(feature: LoftFeature, index: number, entity: Entity): LoftFeature {
  const profileCount = feature.profiles.length;
  const guideCount = feature.guides?.length ?? 0;
  if (index < profileCount) {
    const profiles = feature.profiles.slice();
    profiles[index] = entity;
    return { ...feature, profiles };
  }
  if (index < profileCount + guideCount) {
    const guides = (feature.guides ?? []).slice();
    guides[index - profileCount] = entity;
    return { ...feature, guides };
  }
  return { ...feature, path: entity };
}

/**
 * Grip points for one of a loft's embedded profile/guide/path entities — a
 * scoped-down version of activeGrips()' own per-type layouts below, covering
 * only the shapes a rail or guide can actually be (isSweepPath: line, arc,
 * circle, polyline, bezier) plus a generic fallback for a closed-profile
 * type used as a rail. Deliberately does not include the "whole edge/shape"
 * move grips (a line's midpoint, an arc's sagitta handle) that the entity's
 * own normal grip set has — endpoint/control-point reshaping is the point
 * of this feature, not repositioning the whole curve, which MOVE already does.
 */
function gripsForEmbeddedEntity(entity: Entity): Grip[] {
  if (entity.type === 'line') {
    return [
      { point: entity.start, index: 0, shape: 'square' },
      { point: entity.end, index: 1, shape: 'square' },
    ];
  }
  if (entity.type === 'circle') {
    const result: Grip[] = [{ point: entity.center, index: 0, shape: 'square' }];
    for (let i = 0; i < 4; i++) {
      const angle = i * Math.PI / 2;
      result.push({
        point: { x: entity.center.x + Math.cos(angle) * entity.radius, y: entity.center.y + Math.sin(angle) * entity.radius },
        index: i + 1,
        shape: 'square',
      });
    }
    return result;
  }
  if (entity.type === 'polyline') {
    const vertices = entity.closed ? entity.vertices.slice(0, -1) : entity.vertices;
    return vertices.map((point, index) => ({ point, index, shape: 'square' as const }));
  }
  if (entity.type === 'bezier') {
    const points = [entity.start, ...entity.segments.flatMap((segment) => [segment.control1, segment.control2, segment.end])];
    return points.map((point, index) => ({ point, index, shape: 'square' as const }));
  }
  if (entity.type === 'arc') {
    const point = (a: number): Vec2 => ({ x: entity.center.x + Math.cos(a) * entity.radius, y: entity.center.y + Math.sin(a) * entity.radius });
    return [
      { point: entity.center, index: 0, shape: 'square' },
      { point: point(entity.startAngle), index: 1, shape: 'square' },
      { point: point(entity.startAngle + entity.sweepAngle), index: 2, shape: 'square' },
    ];
  }
  // A closed-profile type (rectangle, octagon, ellipse) used as a rail: no
  // bespoke reshape here, just its own raw point list — same fallback
  // visibleGrips() below already uses for anything it doesn't special-case.
  return getEntityPoints(entity).map((point, index) => ({ point, index, shape: 'square' as const }));
}

/**
 * Applies one grip drag to a clone of `original` — the loft-embedded
 * counterpart of updateEntity() below, but returning a new value instead of
 * mutating a live document entity (an embedded entity is data inside a
 * feature tree, not its own document object with an id to look up).
 */
function applyEmbeddedEntityGripDrag(original: Entity, gripIndex: number, cursor: Vec2, dx: number, dy: number): Entity {
  const entity = cloneEntity(original);
  if (entity.type === 'line' && original.type === 'line') {
    if (gripIndex === 0) entity.start = { ...cursor };
    else entity.end = { ...cursor };
    return entity;
  }
  if (entity.type === 'circle' && original.type === 'circle') {
    if (gripIndex === 0) entity.center = { x: original.center.x + dx, y: original.center.y + dy };
    else entity.radius = Math.max(0.0001, Math.hypot(cursor.x - original.center.x, cursor.y - original.center.y));
    return entity;
  }
  if (entity.type === 'polyline' && original.type === 'polyline') {
    entity.vertices[gripIndex] = { ...cursor };
    if (entity.closed && gripIndex === 0) entity.vertices[entity.vertices.length - 1] = { ...cursor };
    return entity;
  }
  if (entity.type === 'bezier' && original.type === 'bezier') {
    if (gripIndex === 0) entity.start = { ...cursor };
    else {
      const segmentIndex = Math.floor((gripIndex - 1) / 3);
      const field = (gripIndex - 1) % 3;
      const segment = entity.segments[segmentIndex];
      if (field === 0) segment.control1 = { ...cursor };
      else if (field === 1) segment.control2 = { ...cursor };
      else segment.end = { ...cursor };
    }
    return entity;
  }
  if (entity.type === 'arc' && original.type === 'arc') {
    if (gripIndex === 0) entity.center = { x: original.center.x + dx, y: original.center.y + dy };
    else {
      const a = Math.atan2(cursor.y - original.center.y, cursor.x - original.center.x);
      entity.radius = Math.max(0.001, Math.hypot(cursor.x - original.center.x, cursor.y - original.center.y));
      if (gripIndex === 1) {
        entity.startAngle = a;
        let s = original.startAngle + original.sweepAngle - a;
        while (s <= 0) s += Math.PI * 2;
        entity.sweepAngle = s;
      } else {
        let s = a - original.startAngle;
        if (s <= 0) s += Math.PI * 2;
        entity.sweepAngle = s;
      }
    }
    return entity;
  }
  // Anything else (rectangle/octagon/ellipse) moves its whole raw point list
  // by the drag delta — rigid, rather than a bespoke per-type reshape for a
  // type unlikely to appear as a rail/guide in the first place.
  return transformEntityPoints(entity, (point) => ({ x: point.x + dx, y: point.y + dy }));
}

export type GripMode = 'end' | 'center' | 'middle';
/** `angle` (radians) orients an edge grip along the edge it sits on. */
export type Grip = { point: Vec2 & { z?: number }; index: number; shape?: 'square' | 'edge'; angle?: number };

type DragState = {
  objectId: string;
  objectType: 'entity' | 'solid' | 'surface';
  gripIndex: number;
  origin: Vec2;
  originalEntity?: Entity;
  originalPositions?: Float32Array;
  originalIndices?: Uint32Array;
  originalFeature?: SolidFeature;
  originalExact?: ExactSolidGeometry;
  originalRevision?: number;
  /** Surface-only: which flat position (embeddedLoftEntities' own ordering)
   *  the dragged grip's entity sits at, and a clone of just that one entity
   *  to compute the drag's delta from — the same role originalEntity plays
   *  for a plain entity drag. */
  embeddedIndex?: number;
  originalEmbeddedEntity?: Entity;
};

export class GripController {
  mode: GripMode | null = null;
  hoveredGrip = -1;
  private drag: DragState | null = null;
  private changed = false;
  /** Guards a surface's async kernel rebuild against a slower/stale one
   *  finishing after a newer drag frame (or after the drag itself has
   *  ended) and clobbering it — same pattern DragEditing.ts's
   *  updateExtrudePreview uses for EXTRUDE's own live height drag. */
  private dragRebuildToken = 0;

  constructor(private readonly doc: Document, private readonly history: CommandHistory) {}

  get isDragging(): boolean { return this.drag !== null; }
  get draggingObjectId(): string | null { return this.drag?.objectId ?? null; }
  get draggingGripIndex(): number | null { return this.drag?.gripIndex ?? null; }
  get draggingOrigin(): Vec2 | null { return this.drag ? { ...this.drag.origin } : null; }

  /**
   * The radius of the circle being moved by its own centre grip, so Tangent
   * snap can solve for where that centre must land to make the circle — at
   * its own fixed size — touch a target line or circle. Null for every other
   * drag, including a circle's own radius grips (index > 0), which resize it
   * rather than move it.
   */
  draggingCircleRadius(): number | null {
    if (!this.drag || this.drag.objectType !== 'entity' || !this.drag.originalEntity) return null;
    const entity = this.drag.originalEntity;
    if (entity.type !== 'circle' || this.drag.gripIndex !== 0) return null;
    return entity.radius;
  }

  /**
   * The fixed other end while dragging one of a line's own two endpoint
   * grips — the same "fixed point, free point" shape LINE's own draw step
   * uses, so the dynamic length/angle boxes work identically for editing an
   * existing line. Null for the line's midpoint grip (index 2), which moves
   * the whole line rather than placing a free endpoint.
   */
  draggingLineFixedEnd(): Vec2 | null {
    if (!this.drag || this.drag.objectType !== 'entity' || !this.drag.originalEntity) return null;
    const entity = this.drag.originalEntity;
    if (entity.type !== 'line' || this.drag.gripIndex >= 2) return null;
    return this.drag.gripIndex === 0 ? entity.end : entity.start;
  }

  /**
   * The fixed centre while dragging one of a circle's own four radius
   * grips — the same "fixed point, free point" shape CIRCLE's own draw step
   * uses, so the dynamic diameter box works identically for resizing an
   * existing circle. Null for the centre grip itself (index 0), which
   * moves the whole circle rather than resizing it.
   */
  draggingCircleFixedCenter(): Vec2 | null {
    if (!this.drag || this.drag.objectType !== 'entity' || !this.drag.originalEntity) return null;
    const entity = this.drag.originalEntity;
    if (entity.type !== 'circle' || this.drag.gripIndex === 0) return null;
    return entity.center;
  }

  /**
   * The fixed diagonal corner while dragging one of a rectangle's own four
   * corner grips — the same "first corner fixed, opposite corner follows the
   * cursor" shape RECTANGLE's own draw step uses, so the dynamic width/height
   * boxes work identically for resizing an existing rectangle. Null for a
   * whole-rectangle move (`mode === 'center'`) and for a mid-edge grip, which
   * stretches only one axis rather than placing a free corner.
   */
  draggingRectangleFixedCorner(): Vec2 | null {
    if (!this.drag || this.drag.objectType !== 'entity' || !this.drag.originalEntity) return null;
    const entity = this.drag.originalEntity;
    if (entity.type !== 'rectangle' || this.mode === 'center' || this.drag.gripIndex >= 4) return null;
    const corners = [
      entity.first,
      { x: entity.opposite.x, y: entity.first.y },
      entity.opposite,
      { x: entity.first.x, y: entity.opposite.y },
    ];
    return corners[(this.drag.gripIndex + 2) % 4];
  }

  /**
   * The fixed reference for one of a rectangle's four mid-edge grips: which
   * coordinate is the only one that moves (`x` for the left/right edges, `y`
   * for top/bottom), the unmoving opposite edge's value along that axis, and
   * the perpendicular span the edge itself runs — so a single dynamic input
   * box can sit at its midpoint. Null outside a mid-edge grip (indices 4-7).
   */
  draggingRectangleFixedEdge(): { axis: 'x' | 'y'; fixed: number; perpendicular: [number, number] } | null {
    if (!this.drag || this.drag.objectType !== 'entity' || !this.drag.originalEntity) return null;
    const entity = this.drag.originalEntity;
    if (entity.type !== 'rectangle' || this.drag.gripIndex < 4 || this.drag.gripIndex >= 8) return null;
    const { first, opposite } = entity;
    switch (this.drag.gripIndex - 4) {
      case 0: return { axis: 'y', fixed: opposite.y, perpendicular: [first.x, opposite.x] };
      case 1: return { axis: 'x', fixed: first.x, perpendicular: [first.y, opposite.y] };
      case 2: return { axis: 'y', fixed: first.y, perpendicular: [first.x, opposite.x] };
      default: return { axis: 'x', fixed: opposite.x, perpendicular: [first.y, opposite.y] };
    }
  }

  /**
   * A natural "from" point for Perpendicular/Tangent snap while a grip is
   * being dragged with no draw command active to supply one: a line's own
   * other endpoint, when the grip being dragged is one of its two ends. This
   * is the same point AutoCAD's own grip editing measures Perpendicular and
   * Tangent from — dragging a line's end onto a circle to make it tangent has
   * nothing else it could sensibly mean.
   */
  dragReferencePoint(): Vec3 | null {
    if (!this.drag || this.drag.objectType !== 'entity' || !this.drag.originalEntity) return null;
    const entity = this.drag.originalEntity;
    if (entity.type !== 'line' || this.drag.gripIndex >= 2) return null;
    const local = (this.drag.gripIndex === 0 ? entity.end : entity.start) as Vec2 & { z?: number };
    return localToWorld(entity.workPlane ?? WORLD_WORK_PLANE, local, local.z ?? 0);
  }

  applyRelativeDistance(distance: number): boolean {
    if (!this.drag || !Number.isFinite(distance) || this.drag.objectType !== 'entity' || !this.drag.originalEntity) return false;
    const entity = this.drag.originalEntity;
    let direction: Vec2 = { x: 1, y: 0 };
    if (entity.type === 'rectangle') {
      if (this.drag.gripIndex >= 4) direction = (this.drag.gripIndex - 4) % 2 === 0 ? { x: 0, y: 1 } : { x: 1, y: 0 };
      else {
        const opposite = this.drag.gripIndex === 0 ? entity.opposite : entity.first;
        const dx = this.drag.origin.x - opposite.x, dy = this.drag.origin.y - opposite.y;
        const length = Math.hypot(dx, dy) || 1;
        direction = { x: dx / length, y: dy / length };
      }
    } else if (entity.type === 'line' && this.drag.gripIndex < 2) {
      const other = this.drag.gripIndex === 0 ? entity.end : entity.start;
      const dx = this.drag.origin.x - other.x, dy = this.drag.origin.y - other.y;
      const length = Math.hypot(dx, dy) || 1;
      direction = { x: dx / length, y: dy / length };
    } else if (entity.type === 'circle' && this.drag.gripIndex > 0) {
      const dx = this.drag.origin.x - entity.center.x, dy = this.drag.origin.y - entity.center.y;
      const length = Math.hypot(dx, dy) || 1;
      direction = { x: dx / length, y: dy / length };
    }
    this.update({ x: this.drag.origin.x + direction.x * distance, y: this.drag.origin.y + direction.y * distance });
    return true;
  }

  applyRelativeOffset(offset: Vec2): boolean {
    if (!this.drag || this.drag.objectType !== 'entity') return false;
    this.update({ x: this.drag.origin.x + offset.x, y: this.drag.origin.y + offset.y });
    return true;
  }

  applyRelativePolar(distance: number, angleDegrees: number): boolean {
    if (!this.drag || !Number.isFinite(distance) || !Number.isFinite(angleDegrees) || this.drag.objectType !== 'entity') return false;
    const angle = angleDegrees * Math.PI / 180;
    this.update({ x: this.drag.origin.x + Math.cos(angle) * distance, y: this.drag.origin.y + Math.sin(angle) * distance });
    return true;
  }

  endpointGuide(cursor: Vec2, referencePointOverride: Vec2 | null = null): { lineStart: Vec2; lineEnd: Vec2; snapPoint: Vec2; angle: number } | null {
    if (!this.drag || this.drag.objectType !== 'entity' || !this.drag.originalEntity) return null;
    const referencePoint = referencePointOverride;
    if (!referencePoint) return null;
    const snapPoint = Math.abs(cursor.x - referencePoint.x) >= Math.abs(cursor.y - referencePoint.y)
      ? { x: cursor.x, y: referencePoint.y }
      : { x: referencePoint.x, y: cursor.y };
    return {
      lineStart: referencePoint,
      lineEnd: snapPoint,
      snapPoint,
      angle: Math.atan2(snapPoint.y - referencePoint.y, snapPoint.x - referencePoint.x) * 180 / Math.PI,
    };
  }

  endpointBase(referencePointOverride: Vec2 | null = null): Vec2 | null {
    if (!referencePointOverride) return null;
    return { ...referencePointOverride };
  }

  polylineEndpointAnchor(cursor: Vec2, tolerance: number): Vec2 | null {
    if (!this.drag || this.drag.objectType !== 'entity' || !this.drag.originalEntity || this.drag.originalEntity.type !== 'polyline' || this.drag.originalEntity.closed) return null;
    const original = this.drag.originalEntity;
    let best = tolerance;
    let result: Vec2 | null = null;
    for (let index = 0; index < original.vertices.length; index++) {
      if (index === this.drag.gripIndex) continue;
      const point = original.vertices[index];
      const distance = Math.hypot(cursor.x - point.x, cursor.y - point.y);
      if (distance <= best) {
        best = distance;
        result = { ...point };
      }
    }
    return result;
  }

  changedDimension(): string | null {
    if (!this.drag || this.mode === 'center') return null;
    if (this.drag.objectType === 'entity') {
      const entity = this.doc.getEntity(this.drag.objectId);
      if (entity?.type === 'line') {
        return `Length: ${Math.hypot(entity.end.x - entity.start.x, entity.end.y - entity.start.y).toFixed(2)} mm`;
      }
      if (entity?.type === 'rectangle') {
        const width = Math.abs(entity.opposite.x - entity.first.x);
        const height = Math.abs(entity.opposite.y - entity.first.y);
        const dx = Math.abs(this.lastDeltaX());
        const dy = Math.abs(this.lastDeltaY());
        return `Edge: ${(dx >= dy ? width : height).toFixed(2)} mm`;
      }
      if (entity?.type === 'circle') {
        return `R ${entity.radius.toFixed(2)} mm · Ø ${(entity.radius * 2).toFixed(2)} mm`;
      }
      if (entity?.type === 'dimension') {
        return `Dimension: ${dimensionGeometry(entity).text}`;
      }
      if (entity?.type === 'ellipse') {
        return `RX ${entity.radiusX.toFixed(2)} mm · RY ${entity.radiusY.toFixed(2)} mm`;
      }
      if (entity?.type === 'polyline') {
        const count = entity.closed ? entity.vertices.length - 1 : entity.vertices.length;
        const index = Math.min(this.drag.gripIndex, count - 1);
        const previous = entity.vertices[(index - 1 + count) % count];
        const current = entity.vertices[index];
        const next = entity.vertices[(index + 1) % count];
        if (current && next) {
          const nextLength = Math.hypot(next.x - current.x, next.y - current.y);
          if (!entity.closed && index === 0) return `Edge: ${nextLength.toFixed(2)} mm`;
          if (!entity.closed && index === count - 1 && previous) {
            return `Edge: ${Math.hypot(current.x - previous.x, current.y - previous.y).toFixed(2)} mm`;
          }
          if (previous) return `Edges: ${Math.hypot(current.x - previous.x, current.y - previous.y).toFixed(2)} / ${nextLength.toFixed(2)} mm`;
        }
      }
      return null;
    }
    const solid = this.doc.getSolid(this.drag.objectId);
    if (!solid) return null;
    const bounds = solidBounds(solid);
    const side = this.drag.gripIndex % 4;
    const length = side === 0 || side === 2
      ? bounds.maxX - bounds.minX
      : bounds.maxY - bounds.minY;
    return `Edge: ${Math.abs(length).toFixed(2)} mm`;
  }

  /** Angle of the edge a midpoint grip belongs to, so it can be drawn along it. */
  private static edgeAngle(a: Vec2, b: Vec2): number {
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  /**
   * Midpoint that keeps the endpoints' Z. `midpoint2` drops it, so on a line
   * whose ends sit at different depths the mid grip landed back on the UCS plane
   * (z = 0) and floated off the line — the stray third grip.
   */
  private static edgeMidpoint(a: Vec2, b: Vec2): Vec2 {
    const az = (a as Vec2 & { z?: number }).z;
    const bz = (b as Vec2 & { z?: number }).z;
    const mid = midpoint2(a, b);
    return az === undefined && bz === undefined ? mid : { ...mid, z: ((az ?? 0) + (bz ?? 0)) / 2 } as Vec2;
  }

  activeGrips(): Grip[] {
    const entity = this.doc.getSelectedEntities()[0];
    const solid = this.doc.getSelectedSolids()[0];
    // A Surface only ever has grips when nothing else is selected (selecting
    // an entity/solid always clears the other kinds — see Document.select*)
    // and its feature is a live loft — a Surface whose feature already got
    // baked to a mesh (by a transform this session's featureTransform.ts
    // fix doesn't cover, or one loaded from an older project file) has
    // nothing left to grip-edit this way.
    if (!entity && !solid && !this.mode) {
      const surface = this.doc.getSelectedSurfaces()[0];
      if (surface?.feature.kind === 'loft') {
        return embeddedLoftEntities(surface.feature).flatMap((embedded, objectIndex) =>
          gripsForEmbeddedEntity(embedded).map((grip) => ({ ...grip, index: objectIndex * 100 + grip.index })));
      }
    }
    if (entity?.type === 'point' && !this.mode) {
      return [{ point: entity.position, index: 0, shape: 'square' }];
    }
    if (entity?.type === 'insert' && !this.mode) {
      return [{ point: entity.position, index: 0, shape: 'square' }];
    }
    // Lines and rectangles expose their ordinary AutoCAD-like edit grips as
    // soon as they are selected; no context-menu mode is required.
    if (entity?.type === 'line' && this.mode === 'middle') {
      return [{ point: GripController.edgeMidpoint(entity.start, entity.end), index: 0, shape: 'edge', angle: GripController.edgeAngle(entity.start, entity.end) }];
    }
    if (entity?.type === 'line') return [
      { point: entity.start, index: 0, shape: 'square' },
      { point: entity.end, index: 1, shape: 'square' },
      { point: GripController.edgeMidpoint(entity.start, entity.end), index: 2, shape: 'edge', angle: GripController.edgeAngle(entity.start, entity.end) },
    ];
    if (entity?.type === 'rectangle' && this.mode === 'center') {
      return [{ point: GripController.edgeMidpoint(entity.first, entity.opposite), index: 0, shape: 'square' }];
    }
    if (entity?.type === 'rectangle') {
      // Keep the corners' Z so a rectangle drawn off the work plane grips in place.
      const z = (entity.first as Vec2 & { z?: number }).z ?? (entity.opposite as Vec2 & { z?: number }).z;
      const corner = (x: number, y: number): Vec2 => (z === undefined ? { x, y } : { x, y, z } as Vec2);
      const corners = [
        corner(entity.first.x, entity.first.y),
        corner(entity.opposite.x, entity.first.y),
        corner(entity.opposite.x, entity.opposite.y),
        corner(entity.first.x, entity.opposite.y),
      ];
      return [
        ...corners.map((point, index) => ({ point, index, shape: 'square' as const })),
        ...corners.map((point, index) => ({
          point: GripController.edgeMidpoint(point, corners[(index + 1) % 4]),
          index: index + 4,
          shape: 'edge' as const,
          angle: GripController.edgeAngle(point, corners[(index + 1) % 4]),
        })),
      ];
    }
    if (entity?.type === 'ellipse' && !this.mode) {
      return [
        { point: entity.center, index: 0, shape: 'square' },
        ...ellipseAxisPoints(entity).map((point, index) => ({ point, index: index + 1, shape: 'square' as const })),
      ];
    }
    if (entity?.type === 'circle' && !this.mode) {
      // The quadrant grips must keep the centre's Z, or a circle drawn off the
      // work plane (in another UCS) shows its rim grips floating on the plane.
      const z = (entity.center as Vec2 & { z?: number }).z;
      const result: Grip[] = [{ point: entity.center, index: 0, shape: 'square' }];
      for (let i = 0; i < 4; i++) {
        const angle = i * Math.PI / 2;
        const point: Vec2 = { x: entity.center.x + Math.cos(angle) * entity.radius, y: entity.center.y + Math.sin(angle) * entity.radius };
        result.push({ point: z === undefined ? point : { ...point, z } as Vec2, index: i + 1, shape: 'square' });
      }
      return result;
    }
    if ((entity?.type === 'octagon' || entity?.type === 'polyline') && !this.mode) {
      const vertices = entity.type === 'polyline' && entity.closed
        ? entity.vertices.slice(0, -1)
        : entity.vertices;
      return vertices.map((point, index) => ({ point, index, shape: 'square' }));
    }
    if (entity?.type === 'bezier' && !this.mode) {
      // Index 0 is the shared start; each segment after it contributes three
      // more grips (its own control1, control2, end) at 1 + 3*segmentIndex.
      const points = [entity.start, ...entity.segments.flatMap((segment) => [segment.control1, segment.control2, segment.end])];
      return points.map((point, index) => ({ point, index, shape: 'square' as const }));
    }
    if (entity?.type === 'arc' && !this.mode) { const z=(entity.center as Vec2 & {z?:number}).z; const point=(a:number):Vec2=>{const p:Vec2={x:entity.center.x+Math.cos(a)*entity.radius,y:entity.center.y+Math.sin(a)*entity.radius}; return z===undefined?p:{...p,z} as Vec2;}; return [{point:entity.center,index:0,shape:'square'},{point:point(entity.startAngle),index:1,shape:'square'},{point:point(entity.startAngle+entity.sweepAngle),index:2,shape:'square'},{point:point(entity.startAngle+entity.sweepAngle/2),index:3,shape:'edge'}]; }
    if (entity?.type === 'text' && !this.mode) return [{point:entity.position,index:0,shape:'square'}];
    if (entity?.type === 'dimension' && !this.mode) {
      const geometry = dimensionGeometry(entity);
      if (entity.dimensionKind === 'angular') {
        return [
          { point: entity.start, index: 0, shape: 'square' },
          { point: entity.end, index: 1, shape: 'square' },
          { point: entity.offset, index: 2, shape: 'square' },
          { point: entity.arcPoint ?? geometry.dimensionLine[Math.floor(geometry.dimensionLine.length / 2)], index: 3, shape: 'edge' },
          { point: geometry.textPoint, index: 4, shape: 'square' },
        ];
      }
      const grips: Grip[] = [
        { point: entity.start, index: 0, shape: 'square' },
        { point: entity.end, index: 1, shape: 'square' },
        { point: entity.dimensionKind === 'aligned' ? midpoint2(geometry.dimensionLine[0], geometry.dimensionLine[1]) : entity.offset, index: 2, shape: 'edge' },
      ];
      // A radial dimension already uses its leader endpoint as the text grip.
      // Linear and aligned dimensions need a separate grip: moving the text
      // must not also move the dimension line.
      if (entity.dimensionKind === 'linear' || entity.dimensionKind === 'aligned') {
        grips.push({ point: geometry.textPoint, index: 3, shape: 'square' });
      }
      return grips;
    }
    if (!entity && solid && !this.mode) {
      const b = solidBounds(solid);
      return [b.minZ, b.maxZ].flatMap((z, level) => [
        { x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY },
        { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY },
      ].map((point, index) => ({ point: { ...point, z }, index: level * 4 + index, shape: 'square' as const })));
    }
    if (!this.mode) return [];
    if (!entity && solid) {
      const b = solidBounds(solid);
      const levels = [b.minZ, b.maxZ];
      if (this.mode === 'center') return levels.map((z, index) => ({ point: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, z }, index }));
      const base = this.mode === 'end'
        ? [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }]
        : [{ x: (b.minX + b.maxX) / 2, y: b.minY }, { x: b.maxX, y: (b.minY + b.maxY) / 2 }, { x: (b.minX + b.maxX) / 2, y: b.maxY }, { x: b.minX, y: (b.minY + b.maxY) / 2 }];
      return levels.flatMap((z, level) => base.map((point, index) => ({ point: { ...point, z }, index: level * 4 + index })));
    }
    if (!entity) return [];
    if (this.mode === 'center' && entity.type === 'circle') return [{ point: entity.center, index: 0 }];
    if (this.mode === 'end' && entity.type === 'polyline' && !entity.closed && entity.vertices.length > 0) {
      return [{ point: entity.vertices[0], index: 0 }, { point: entity.vertices.at(-1)!, index: entity.vertices.length - 1 }];
    }
    return [];
  }

  visibleGrips(): Grip[] {
    const selected = this.doc.getSelectedEntities();
    if (selected.length <= 1) return this.activeGrips();
    const grips: Grip[] = [];
    selected.forEach((entity, objectIndex) => {
      const base = objectIndex * 100;
      if (entity.type === 'line') {
        grips.push(
          { point: entity.start, index: base, shape: 'square' },
          { point: entity.end, index: base + 1, shape: 'square' },
          { point: midpoint2(entity.start, entity.end), index: base + 2, shape: 'edge', angle: GripController.edgeAngle(entity.start, entity.end) },
        );
      } else if (entity.type === 'rectangle') {
        const corners = [
          entity.first,
          { x: entity.opposite.x, y: entity.first.y },
          entity.opposite,
          { x: entity.first.x, y: entity.opposite.y },
        ];
        corners.forEach((point, index) => {
          grips.push({ point, index: base + index, shape: 'square' });
          grips.push({
            point: midpoint2(point, corners[(index + 1) % 4]),
            index: base + index + 4,
            shape: 'edge',
            angle: GripController.edgeAngle(point, corners[(index + 1) % 4]),
          });
        });
      } else if (entity.type === 'circle') {
        grips.push({ point: entity.center, index: base, shape: 'square' });
        for (let i = 0; i < 4; i++) {
          const angle = i * Math.PI / 2;
          grips.push({
            point: { x: entity.center.x + Math.cos(angle) * entity.radius, y: entity.center.y + Math.sin(angle) * entity.radius },
            index: base + i + 1,
            shape: 'square',
          });
        }
      } else if (entity.type === 'insert') {
        grips.push({ point: entity.position, index: base, shape: 'square' });
      } else {
        const points = getEntityPoints(entity);
        points.forEach((point, index) => grips.push({ point, index: base + index, shape: 'square' }));
      }
    });
    return grips;
  }

  nearest2d(point: Vec2, tolerance: number): number {
    // `point` is a real world position; a grip's own point is local to the
    // selected entity's work plane, same as its vertices or control points —
    // which is the world position only when that plane is the world's.
    const plane = this.doc.getSelectedEntities()[0]?.workPlane ?? WORLD_WORK_PLANE;
    let result = -1;
    let best = tolerance;
    for (const grip of this.activeGrips()) {
      const world = localToWorld(plane, grip.point, grip.point.z ?? 0);
      const distance = Math.hypot(point.x - world.x, point.y - world.y);
      if (distance <= best) { best = distance; result = grip.index; }
    }
    return result;
  }

  begin(entity: Entity | undefined, solid: Solid | undefined, gripIndex: number, origin: Vec2, surface?: Surface): boolean {
    if (!entity && !solid && !surface) return false;
    if (surface) {
      const embeddedIndex = Math.floor(gripIndex / 100);
      const target = embeddedLoftEntities(surface.feature)[embeddedIndex];
      if (!target) return false;
      this.drag = {
        objectId: surface.id,
        objectType: 'surface',
        gripIndex: gripIndex % 100,
        origin: { ...origin },
        embeddedIndex,
        originalEmbeddedEntity: cloneEntity(target),
        originalPositions: surface.mesh.positions.slice(),
        originalIndices: surface.mesh.indices.slice(),
        originalFeature: JSON.parse(JSON.stringify(surface.feature)),
        originalExact: surface.exact ? { ...surface.exact, shape: { ...surface.exact.shape } } : undefined,
        originalRevision: surface.revision,
      };
      this.changed = false;
      return true;
    }
    this.drag = {
      objectId: (entity ?? solid)!.id,
      objectType: entity ? 'entity' : 'solid',
      gripIndex,
      origin: { ...origin },
      originalEntity: entity ? cloneEntity(entity) : undefined,
      originalPositions: solid?.mesh.positions.slice(),
      originalIndices: solid?.mesh.indices.slice(),
      originalFeature: solid ? JSON.parse(JSON.stringify(solid.feature)) : undefined,
      originalExact: solid?.exact ? cloneSolid(solid).exact : undefined,
      originalRevision: solid?.revision,
    };
    this.changed = false;
    return true;
  }

  /** The work plane of whichever embedded entity is currently being dragged
   *  — null outside a surface drag. Each of a loft's embedded entities can
   *  carry its own plane (that's how a hand-drawn guide is normally built,
   *  mirroring one rail into another), so grip-editing one has to read and
   *  write cursor positions in THAT plane, not a single shared one. */
  draggingEmbeddedPlane(): WorkPlane | null {
    if (!this.drag || this.drag.objectType !== 'surface' || !this.drag.originalEmbeddedEntity) return null;
    return this.drag.originalEmbeddedEntity.workPlane ?? WORLD_WORK_PLANE;
  }

  update(cursor: Vec2): void {
    if (!this.drag) return;
    const dx = cursor.x - this.drag.origin.x;
    const dy = cursor.y - this.drag.origin.y;
    if (this.drag.objectType === 'solid') this.updateSolid(dx, dy);
    else if (this.drag.objectType === 'surface') this.updateSurface(cursor, dx, dy);
    else this.updateEntity(cursor, dx, dy);
    this.changed = true;
    this.doc.notify();
  }

  commit(): void {
    if (!this.drag) return;
    if (this.changed && this.drag.objectType === 'entity' && this.drag.originalEntity) {
      const current = this.doc.getEntity(this.drag.objectId);
      if (current) this.history.recordApplied(new UpdateEntityEdit('Edit grip', this.drag.originalEntity, cloneEntity(current)));
    } else if (this.changed && this.drag.objectType === 'solid' && this.drag.originalPositions) {
      const current = this.doc.getSolid(this.drag.objectId);
      if (current) {
        const before = cloneSolid(current);
        before.mesh.positions = this.drag.originalPositions.slice();
        if (this.drag.originalIndices) before.mesh.indices = this.drag.originalIndices.slice();
        if (this.drag.originalFeature) before.feature = JSON.parse(JSON.stringify(this.drag.originalFeature));
        before.exact = this.drag.originalExact ? { ...this.drag.originalExact, shape: { ...this.drag.originalExact.shape } } : undefined;
        if (this.drag.originalRevision !== undefined) before.revision = this.drag.originalRevision;
        this.history.recordApplied(new UpdateSolidEdit('Edit solid grip', before, cloneSolid(current)));
      }
    } else if (this.changed && this.drag.objectType === 'surface' && this.drag.originalPositions) {
      const current = this.doc.getSurface(this.drag.objectId);
      if (current) {
        const before = cloneSurfaceValue(current);
        before.mesh = { positions: this.drag.originalPositions.slice(), indices: (this.drag.originalIndices ?? current.mesh.indices).slice() };
        if (this.drag.originalFeature) before.feature = JSON.parse(JSON.stringify(this.drag.originalFeature));
        before.exact = this.drag.originalExact ? { ...this.drag.originalExact, shape: { ...this.drag.originalExact.shape } } : undefined;
        if (this.drag.originalRevision !== undefined) before.revision = this.drag.originalRevision;
        // The very last update()'s kernel rebuild may still be in flight — it
        // will land a moment after this commit (guarded by dragRebuildToken,
        // which a null this.drag already fails once this method returns), a
        // brief visual catch-up rather than a correctness problem: the
        // feature tree recorded here is already the final one, only the
        // cached mesh snapshot might trail it by one rebuild.
        this.history.recordApplied(new UpdateSurfaceEdit('Edit surface grip', before, cloneSurfaceValue(current)));
      }
    }
    this.drag = null;
    this.changed = false;
  }

  cancel(): void {
    if (!this.drag) return;
    if (this.drag.objectType === 'entity' && this.drag.originalEntity) {
      const index = this.doc.entities.findIndex((entity) => entity.id === this.drag!.objectId);
      if (index >= 0) this.doc.entities[index] = cloneEntity(this.drag.originalEntity);
    } else if (this.drag.objectType === 'solid' && this.drag.originalPositions) {
      const solid = this.doc.getSolid(this.drag.objectId);
      if (solid) {
        solid.mesh.positions = this.drag.originalPositions.slice();
        if (this.drag.originalIndices) solid.mesh.indices = this.drag.originalIndices.slice();
        if (this.drag.originalFeature) solid.feature = JSON.parse(JSON.stringify(this.drag.originalFeature));
        solid.exact = this.drag.originalExact ? { ...this.drag.originalExact, shape: { ...this.drag.originalExact.shape } } : undefined;
        if (this.drag.originalRevision !== undefined) solid.revision = this.drag.originalRevision;
      }
    } else if (this.drag.objectType === 'surface' && this.drag.originalPositions) {
      // Invalidates any rebuild still in flight for the drag being thrown
      // away — updateSurface's callback checks only this token (not
      // whether a drag is still active, so a late rebuild can still land
      // after a normal commit()), so without bumping it here a rebuild for
      // the very position just being reverted could still resolve a moment
      // later and silently overwrite the restored mesh right back to it.
      this.dragRebuildToken++;
      const surface = this.doc.getSurface(this.drag.objectId);
      if (surface) {
        surface.mesh = { positions: this.drag.originalPositions.slice(), indices: (this.drag.originalIndices ?? surface.mesh.indices).slice() };
        if (this.drag.originalFeature) surface.feature = JSON.parse(JSON.stringify(this.drag.originalFeature));
        surface.exact = this.drag.originalExact ? { ...this.drag.originalExact, shape: { ...this.drag.originalExact.shape } } : undefined;
        if (this.drag.originalRevision !== undefined) surface.revision = this.drag.originalRevision;
      }
    }
    this.drag = null;
    this.changed = false;
    this.doc.notify();
  }

  clear(): void { this.cancel(); this.mode = null; this.hoveredGrip = -1; }

  /**
   * Live-rebuilds a Surface while one of its embedded rail/guide curves is
   * being dragged. Two parts, at two speeds: the dragged entity's own point
   * moves into the feature tree immediately and synchronously (so the Model
   * Tree and anything else reading surface.feature is never stale), while
   * the real B-rep rebuild — genuine OpenCascade surface fitting, not a
   * cheap affine transform — runs async per DragEditing.ts's own
   * updateExtrudePreview precedent, guarded by dragRebuildToken so a
   * slower/stale rebuild can never clobber a newer one or one that already
   * ended.
   */
  private updateSurface(cursor: Vec2, dx: number, dy: number): void {
    if (!this.drag || this.drag.objectType !== 'surface' || !this.drag.originalEmbeddedEntity || this.drag.embeddedIndex === undefined) return;
    const surface = this.doc.getSurface(this.drag.objectId);
    if (!surface || surface.feature.kind !== 'loft') return;
    const draggedEntity = applyEmbeddedEntityGripDrag(this.drag.originalEmbeddedEntity, this.drag.gripIndex, cursor, dx, dy);
    const updatedFeature = setEmbeddedLoftEntity(surface.feature, this.drag.embeddedIndex, draggedEntity);
    surface.feature = updatedFeature;

    const token = ++this.dragRebuildToken;
    const targetSurfaceId = surface.id;
    const targetRevision = surface.revision + 1;
    void buildExactFeature(updatedFeature, targetRevision, /* allowOpenShell */ true).then((exact) => {
      // Only the token guards staleness here — NOT whether a drag is still
      // active. A real OpenCascade rebuild of a loft this complex can take
      // over a second (measured against the user's own real bowl data), so
      // the LAST rebuild routinely resolves after commit() already ended
      // the drag; discarding it on that basis alone left the mesh frozen at
      // a stale shape forever — reported directly ("polyline se
      // neprekreslila" after moving two grip points and releasing before
      // the rebuild caught up). commit() itself does not bump the token, so
      // this still lands and the mesh catches up moments later, matching
      // the feature tree it already committed. cancel() DOES bump the
      // token (see cancel() below), so a rebuild in flight for a drag the
      // user explicitly threw away is correctly discarded instead of
      // clobbering the just-restored mesh.
      if (!exact || token !== this.dragRebuildToken) return;
      const live = this.doc.getSurface(targetSurfaceId);
      if (!live) return;
      live.mesh = exact.mesh;
      live.exact = exact.exact;
      live.revision = targetRevision;
      this.doc.notify();
    });
  }

  private updateEntity(cursor: Vec2, dx: number, dy: number): void {
    if (!this.drag?.originalEntity) return;
    const entity = this.doc.getEntity(this.drag.objectId);
    const original = this.drag.originalEntity;
    if (!entity) return;
    if (entity.type === 'point' && original.type === 'point') {
      entity.position = { ...cursor };
    } else if (entity.type === 'insert' && original.type === 'insert') {
      entity.position = { ...cursor };
    } else if (entity.type === 'line' && original.type === 'line') {
      if (this.mode === 'middle' || this.drag.gripIndex === 2) {
        entity.start = { x: original.start.x + dx, y: original.start.y + dy };
        entity.end = { x: original.end.x + dx, y: original.end.y + dy };
      } else if (this.drag.gripIndex === 0) entity.start = { ...cursor };
      else if (this.drag.gripIndex === 1) entity.end = { ...cursor };
    } else if (entity.type === 'circle' && original.type === 'circle') {
      if (this.mode === 'center' || this.drag.gripIndex === 0) {
        entity.center = { x: original.center.x + dx, y: original.center.y + dy };
      } else {
        entity.radius = Math.max(0.0001, Math.hypot(cursor.x - original.center.x, cursor.y - original.center.y));
      }
    } else if (entity.type === 'ellipse' && original.type === 'ellipse') {
      if (this.mode === 'center' || this.drag.gripIndex === 0) {
        entity.center = { x: original.center.x + dx, y: original.center.y + dy };
      } else {
        // Grips 1 and 3 sit on the X axis, 2 and 4 on the Y; measure the cursor
        // in the ellipse's own frame so a rotated one still resizes correctly.
        const cos = Math.cos(-original.rotation), sin = Math.sin(-original.rotation);
        const ox = cursor.x - original.center.x, oy = cursor.y - original.center.y;
        const local = { x: ox * cos - oy * sin, y: ox * sin + oy * cos };
        if (this.drag.gripIndex % 2 === 1) entity.radiusX = Math.max(0.0001, Math.abs(local.x));
        else entity.radiusY = Math.max(0.0001, Math.abs(local.y));
      }
    } else if (entity.type === 'polyline' && original.type === 'polyline') {
      entity.vertices[this.drag.gripIndex] = { ...cursor };
      if (entity.closed && this.drag.gripIndex === 0) {
        entity.vertices[entity.vertices.length - 1] = { ...cursor };
      }
    } else if (entity.type === 'bezier' && original.type === 'bezier') {
      // Index 0 is the shared start; grip i>0 is field (i-1)%3 of segment
      // floor((i-1)/3) — the same layout activeGrips() lays the points out in.
      const gripIndex = this.drag.gripIndex;
      if (gripIndex === 0) entity.start = { ...cursor };
      else {
        const segmentIndex = Math.floor((gripIndex - 1) / 3);
        const field = (gripIndex - 1) % 3;
        const segment = entity.segments[segmentIndex];
        if (field === 0) segment.control1 = { ...cursor };
        else if (field === 1) segment.control2 = { ...cursor };
        else segment.end = { ...cursor };
      }
    } else if(entity.type==='arc'&&original.type==='arc'){
      if(this.drag.gripIndex===0)entity.center={x:original.center.x+dx,y:original.center.y+dy};
      else if(this.drag.gripIndex===3){
        // Midpoint grip: reshape via the arc's own start/end (the sagitta
        // construction ARC_SER uses), so both endpoints stay put — unlike
        // grips 1/2, which move whichever endpoint they belong to.
        const point=(a:number):Vec2=>({x:original.center.x+Math.cos(a)*original.radius,y:original.center.y+Math.sin(a)*original.radius});
        const arc=arcFromSagitta(point(original.startAngle),point(original.startAngle+original.sweepAngle),cursor);
        if(arc){entity.center=arc.center;entity.radius=arc.radius;entity.startAngle=arc.startAngle;entity.sweepAngle=arc.sweepAngle;}
      }
      else {const a=Math.atan2(cursor.y-original.center.y,cursor.x-original.center.x);entity.radius=Math.max(.001,Math.hypot(cursor.x-original.center.x,cursor.y-original.center.y));if(this.drag.gripIndex===1){entity.startAngle=a;let s=original.startAngle+original.sweepAngle-a;while(s<=0)s+=Math.PI*2;entity.sweepAngle=s;}else {let s=a-original.startAngle;if(s<=0)s+=Math.PI*2;entity.sweepAngle=s;}}
    } else if(entity.type==='text'&&original.type==='text')entity.position={...cursor};
    else if (entity.type === 'dimension' && original.type === 'dimension') {
      if (this.drag.gripIndex === 0) entity.start = { ...cursor };
      else if (this.drag.gripIndex === 1) entity.end = { ...cursor };
      else if (this.drag.gripIndex === 2) entity.offset = { ...cursor };
      else if (entity.dimensionKind === 'angular' && this.drag.gripIndex === 3) entity.arcPoint = { ...cursor };
      else entity.textPosition = { ...cursor };
    }
    else if (entity.type === 'rectangle' && original.type === 'rectangle') {
      if (this.mode === 'center') {
        entity.first = { x: original.first.x + dx, y: original.first.y + dy };
        entity.opposite = { x: original.opposite.x + dx, y: original.opposite.y + dy };
      } else if (this.drag.gripIndex < 4) {
        const corners = [
          original.first,
          { x: original.opposite.x, y: original.first.y },
          original.opposite,
          { x: original.first.x, y: original.opposite.y },
        ];
        const opposite = corners[(this.drag.gripIndex + 2) % 4];
        entity.first = { ...opposite };
        entity.opposite = { ...cursor };
      } else {
        // Mid-edge grips stretch only the selected side, keeping the opposite
        // side fixed. Indices 4..7 correspond to bottom/right/top/left.
        entity.first = { ...original.first };
        entity.opposite = { ...original.opposite };
        const side = this.drag.gripIndex - 4;
        if (side === 0) entity.first.y = cursor.y;
        if (side === 1) entity.opposite.x = cursor.x;
        if (side === 2) entity.opposite.y = cursor.y;
        if (side === 3) entity.first.x = cursor.x;
      }
    }
  }

  private lastDeltaX(): number {
    if (!this.drag?.originalEntity) return 0;
    const current = this.doc.getEntity(this.drag.objectId);
    if (current?.type === 'rectangle' && this.drag.originalEntity.type === 'rectangle') {
      return current.opposite.x - this.drag.originalEntity.opposite.x;
    }
    return 0;
  }

  private lastDeltaY(): number {
    if (!this.drag?.originalEntity) return 0;
    const current = this.doc.getEntity(this.drag.objectId);
    if (current?.type === 'rectangle' && this.drag.originalEntity.type === 'rectangle') {
      return current.opposite.y - this.drag.originalEntity.opposite.y;
    }
    return 0;
  }

  private updateSolid(dx: number, dy: number): void {
    if (!this.drag?.originalPositions) return;
    const solid = this.doc.getSolid(this.drag.objectId);
    if (!solid) return;
    const positions = this.drag.originalPositions.slice();
    const b = solidBounds({ ...solid, mesh: { ...solid.mesh, positions: this.drag.originalPositions } });
    let appliedScaleX = 1;
    let appliedScaleY = 1;
    let scaleAnchorX = 0;
    let scaleAnchorY = 0;
    const anchors = [[b.maxX, b.maxY], [b.minX, b.maxY], [b.minX, b.minY], [b.maxX, b.minY]];
    if (this.mode === 'center') {
      for (let i = 0; i < positions.length; i += 3) { positions[i] += dx; positions[i + 1] += dy; }
    } else {
      const side = this.drag.gripIndex % 4;
      const dragged = [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]];
      if (this.mode === 'end') {
        const anchor = anchors[side];
        scaleAnchorX = anchor[0];
        scaleAnchorY = anchor[1];
        const start = dragged[side];
        const sx = (start[0] + dx - anchor[0]) / (start[0] - anchor[0] || 1);
        const sy = (start[1] + dy - anchor[1]) / (start[1] - anchor[1] || 1);
        appliedScaleX = sx;
        appliedScaleY = sy;
        for (let i = 0; i < positions.length; i += 3) {
          positions[i] = anchor[0] + (positions[i] - anchor[0]) * sx;
          positions[i + 1] = anchor[1] + (positions[i + 1] - anchor[1]) * sy;
        }
      } else if (this.mode === 'middle') {
        if (side === 0) { appliedScaleY = (b.minY + dy - b.maxY) / (b.minY - b.maxY || 1); scaleAnchorY = b.maxY; }
        if (side === 1) { appliedScaleX = (b.maxX + dx - b.minX) / (b.maxX - b.minX || 1); scaleAnchorX = b.minX; }
        if (side === 2) { appliedScaleY = (b.maxY + dy - b.minY) / (b.maxY - b.minY || 1); scaleAnchorY = b.minY; }
        if (side === 3) { appliedScaleX = (b.minX + dx - b.maxX) / (b.minX - b.maxX || 1); scaleAnchorX = b.maxX; }
        for (let i = 0; i < positions.length; i += 3) {
          if (side === 0) positions[i + 1] = b.maxY + (positions[i + 1] - b.maxY) * ((b.minY + dy - b.maxY) / (b.minY - b.maxY || 1));
          if (side === 1) positions[i] = b.minX + (positions[i] - b.minX) * ((b.maxX + dx - b.minX) / (b.maxX - b.minX || 1));
          if (side === 2) positions[i + 1] = b.minY + (positions[i + 1] - b.minY) * ((b.maxY + dy - b.minY) / (b.maxY - b.minY || 1));
          if (side === 3) positions[i] = b.maxX + (positions[i] - b.maxX) * ((b.minX + dx - b.maxX) / (b.minX - b.maxX || 1));
        }
      }
    }
    solid.mesh.positions = positions;
    if (this.drag.originalIndices) {
      solid.mesh.indices = this.drag.originalIndices.slice();
      if (appliedScaleX * appliedScaleY < 0) {
        for (let index = 0; index + 2 < solid.mesh.indices.length; index += 3) {
          const swap = solid.mesh.indices[index + 1];
          solid.mesh.indices[index + 1] = solid.mesh.indices[index + 2];
          solid.mesh.indices[index + 2] = swap;
        }
      }
    }
    const originalFeature = this.drag.originalFeature;
    if (originalFeature && this.mode === 'center') {
      // Moving the whole body moves the feature's edge references and saved
      // source mesh too, so a later Chamfer/Fillet removal still lands exactly
      // where the body now is.
      solid.feature = translatedFeature(originalFeature, { x: dx, y: dy, z: 0 }) ?? { kind: 'mesh' };
    } else if (originalFeature?.kind === 'extrusion') {
      const feature = JSON.parse(JSON.stringify(originalFeature)) as typeof originalFeature;
      const anchorX = this.mode === 'end' ? anchors[this.drag.gripIndex % 4][0] : (this.drag.gripIndex % 4 === 1 ? b.minX : b.maxX);
      const anchorY = this.mode === 'end' ? anchors[this.drag.gripIndex % 4][1] : (this.drag.gripIndex % 4 === 2 ? b.minY : b.maxY);
      feature.transform.scaleX *= appliedScaleX;
      feature.transform.scaleY *= appliedScaleY;
      feature.transform.translateX = anchorX + (feature.transform.translateX - anchorX) * appliedScaleX;
      feature.transform.translateY = anchorY + (feature.transform.translateY - anchorY) * appliedScaleY;
      solid.feature = feature;
    } else {
      // Non-uniform grip deformation has no representation in most recipes.
      // Marking it as a mesh is safer than retaining a feature that would
      // regenerate a different shape.
      solid.feature = { kind: 'mesh' };
    }
    const sourceRevision = this.drag.originalRevision ?? solid.revision;
    const nextRevision = sourceRevision + 1;
    const transform = this.mode === 'center'
      ? translationAffine({ x: dx, y: dy, z: 0 })
      : scaleAffine(
        { x: scaleAnchorX, y: scaleAnchorY, z: 0 },
        { x: appliedScaleX, y: appliedScaleY, z: 1 },
      );
    solid.exact = transformedExactGeometry(this.drag.originalExact, sourceRevision, transform, nextRevision);
    solid.revision = nextRevision;
  }
}
