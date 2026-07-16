import type { Document } from '../core/Document';
import { cloneEntity, dimensionGeometry, getEntityPoints, type Entity, type Solid, type SolidFeature } from '../core/entities/types';
import type { CommandHistory } from '../core/history/CommandHistory';
import { UpdateEntityEdit, UpdateSolidEdit, cloneSolid } from '../core/history/edits';
import { midpoint2, type Vec2 } from '../math/geometry';
import { solidBounds } from './PickingService';

export type GripMode = 'end' | 'center' | 'middle';
/** `angle` (radians) orients an edge grip along the edge it sits on. */
export type Grip = { point: Vec2 & { z?: number }; index: number; shape?: 'square' | 'edge'; angle?: number };

type DragState = {
  objectId: string;
  objectType: 'entity' | 'solid';
  gripIndex: number;
  origin: Vec2;
  originalEntity?: Entity;
  originalPositions?: Float32Array;
  originalFeature?: SolidFeature;
  originalRevision?: number;
};

export class GripController {
  mode: GripMode | null = null;
  hoveredGrip = -1;
  private drag: DragState | null = null;
  private changed = false;

  constructor(private readonly doc: Document, private readonly history: CommandHistory) {}

  get isDragging(): boolean { return this.drag !== null; }
  get draggingObjectId(): string | null { return this.drag?.objectId ?? null; }
  get draggingGripIndex(): number | null { return this.drag?.gripIndex ?? null; }
  get draggingOrigin(): Vec2 | null { return this.drag ? { ...this.drag.origin } : null; }

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
        return `Dimension: ${Math.hypot(entity.end.x - entity.start.x, entity.end.y - entity.start.y).toFixed(entity.precision)}`;
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

