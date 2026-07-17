export interface PreviewFrame {
  type: string;
  data: unknown;
}

export class PreviewController {
  private frame: PreviewFrame | undefined;
  private dimensionTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly dimension: HTMLElement,
    readonly measureOrigin: HTMLElement,
    readonly measureTarget: HTMLElement,
    readonly snapMarker: HTMLElement,
    private readonly projectPoint?: (point: { x: number; y: number; z: number }) => { x: number; y: number } | null,
    private readonly copyWorldDelta?: (delta: Vec2) => { x: number; y: number; z: number } | undefined,
  ) {}

  get preview(): PreviewFrame | undefined { return this.frame; }

  setPreview(preview: PreviewFrame | undefined): void { this.frame = preview; }

  clearPreview(): void { this.frame = undefined; }

  update(active: ActiveCommand | null, cursor: Vec2, ucsHoverPoint: { x: number; y: number; z: number } | null): void {
    this.clearPreview();
    if (!active) return;
    if (active.name === 'UCS') {
      this.setPreview({
        type: 'ucs',
        data: { origin: active.data.origin, xPoint: active.data.xPoint, yPoint: active.data.yPoint, hover: ucsHoverPoint, step: active.stepIndex },
      });
      return;
    }
    if (active.name === 'POLYLINE') {
      // The whole chain so far, not just the segment being dragged: the vertices
      // are only a polyline once the command ends, so until then this preview is
      // the only thing that shows what has been drawn.
      const vertices = (active.data.vertices as Vec2[]) ?? [];
      if (vertices.length > 0) this.setPreview({ type: 'polyline', data: { vertices, cursor } });
      return;
    }
    if (active.name === 'ELLIPSE' && active.data.center) {
      if (active.stepIndex === 1) this.setPreview({ type: 'line', data: { start: active.data.center, end: cursor } });
      else if (active.stepIndex === 2 && active.data.axisPoint) {
        this.setPreview({ type: 'ellipse', data: { center: active.data.center, axisPoint: active.data.axisPoint, cursor } });
      }
      return;
    }
    if (active.name === 'POLYGON' && active.stepIndex === 2 && active.data.center && active.data.sides) {
      this.setPreview({ type: 'polygon', data: { center: active.data.center, cursor, sides: active.data.sides } });
      return;
    }
    if (active.name === 'ARC') {
      if (active.stepIndex === 1 && active.data.center) this.setPreview({ type: 'circle', data: { center: active.data.center, cursor } });
      else if (active.stepIndex === 2 && active.data.center && active.data.start) this.setPreview({ type: 'arc', data: { center: active.data.center, start: active.data.start, cursor } });
      return;
    }
    if (active.name === 'BEZIER' && active.data.start) {
      this.setPreview({ type: 'bezier', data: { start: active.data.start, control1: active.data.control1 ?? cursor, control2: active.data.control2 ?? cursor, end: cursor } });
      return;
    }
    if (active.name === 'MOVE' && active.stepIndex === 2 && active.data.basePoint) {
      // Its own kind rather than a plain line, because what a move wants read
      // off it is how far it went in x and in y, not the length of the hop.
      this.setPreview({ type: 'move', data: { start: active.data.basePoint, end: cursor } });
      return;
    }
    if (active.name === 'COPY' && active.stepIndex === 2 && active.data.basePoint) {
      const base = active.data.basePoint as Vec2;
      const delta = { x: cursor.x - base.x, y: cursor.y - base.y };
      const entities = (active.data.entities as Entity[]).map((entity) => {
        const worldDelta = this.copyWorldDelta?.(delta);
        const copy = worldDelta ? cloneEntity(entity) : transformEntityPoints(entity, (point) => ({ x: point.x + delta.x, y: point.y + delta.y }));
        if (worldDelta) {
          const plane = cloneWorkPlane(copy.workPlane ?? WORLD_WORK_PLANE);
          plane.origin.x += worldDelta.x; plane.origin.y += worldDelta.y; plane.origin.z += worldDelta.z;
          copy.workPlane = plane;
        }
        copy.color = 0xe6f4ff;
        copy.selected = false;
        return copy;
      });
      this.setPreview({ type: 'copy', data: { start: base, end: cursor, entities } });
      return;
    }
    if (active.name === 'SCALE' && active.stepIndex === 2 && active.data.basePoint) {
      const base = active.data.basePoint as Vec2;
      const factor = Math.hypot(cursor.x - base.x, cursor.y - base.y);
      const entities = (active.data.entities as Entity[]).map((entity) => {
        const scaled = transformEntityPoints(entity, (point) => ({ x: base.x + (point.x - base.x) * factor, y: base.y + (point.y - base.y) * factor }));
        if (scaled.type === 'circle' || scaled.type === 'arc' || scaled.type === 'octagon') scaled.radius *= factor;
        if (scaled.type === 'text') scaled.height *= factor;
        scaled.color = 0xe6f4ff;
        scaled.selected = false;
        return scaled;
      });
      this.setPreview({ type: 'scale', data: { start: base, end: cursor, entities, factor } });
      return;
    }
    if (active.name === 'ROTATE' && active.stepIndex === 2 && active.data.basePoint) {
      const base = active.data.basePoint as Vec2;
      const angle = Math.atan2(cursor.y - base.y, cursor.x - base.x);
      const entities = (active.data.entities as Entity[]).map((entity) => rotateEntity(entity, base, angle));
      this.setPreview({ type: 'rotate', data: { start: base, end: cursor, entities } });
      return;
    }
    if ((active.name === 'BOX' || active.name === 'WEDGE') && active.stepIndex === 1 && active.data.start) {
      this.setPreview({ type: 'rectangle', data: { start: active.data.start, end: cursor } });
      return;
    }
    if (['CYLINDER', 'SPHERE', 'CONE', 'PYRAMID'].includes(active.name) && active.stepIndex === 1 && active.data.center) {
      this.setPreview({ type: 'circle', data: { center: active.data.center, cursor } });
      return;
    }
    if ((active.name === 'MEASURE' || active.name === 'DIMALIGNED') && active.data.start && active.stepIndex >= 1) {
      const start = active.data.start as Vec2;
      // Picking the second point, the cursor is that point and the dimension has
      // nowhere to sit yet, so it lies on the two points and simply reads them.
      // Placing the line, the points are settled and the cursor is the location.
      const placing = active.stepIndex >= 2 && Boolean(active.data.end);
      const end = placing ? active.data.end as Vec2 : cursor;
      // Once the line is placed the cursor moves on to the text, so the offset
      // stops following it and the text starts.
      const settled = active.stepIndex >= 3 && Boolean(active.data.offset);
      const offset = settled ? active.data.offset as Vec2 : cursor;
      const textPosition = settled ? cursor : undefined;
      const aligned = active.name === 'DIMALIGNED';
      this.setPreview({
        type: 'dimension',
        data: {
          start, end, offset, textPosition,
          kind: aligned ? 'aligned' : 'linear',
          // The same rule the command will apply, asked early. With the line not
          // yet pulled anywhere it can only answer from the points themselves,
          // which is the honest answer: an axis-aligned pair reads its length,
          // and a slope reads across until the location says otherwise.
          rotation: aligned ? undefined : linearDimensionRotation(start, end, offset),
          style: active.data.dimensionStyle,
        },
      });
      return;
    }
    if ((active.name === 'DIMRADIUS' || active.name === 'DIMDIAMETER') && active.stepIndex === 1 && active.data.entity) {
      const entity = active.data.entity as Entity;
      if (entity.type === 'circle' || entity.type === 'arc') {
        let dx = cursor.x - entity.center.x, dy = cursor.y - entity.center.y;
        const distance = Math.hypot(dx, dy) || 1; dx /= distance; dy /= distance;
        this.setPreview({
          type: 'dimension',
          data: {
            start: entity.center,
            end: { x: entity.center.x + dx * entity.radius, y: entity.center.y + dy * entity.radius },
            offset: cursor,
            kind: active.name === 'DIMRADIUS' ? 'radius' : 'diameter',
            style: active.data.dimensionStyle,
          },
        });
      }
      return;
    }
    if (active.stepIndex !== 1) return;
    if (active.name === 'LINE' && active.data.start) this.setPreview({ type: 'line', data: { start: active.data.start, end: cursor } });
    else if (active.name === 'RECTANGLE' && active.data.start) this.setPreview({ type: 'rectangle', data: { start: active.data.start, end: cursor } });
    else if ((active.name === 'CIRCLE' || active.name === 'CIRCLE_DIAMETER') && active.data.center) this.setPreview({ type: active.name === 'CIRCLE' ? 'circle' : 'circleDiameter', data: { center: active.data.center, cursor } });
    else if (active.name === 'OCTAGON' && active.data.center) this.setPreview({ type: 'octagon', data: { center: active.data.center, cursor } });
  }

  showDimension(text: string | null, x: number, y: number): void {
    if (!text) return;
    this.dimension.textContent = text;
    this.dimension.style.left = `${x + 16}px`;
    this.dimension.style.top = `${y - 34}px`;
    this.dimension.hidden = false;
    if (this.dimensionTimer) clearTimeout(this.dimensionTimer);
    this.dimensionTimer = setTimeout(() => { this.dimension.hidden = true; }, 1200);
  }

  showMarker(marker: HTMLElement, x: number, y: number): void {
    marker.style.left = `${x}px`;
    marker.style.top = `${y}px`;
    marker.hidden = false;
  }

  showSnap(point: { x: number; y: number; z: number }, fallbackX: number, fallbackY: number, mode?: string): void {
    const projected = this.projectPoint?.(point);
    // The symbol tells the modes apart the way AutoCAD does — a square for an
    // endpoint, a right angle for perpendicular, and so on.
    this.snapMarker.dataset.snap = mode ?? 'end';
    this.showMarker(this.snapMarker, projected?.x ?? fallbackX, projected?.y ?? fallbackY);
  }

  hideSnap(): void { this.snapMarker.hidden = true; }

  hideMeasurements(): void {
    this.measureOrigin.hidden = true;
    this.measureTarget.hidden = true;
  }

  reset(): void {
    this.clearPreview();
    this.hideSnap();
    this.hideMeasurements();
    this.dimension.hidden = true;
    if (this.dimensionTimer) clearTimeout(this.dimensionTimer);
    this.dimensionTimer = undefined;
  }
}

