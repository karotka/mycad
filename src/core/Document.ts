import type { Vec2 } from '../math/geometry';
import { closePolyline, octagonVertices } from '../math/geometry';
import { cloneWorkPlane, WORLD_WORK_PLANE, type WorkPlane } from '../math/workplane';
import {
  genId,
  type CircleEntity,
  type EllipseEntity,
  type ArcEntity,
  type BezierEntity,
  type TextEntity,
  type DimensionEntity,
  type Entity,
  type LineEntity,
  type OctagonEntity,
  type PolylineEntity,
  type RectangleEntity,
  type Solid,
  type SolidFeature,
  type SolidMesh,
} from './entities/types';
import { defaultDimensionStyle, defaultDraftingSettings, type DimensionStyle, type DraftingSettings } from './settings';

export type ViewMode = '2d' | '3d';

export interface DocumentState {
  entities: Entity[];
  solids: Solid[];
  selectedEntityIds: Set<string>;
  selectedSolidIds: Set<string>;
  currentLayer: string;
  gridSize: number;
  snapSize: number;
  snapEnabled: boolean;
  viewMode: ViewMode;
  drafting: DraftingSettings;
  dimensionStyle: DimensionStyle;
}

export class Document {
  entities: Entity[] = [];
  solids: Solid[] = [];
  selectedEntityIds = new Set<string>();
  selectedSolidIds = new Set<string>();
  currentLayer = '0';
  layers: string[] = ['0'];
  layerColors: Record<string, number> = { '0': 0xffffff };
  hiddenLayers = new Set<string>();
  gridSize = 1;
  snapSize = 0.5;
  snapEnabled = true;
  viewMode: ViewMode = '2d';
  activeWorkPlane: WorkPlane = cloneWorkPlane(WORLD_WORK_PLANE);
  drafting: DraftingSettings = defaultDraftingSettings();
  dimensionStyle: DimensionStyle = defaultDimensionStyle();

  private listeners: Array<(doc: Document) => void> = [];
  private transactionDepth = 0;
  private notificationPending = false;

