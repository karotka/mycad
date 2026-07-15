import type { Document } from '../core/Document';
import { entityBounds, type Entity, type Solid } from '../core/entities/types';
import { hitTestEntity } from '../core/commands/CommandManager';
import type { Vec2 } from '../math/geometry';

export interface SolidBounds {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export interface WindowBounds {
  minX: number; minY: number; maxX: number; maxY: number;
}

export function applyWindowSelection(doc: Document, box: WindowBounds, crossing: boolean, additive: boolean): void {
  if (!additive) {
    doc.selectedEntityIds.clear();
    doc.selectedSolidIds.clear();
  }
  const matches = (bounds: WindowBounds): boolean => {
    const inside = bounds.minX >= box.minX && bounds.maxX <= box.maxX
      && bounds.minY >= box.minY && bounds.maxY <= box.maxY;
    const intersects = bounds.maxX >= box.minX && bounds.minX <= box.maxX
      && bounds.maxY >= box.minY && bounds.minY <= box.maxY;
    return inside || (crossing && intersects);
  };
  for (const entity of doc.entities) {
    const bounds = entityBounds(entity);
    if (!doc.hiddenLayers.has(entity.layer) && matches({
      minX: bounds.min.x, minY: bounds.min.y, maxX: bounds.max.x, maxY: bounds.max.y,
    })) {
      doc.selectedEntityIds.add(entity.id);
    }
  }
  for (const solid of doc.solids) {
    if (!doc.hiddenLayers.has(solid.layer) && matches(solidBounds(solid))) doc.selectedSolidIds.add(solid.id);
  }
  doc.pruneSelection();
  doc.notify();
}

export function solidBounds(solid: Solid): SolidBounds {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < solid.mesh.positions.length; i += 3) {
    minX = Math.min(minX, solid.mesh.positions[i]);
    minY = Math.min(minY, solid.mesh.positions[i + 1]);
    minZ = Math.min(minZ, solid.mesh.positions[i + 2]);
    maxX = Math.max(maxX, solid.mesh.positions[i]);
    maxY = Math.max(maxY, solid.mesh.positions[i + 1]);
    maxZ = Math.max(maxZ, solid.mesh.positions[i + 2]);
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

export function hitTestSolid2d(
  doc: Document,
  point: Vec2,
  excludedIds: ReadonlySet<string> = new Set()
): Solid | undefined {
  let fallback: Solid | undefined;
  for (let i = doc.solids.length - 1; i >= 0; i--) {
    const solid = doc.solids[i];
    if (doc.hiddenLayers.has(solid.layer)) continue;
    const bounds = solidBounds(solid);
    if (point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY) {
      fallback ??= solid;
      if (!excludedIds.has(solid.id)) return solid;
    }
  }
  return fallback;
}

export function pickEntityAt(doc: Document, point: Vec2, tolerance: number): Entity | null {
  const visible = doc.entities.filter((entity) => !doc.hiddenLayers.has(entity.layer));
  const unselected = visible.filter((entity) => !doc.selectedEntityIds.has(entity.id));
  const edge = hitTestEntity(unselected, point, tolerance) ?? hitTestEntity(visible, point, tolerance);
  if (edge) return edge;
  const contains = (entity: Entity): boolean => {
    if (entity.type === 'circle') return Math.hypot(point.x - entity.center.x, point.y - entity.center.y) <= entity.radius;
    if (entity.type === 'rectangle') {
      const bounds = entityBounds(entity);
      return point.x >= bounds.min.x && point.x <= bounds.max.x && point.y >= bounds.min.y && point.y <= bounds.max.y;
    }
    if (entity.type !== 'octagon' && !(entity.type === 'polyline' && entity.closed)) return false;
    const vertices = entity.vertices;
    let inside = false;
    for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index++) {
      const a = vertices[index], b = vertices[previous];
      if ((a.y > point.y) !== (b.y > point.y)
        && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
  return visible
    .filter(contains)
    .sort((a, b) => {
      const boundsA = entityBounds(a), boundsB = entityBounds(b);
      return (boundsA.max.x - boundsA.min.x) * (boundsA.max.y - boundsA.min.y)
        - (boundsB.max.x - boundsB.min.x) * (boundsB.max.y - boundsB.min.y);
    })[0] ?? null;
}

export function selectionExclusions(doc: Document, activeData?: Record<string, unknown>): Set<string> {
  const excluded = new Set(doc.selectedSolidIds);
  if (!activeData) return excluded;
  if (typeof activeData.baseId === 'string') excluded.add(activeData.baseId);
  if (typeof activeData.solidId === 'string') excluded.add(activeData.solidId);
  if (Array.isArray(activeData.solids)) {
    for (const id of activeData.solids) if (typeof id === 'string') excluded.add(id);
  }
  return excluded;
}
