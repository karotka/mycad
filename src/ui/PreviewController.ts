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
      this.setPreview({ type: 'line', data: { start: active.data.basePoint, end: cursor } });
      return;
    }
    if (active.name === 'ROTATE' && active.stepIndex === 2 && active.data.basePoint) {
      const base = active.data.basePoint as Vec2;
      const angle = Math.atan2(cursor.y - base.y, cursor.x - base.x);
      const entities = (active.data.entities as Entity[]).map((entity) => rotateEntity(entity, base, angle));
      this.setPreview({ type: 'rotate', data: { start: base, end: cursor, entities } });
      return;
    }
    if (active.stepIndex !== 1) return;
    if (active.name === 'LINE' && active.data.start) this.setPreview({ type: 'line', data: { start: active.data.start, end: cursor } });
    else if (active.name === 'RECTANGLE' && active.data.start) this.setPreview({ type: 'rectangle', data: { start: active.data.start, end: cursor } });
    else if (active.name === 'CIRCLE' && active.data.center) this.setPreview({ type: 'circle', data: { center: active.data.center, cursor } });
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

  showSnap(point: { x: number; y: number; z: number }, fallbackX: number, fallbackY: number): void {
    const projected = this.projectPoint?.(point);
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
    case 'circle': result.center = rotate(result.center); break;
    case 'octagon': result.center = rotate(result.center); result.vertices = result.vertices.map(rotate); break;
    case 'polyline': result.vertices = result.vertices.map(rotate); break;
    case 'arc': result.center = rotate(result.center); result.startAngle += angle; break;
    case 'bezier': result.start = rotate(result.start); result.control1 = rotate(result.control1); result.control2 = rotate(result.control2); result.end = rotate(result.end); break;
    case 'text': result.position = rotate(result.position); result.rotation = (result.rotation ?? 0) + angle; break;
    case 'rectangle': break;
  }
  return result;
}
import type { ActiveCommand } from '../core/commands/CommandManager';
import { cloneEntity, type Entity } from '../core/entities/types';
import type { Vec2 } from '../math/geometry';