  subscribe(fn: (doc: Document) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  notify(): void {
    if (this.transactionDepth > 0) {
      this.notificationPending = true;
      return;
    }
    for (const fn of this.listeners) fn(this);
  }

  transaction<T>(fn: () => T): T {
    this.transactionDepth++;
    try {
      return fn();
    } finally {
      this.transactionDepth--;
      if (this.transactionDepth === 0 && this.notificationPending) {
        this.notificationPending = false;
        this.notify();
      }
    }
  }

  pruneSelection(): void {
    const entityIds = new Set(this.entities.map((entity) => entity.id));
    const solidIds = new Set(this.solids.map((solid) => solid.id));
    for (const id of this.selectedEntityIds) if (!entityIds.has(id)) this.selectedEntityIds.delete(id);
    for (const id of this.selectedSolidIds) if (!solidIds.has(id)) this.selectedSolidIds.delete(id);
    for (const entity of this.entities) entity.selected = this.selectedEntityIds.has(entity.id);
    for (const solid of this.solids) solid.selected = this.selectedSolidIds.has(solid.id);
  }

  addEntity(entity: Entity): void {
    this.entities.push(entity);
    this.notify();
  }

  addSolid(solid: Solid): void {
    this.solids.push(solid);
    this.notify();
  }

  removeEntity(id: string): void {
    this.entities = this.entities.filter((e) => e.id !== id);
    this.selectedEntityIds.delete(id);
    this.notify();
  }

  removeSolid(id: string): void {
    this.solids = this.solids.filter((s) => s.id !== id);
    this.selectedSolidIds.delete(id);
    this.notify();
  }

  getEntity(id: string): Entity | undefined {
    return this.entities.find((e) => e.id === id);
  }

  getSolid(id: string): Solid | undefined {
    return this.solids.find((s) => s.id === id);
  }

  clearSelection(): void {
    this.selectedEntityIds.clear();
    this.selectedSolidIds.clear();
    for (const e of this.entities) e.selected = false;
    for (const s of this.solids) s.selected = false;
    this.notify();
  }

  selectEntity(id: string, additive = false): void {
    if (!additive) this.clearSelection();
    this.selectedEntityIds.add(id);
    const e = this.getEntity(id);
    if (e) e.selected = true;
    this.notify();
  }

  selectSolid(id: string, additive = false): void {
    if (!additive) this.clearSelection();
    this.selectedSolidIds.add(id);
    const s = this.getSolid(id);
    if (s) s.selected = true;
    this.notify();
  }

  getSelectedEntities(): Entity[] {
    return this.entities.filter((e) => this.selectedEntityIds.has(e.id));
  }

  getSelectedSolids(): Solid[] {
    return this.solids.filter((s) => this.selectedSolidIds.has(s.id));
  }

  createLine(start: Vec2, end: Vec2, color?: number): LineEntity {
    return {
      id: genId('line'),
      type: 'line',
      layer: this.currentLayer,
      color: color ?? this.layerColors[this.currentLayer] ?? 0xffffff,
      selected: false,
      workPlane: cloneWorkPlane(this.activeWorkPlane),
      start,
      end,
    };
  }

  createCircle(center: Vec2, radius: number, color?: number): CircleEntity {
    return {
      id: genId('circle'),
      type: 'circle',
      layer: this.currentLayer,
      color: color ?? this.layerColors[this.currentLayer] ?? 0xffffff,
      selected: false,
      workPlane: cloneWorkPlane(this.activeWorkPlane),
      center,
      radius,
    };
  }
  createArc(center: Vec2, radius: number, startAngle: number, sweepAngle: number): ArcEntity {
    return { id: genId('arc'), type: 'arc', layer: this.currentLayer, color: this.layerColors[this.currentLayer] ?? 0xffffff, selected: false, workPlane: cloneWorkPlane(this.activeWorkPlane), center, radius, startAngle, sweepAngle };
  }
  createBezier(start: Vec2, control1: Vec2, control2: Vec2, end: Vec2): BezierEntity {
    return { id: genId('bezier'), type: 'bezier', layer: this.currentLayer, color: this.layerColors[this.currentLayer] ?? 0xffffff, selected: false, workPlane: cloneWorkPlane(this.activeWorkPlane), start, control1, control2, end };
  }
  createEllipse(center: Vec2, radiusX: number, radiusY: number, rotation = 0, color?: number): EllipseEntity {
    return {
      id: genId('ellipse'),
      type: 'ellipse',
      layer: this.currentLayer,
      color: color ?? this.layerColors[this.currentLayer] ?? 0xffffff,
      selected: false,
      workPlane: cloneWorkPlane(this.activeWorkPlane),
      center,
      radiusX,
      radiusY,
      rotation,
    };
  }

  createText(position: Vec2, text: string, height = 2.5, font = 'Arial'): TextEntity {
    return { id: genId('text'), type: 'text', layer: this.currentLayer, color: this.layerColors[this.currentLayer] ?? 0xffffff, selected: false, workPlane: cloneWorkPlane(this.activeWorkPlane), position, text, height, font };
  }

  createDimension(start: Vec2, end: Vec2, offset: Vec2, dimensionKind: DimensionEntity['dimensionKind'] = 'linear', rotation?: number): DimensionEntity {
    const layer = this.dimensionStyle.layer || 'dims';
    if (!this.layers.includes(layer)) this.layers.push(layer);
    if (!(layer in this.layerColors)) this.layerColors[layer] = 0xffffff;
    return {
      id: genId('dim'), type: 'dimension', layer,
      color: this.layerColors[layer] ?? 0xffffff, selected: false,
      workPlane: cloneWorkPlane(this.activeWorkPlane), start, end, offset, dimensionKind, rotation,
      textHeight: this.dimensionStyle.textHeight, arrowSize: this.dimensionStyle.arrowSize,
      arrowType: this.dimensionStyle.arrowType, extensionBeyond: this.dimensionStyle.extensionBeyond,
      extensionOffset: this.dimensionStyle.extensionOffset, textOffset: this.dimensionStyle.textOffset,
      precision: this.dimensionStyle.precision,
      scale: this.dimensionStyle.scale,
    };
  }

  createRectangle(first: Vec2, opposite: Vec2, color?: number): RectangleEntity {
    return {
      id: genId('rect'),
      type: 'rectangle',
      layer: this.currentLayer,
      color: color ?? this.layerColors[this.currentLayer] ?? 0xffffff,
      selected: false,
      workPlane: cloneWorkPlane(this.activeWorkPlane),
      first,
      opposite,
    };
  }

  createOctagon(center: Vec2, radius: number, color?: number): OctagonEntity {
    return {
      id: genId('octagon'),
      type: 'octagon',
      layer: this.currentLayer,
      color: color ?? this.layerColors[this.currentLayer] ?? 0xffffff,
      selected: false,
      workPlane: cloneWorkPlane(this.activeWorkPlane),
      center,
      radius,
      vertices: octagonVertices(center, radius),
    };
  }

  createPolyline(vertices: Vec2[], closed = false, color?: number): PolylineEntity {
    return {
      id: genId('poly'),
      type: 'polyline',
      layer: this.currentLayer,
      color: color ?? this.layerColors[this.currentLayer] ?? 0xffffff,
      selected: false,
      workPlane: cloneWorkPlane(this.activeWorkPlane),
      vertices: closed ? closePolyline(vertices) : [...vertices],
      closed,
    };
  }

  createSolid(
    mesh: SolidMesh,
    name: string,
    height: number,
    sourceEntityIds: string[],
    color?: number,
    feature: SolidFeature = { kind: 'mesh' }
  ): Solid {
    return {
      id: genId('solid'),
      name,
      layer: this.currentLayer,
      mesh,
      color: color ?? this.layerColors[this.currentLayer] ?? 0xffffff,
      selected: false,
      height,
      sourceEntityIds,
      feature,
      revision: 0,
    };
  }

  replaceSolids(ids: string[], newSolid: Solid): void {
    this.solids = this.solids.filter((s) => !ids.includes(s.id));
    this.solids.push(newSolid);
    this.selectedSolidIds.clear();
    this.selectedSolidIds.add(newSolid.id);
    newSolid.selected = true;
    this.notify();
  }
}

export const document = new Document();
