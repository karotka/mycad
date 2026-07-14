import type { Vec2 } from '../math/geometry';
import { closePolyline, octagonVertices } from '../math/geometry';
import { cloneWorkPlane, WORLD_WORK_PLANE, type WorkPlane } from '../math/workplane';
import {
  genId,
  type CircleEntity,
  type Entity,
  type LineEntity,
  type OctagonEntity,
  type PolylineEntity,
  type RectangleEntity,
  type Solid,
  type SolidFeature,
  type SolidMesh,
} from './entities/types';

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
}

export class Document {
  entities: Entity[] = [];
  solids: Solid[] = [];
  selectedEntityIds = new Set<string>();
  selectedSolidIds = new Set<string>();
  currentLayer = '0';
  gridSize = 1;
  snapSize = 0.5;
  snapEnabled = true;
  viewMode: ViewMode = '2d';
  activeWorkPlane: WorkPlane = cloneWorkPlane(WORLD_WORK_PLANE);

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

  createLine(start: Vec2, end: Vec2, color = 0xffffff): LineEntity {
    return {
      id: genId('line'),
      type: 'line',
      layer: this.currentLayer,
      color,
      selected: false,
      workPlane: cloneWorkPlane(this.activeWorkPlane),
      start,
      end,
    };
  }

  createCircle(center: Vec2, radius: number, color = 0xffffff): CircleEntity {
    return {
      id: genId('circle'),
      type: 'circle',
      layer: this.currentLayer,
      color,
      selected: false,
      workPlane: cloneWorkPlane(this.activeWorkPlane),
      center,
      radius,
    };
  }

  createRectangle(first: Vec2, opposite: Vec2, color = 0xffffff): RectangleEntity {
    return {
      id: genId('rect'),
      type: 'rectangle',
      layer: this.currentLayer,
      color,
      selected: false,
      workPlane: cloneWorkPlane(this.activeWorkPlane),
      first,
      opposite,
    };
  }

  createOctagon(center: Vec2, radius: number, color = 0xffffff): OctagonEntity {
    return {
      id: genId('octagon'),
      type: 'octagon',
      layer: this.currentLayer,
      color,
      selected: false,
      workPlane: cloneWorkPlane(this.activeWorkPlane),
      center,
      radius,
      vertices: octagonVertices(center, radius),
    };
  }

  createPolyline(vertices: Vec2[], closed = false, color = 0xffffff): PolylineEntity {
    return {
      id: genId('poly'),
      type: 'polyline',
      layer: this.currentLayer,
      color,
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
    color = 0x4488cc,
    feature: SolidFeature = { kind: 'mesh' }
  ): Solid {
    return {
      id: genId('solid'),
      name,
      mesh,
      color,
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