  activeGrips(): Grip[] {
    const entity = this.doc.getSelectedEntities()[0];
    const solid = this.doc.getSelectedSolids()[0];
    // Lines and rectangles expose their ordinary AutoCAD-like edit grips as
    // soon as they are selected; no context-menu mode is required.
    if (entity?.type === 'line' && this.mode === 'middle') {
      return [{ point: midpoint2(entity.start, entity.end), index: 0, shape: 'edge', angle: GripController.edgeAngle(entity.start, entity.end) }];
    }
    if (entity?.type === 'line') return [
      { point: entity.start, index: 0, shape: 'square' },
      { point: entity.end, index: 1, shape: 'square' },
      { point: midpoint2(entity.start, entity.end), index: 2, shape: 'edge', angle: GripController.edgeAngle(entity.start, entity.end) },
    ];
    if (entity?.type === 'rectangle' && this.mode === 'center') {
      return [{ point: midpoint2(entity.first, entity.opposite), index: 0, shape: 'square' }];
    }
    if (entity?.type === 'rectangle') {
      const corners = [
        entity.first,
        { x: entity.opposite.x, y: entity.first.y },
        entity.opposite,
        { x: entity.first.x, y: entity.opposite.y },
      ];
      return [
        ...corners.map((point, index) => ({ point, index, shape: 'square' as const })),
        ...corners.map((point, index) => ({
          point: midpoint2(point, corners[(index + 1) % 4]),
          index: index + 4,
          shape: 'edge' as const,
          angle: GripController.edgeAngle(point, corners[(index + 1) % 4]),
        })),
      ];
    }
    if (entity?.type === 'circle' && !this.mode) {
      const result: Grip[] = [{ point: entity.center, index: 0, shape: 'square' }];
      for (let i = 0; i < 4; i++) {
        const angle = i * Math.PI / 2;
        result.push({
          point: {
            x: entity.center.x + Math.cos(angle) * entity.radius,
            y: entity.center.y + Math.sin(angle) * entity.radius,
          },
          index: i + 1,
          shape: 'square',
        });
      }
      return result;
    }
    if ((entity?.type === 'octagon' || entity?.type === 'polyline') && !this.mode) {
      const vertices = entity.type === 'polyline' && entity.closed
        ? entity.vertices.slice(0, -1)
        : entity.vertices;
      return vertices.map((point, index) => ({ point, index, shape: 'square' }));
    }
    if (entity?.type === 'bezier' && !this.mode) return [entity.start,entity.control1,entity.control2,entity.end].map((point,index)=>({point,index,shape:'square'}));
    if (entity?.type === 'arc' && !this.mode) { const point=(a:number)=>({x:entity.center.x+Math.cos(a)*entity.radius,y:entity.center.y+Math.sin(a)*entity.radius}); return [{point:entity.center,index:0,shape:'square'},{point:point(entity.startAngle),index:1,shape:'square'},{point:point(entity.startAngle+entity.sweepAngle),index:2,shape:'square'}]; }
    if (entity?.type === 'text' && !this.mode) return [{point:entity.position,index:0,shape:'square'}];
    if (entity?.type === 'dimension' && !this.mode) {
      const geometry = dimensionGeometry(entity);
      return [
        { point: entity.start, index: 0, shape: 'square' },
        { point: entity.end, index: 1, shape: 'square' },
        { point: entity.dimensionKind === 'aligned' ? midpoint2(geometry.dimensionLine[0], geometry.dimensionLine[1]) : entity.offset, index: 2, shape: 'edge' },
      ];
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
      } else {
        const points = getEntityPoints(entity);
        points.forEach((point, index) => grips.push({ point, index: base + index, shape: 'square' }));
      }
    });
    return grips;
  }

  nearest2d(point: Vec2, tolerance: number): number {
    let result = -1;
    let best = tolerance;
    for (const grip of this.activeGrips()) {
      const distance = Math.hypot(point.x - grip.point.x, point.y - grip.point.y);
      if (distance <= best) { best = distance; result = grip.index; }
    }
    return result;
  }

  begin(entity: Entity | undefined, solid: Solid | undefined, gripIndex: number, origin: Vec2): boolean {
    if (!entity && !solid) return false;
    this.drag = {
      objectId: (entity ?? solid)!.id,
      objectType: entity ? 'entity' : 'solid',
      gripIndex,
      origin: { ...origin },
      originalEntity: entity ? cloneEntity(entity) : undefined,
      originalPositions: solid?.mesh.positions.slice(),
      originalFeature: solid ? JSON.parse(JSON.stringify(solid.feature)) : undefined,
      originalRevision: solid?.revision,
    };
    this.changed = false;
    return true;
  }

  update(cursor: Vec2): void {
    if (!this.drag) return;
    const dx = cursor.x - this.drag.origin.x;
    const dy = cursor.y - this.drag.origin.y;
    if (this.drag.objectType === 'solid') this.updateSolid(dx, dy);
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
        if (this.drag.originalFeature) before.feature = JSON.parse(JSON.stringify(this.drag.originalFeature));
        if (this.drag.originalRevision !== undefined) before.revision = this.drag.originalRevision;
        this.history.recordApplied(new UpdateSolidEdit('Edit solid grip', before, cloneSolid(current)));
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
        if (this.drag.originalFeature) solid.feature = JSON.parse(JSON.stringify(this.drag.originalFeature));
        if (this.drag.originalRevision !== undefined) solid.revision = this.drag.originalRevision;
      }
    }
    this.drag = null;
    this.changed = false;
    this.doc.notify();
  }

  clear(): void { this.cancel(); this.mode = null; this.hoveredGrip = -1; }

  private updateEntity(cursor: Vec2, dx: number, dy: number): void {
    if (!this.drag?.originalEntity) return;
    const entity = this.doc.getEntity(this.drag.objectId);
    const original = this.drag.originalEntity;
    if (!entity) return;
    if (entity.type === 'line' && original.type === 'line') {
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
    } else if (entity.type === 'polyline' && original.type === 'polyline') {
      entity.vertices[this.drag.gripIndex] = { ...cursor };
      if (entity.closed && this.drag.gripIndex === 0) {
        entity.vertices[entity.vertices.length - 1] = { ...cursor };
      }
    } else if(entity.type==='bezier'&&original.type==='bezier'){ if(this.drag.gripIndex===0)entity.start={...cursor};else if(this.drag.gripIndex===1)entity.control1={...cursor};else if(this.drag.gripIndex===2)entity.control2={...cursor};else entity.end={...cursor};
    } else if(entity.type==='arc'&&original.type==='arc'){ if(this.drag.gripIndex===0)entity.center={x:original.center.x+dx,y:original.center.y+dy};else {const a=Math.atan2(cursor.y-original.center.y,cursor.x-original.center.x);entity.radius=Math.max(.001,Math.hypot(cursor.x-original.center.x,cursor.y-original.center.y));if(this.drag.gripIndex===1){entity.startAngle=a;let s=original.startAngle+original.sweepAngle-a;while(s<=0)s+=Math.PI*2;entity.sweepAngle=s;}else {let s=a-original.startAngle;if(s<=0)s+=Math.PI*2;entity.sweepAngle=s;}}
    } else if(entity.type==='text'&&original.type==='text')entity.position={...cursor};
    else if (entity.type === 'dimension' && original.type === 'dimension') {
      if (this.drag.gripIndex === 0) entity.start = { ...cursor };
      else if (this.drag.gripIndex === 1) entity.end = { ...cursor };
      else entity.offset = { ...cursor };
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
    const anchors = [[b.maxX, b.maxY], [b.minX, b.maxY], [b.minX, b.minY], [b.maxX, b.minY]];
    if (this.mode === 'center') {
      for (let i = 0; i < positions.length; i += 3) { positions[i] += dx; positions[i + 1] += dy; }
    } else {
      const side = this.drag.gripIndex % 4;
      const dragged = [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]];
      if (this.mode === 'end') {
        const anchor = anchors[side];
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
        if (side === 0) appliedScaleY = (b.minY + dy - b.maxY) / (b.minY - b.maxY || 1);
        if (side === 1) appliedScaleX = (b.maxX + dx - b.minX) / (b.maxX - b.minX || 1);
        if (side === 2) appliedScaleY = (b.maxY + dy - b.minY) / (b.maxY - b.minY || 1);
        if (side === 3) appliedScaleX = (b.minX + dx - b.maxX) / (b.minX - b.maxX || 1);
        for (let i = 0; i < positions.length; i += 3) {
          if (side === 0) positions[i + 1] = b.maxY + (positions[i + 1] - b.maxY) * ((b.minY + dy - b.maxY) / (b.minY - b.maxY || 1));
          if (side === 1) positions[i] = b.minX + (positions[i] - b.minX) * ((b.maxX + dx - b.minX) / (b.maxX - b.minX || 1));
          if (side === 2) positions[i + 1] = b.minY + (positions[i + 1] - b.minY) * ((b.maxY + dy - b.minY) / (b.maxY - b.minY || 1));
          if (side === 3) positions[i] = b.maxX + (positions[i] - b.maxX) * ((b.minX + dx - b.maxX) / (b.minX - b.maxX || 1));
        }
      }
    }
    solid.mesh.positions = positions;
    const originalFeature = this.drag.originalFeature;
    if (originalFeature?.kind === 'extrusion') {
      const feature = JSON.parse(JSON.stringify(originalFeature)) as typeof originalFeature;
      if (this.mode === 'center') {
        feature.transform.translateX += dx;
        feature.transform.translateY += dy;
      } else {
        const anchorX = this.mode === 'end' ? anchors[this.drag.gripIndex % 4][0] : (this.drag.gripIndex % 4 === 1 ? b.minX : b.maxX);
        const anchorY = this.mode === 'end' ? anchors[this.drag.gripIndex % 4][1] : (this.drag.gripIndex % 4 === 2 ? b.minY : b.maxY);
        feature.transform.scaleX *= appliedScaleX;
        feature.transform.scaleY *= appliedScaleY;
        feature.transform.translateX = anchorX + (feature.transform.translateX - anchorX) * appliedScaleX;
        feature.transform.translateY = anchorY + (feature.transform.translateY - anchorY) * appliedScaleY;
      }
      solid.feature = feature;
    }
    solid.revision++;
  }
}