function rotateEntity(entity: Entity, base: Vec2, angle: number): Entity {
  const rotate = (point: Vec2): Vec2 => {
    const dx = point.x - base.x, dy = point.y - base.y;
    return { x: base.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: base.y + dx * Math.sin(angle) + dy * Math.cos(angle) };
  };
  if (entity.type === 'rectangle') {
    const corners = [entity.first, { x: entity.opposite.x, y: entity.first.y }, entity.opposite, { x: entity.first.x, y: entity.opposite.y }];
    return { id: entity.id, type: 'polyline', layer: entity.layer, color: 0xe6f4ff, selected: false, workPlane: entity.workPlane, vertices: corners.map(rotate), closed: true };
  }
  const result = cloneEntity(entity);
  result.color = 0xe6f4ff;
  result.selected = false;
  switch (result.type) {
    case 'line': result.start = rotate(result.start); result.end = rotate(result.end); break;
    case 'circle':
    case 'ellipse': result.center = rotate(result.center); break;
    case 'octagon': result.center = rotate(result.center); result.vertices = result.vertices.map(rotate); break;
    case 'polyline': result.vertices = result.vertices.map(rotate); break;
    case 'arc': result.center = rotate(result.center); result.startAngle += angle; break;
    case 'bezier': result.start = rotate(result.start); result.control1 = rotate(result.control1); result.control2 = rotate(result.control2); result.end = rotate(result.end); break;
    case 'text': result.position = rotate(result.position); result.rotation = (result.rotation ?? 0) + angle; break;
    case 'dimension': result.start = rotate(result.start); result.end = rotate(result.end); result.offset = rotate(result.offset); if (result.textPosition) result.textPosition = rotate(result.textPosition); break;
    case 'rectangle': break;
  }
  return result;
}
import type { ActiveCommand } from '../core/commands/CommandManager';
import { linearDimensionRotation } from '../core/entities/types';
import { cloneEntity, transformEntityPoints, type Entity } from '../core/entities/types';
import type { Vec2 } from '../math/geometry';
import { cloneWorkPlane, WORLD_WORK_PLANE } from '../math/workplane';
