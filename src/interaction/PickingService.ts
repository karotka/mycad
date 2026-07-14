import type { Document } from '../core/Document';
import type { Entity, Solid } from '../core/entities/types';
import { hitTestEntity } from '../core/commands/CommandManager';
import type { Vec2 } from '../math/geometry';

export interface SolidBounds {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
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
    const bounds = solidBounds(solid);
    if (point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY) {
      fallback ??= solid;
      if (!excludedIds.has(solid.id)) return solid;
    }
  }
  return fallback;
}

export function pickEntityAt(doc: Document, point: Vec2, tolerance: number): Entity | null {
  const unselected = doc.entities.filter((entity) => !doc.selectedEntityIds.has(entity.id));
  return hitTestEntity(unselected, point, tolerance) ?? hitTestEntity(doc.entities, point, tolerance);
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
