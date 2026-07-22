import type { Document } from '../core/Document';
import { curvePoints, ellipsePoints, entityBounds, type Entity, type Solid } from '../core/entities/types';
import { hitTestEntity, pointInEllipse } from '../core/commands/CommandManager';
import type { Vec2, Vec3 } from '../math/geometry';
import { localToWorld, WORLD_WORK_PLANE } from '../math/workplane';

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

function pointInsideBox(point: Vec2, box: WindowBounds): boolean {
  return point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY;
}

function orientation(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orientation(a, b, c), o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a), o4 = orientation(c, d, b);
  const epsilon = 1e-8;
  const onSegment = (point: Vec2, first: Vec2, second: Vec2): boolean =>
    Math.abs(orientation(first, second, point)) <= epsilon
    && point.x >= Math.min(first.x, second.x) - epsilon && point.x <= Math.max(first.x, second.x) + epsilon
    && point.y >= Math.min(first.y, second.y) - epsilon && point.y <= Math.max(first.y, second.y) + epsilon;
  if (Math.abs(o1) <= epsilon && onSegment(c, a, b)) return true;
  if (Math.abs(o2) <= epsilon && onSegment(d, a, b)) return true;
  if (Math.abs(o3) <= epsilon && onSegment(a, c, d)) return true;
  if (Math.abs(o4) <= epsilon && onSegment(b, c, d)) return true;
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

function pointInPolygon(point: Vec2, polygon: readonly Vec2[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index], b = polygon[previous];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function polygonIntersectsBox(polygon: readonly Vec2[], box: WindowBounds, closed: boolean): boolean {
  if (polygon.some((point) => pointInsideBox(point, box))) return true;
  const corners = [
    { x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY },
  ];
  if (closed && corners.some((corner) => pointInPolygon(corner, polygon))) return true;
  const boxEdges = corners.map((corner, index) => [corner, corners[(index + 1) % corners.length]] as const);
  const segmentCount = closed ? polygon.length : polygon.length - 1;
  for (let index = 0; index < segmentCount; index++) {
    const a = polygon[index], b = polygon[(index + 1) % polygon.length];
    if (boxEdges.some(([c, d]) => segmentsIntersect(a, b, c, d))) return true;
  }
  return false;
}

function entityOutline(entity: Entity): { points: Vec2[]; closed: boolean } {
  switch (entity.type) {
    case 'line': return { points: [entity.start, entity.end], closed: false };
    case 'circle': return {
      points: Array.from({ length: 64 }, (_, index) => {
        const angle = index * Math.PI * 2 / 64;
        return { x: entity.center.x + Math.cos(angle) * entity.radius, y: entity.center.y + Math.sin(angle) * entity.radius };
      }),
      closed: true,
    };
    case 'ellipse': return { points: ellipsePoints(entity, 64).slice(0, -1), closed: true };
    case 'rectangle': return {
      points: [entity.first, { x: entity.opposite.x, y: entity.first.y }, entity.opposite, { x: entity.first.x, y: entity.opposite.y }],
      closed: true,
    };
    case 'octagon': return { points: entity.vertices, closed: true };
    case 'polyline': return { points: entity.vertices, closed: entity.closed };
    case 'arc':
    case 'bezier': return { points: curvePoints(entity, 64), closed: false };
    case 'text':
    case 'dimension': {
      const bounds = entityBounds(entity);
      return {
        points: [bounds.min, { x: bounds.max.x, y: bounds.min.y }, bounds.max, { x: bounds.min.x, y: bounds.max.y }],
        closed: true,
      };
    }
  }
}

/**
 * Screen-space window selection for the 3D view. The blue left-to-right window
 * contains an object's whole projection; the green right-to-left window also
 * takes anything its projection crosses. This deliberately projects geometry,
 * rather than sending 3D pointer coordinates through the 2D renderer.
 */
export function applyProjectedWindowSelection(
  doc: Document,
  box: WindowBounds,
  crossing: boolean,
  additive: boolean,
  project: (point: Vec3) => Vec2 | null,
): void {
  if (!additive) {
    doc.selectedEntityIds.clear();
    doc.selectedSolidIds.clear();
  }
  for (const entity of doc.entities) {
    if (doc.hiddenLayers.has(entity.layer)) continue;
    const outline = entityOutline(entity);
    const plane = entity.workPlane ?? WORLD_WORK_PLANE;
    const projected = outline.points.map((point) => project(localToWorld(plane, point, (point as Vec2 & { z?: number }).z ?? 0)));
    const contained = projected.length > 0 && projected.every((point) => point !== null && pointInsideBox(point, box));
    const visible = projected.filter((point): point is Vec2 => point !== null);
    if (contained || (crossing && visible.length > 0 && polygonIntersectsBox(visible, box, outline.closed))) {
      doc.selectedEntityIds.add(entity.id);
    }
  }
  for (const solid of doc.solids) {
    if (doc.hiddenLayers.has(solid.layer)) continue;
    const projected: Array<Vec2 | null> = [];
    for (let index = 0; index < solid.mesh.positions.length; index += 3) {
      projected.push(project({
        x: solid.mesh.positions[index],
        y: solid.mesh.positions[index + 1],
        z: solid.mesh.positions[index + 2],
      }));
    }
    const contained = projected.length > 0 && projected.every((point) => point !== null && pointInsideBox(point, box));
    let intersects = false;
    if (crossing && !contained) {
      for (let offset = 0; offset + 2 < solid.mesh.indices.length; offset += 3) {
        const triangle = [projected[solid.mesh.indices[offset]], projected[solid.mesh.indices[offset + 1]], projected[solid.mesh.indices[offset + 2]]];
        if (triangle.every((point): point is Vec2 => point !== null) && polygonIntersectsBox(triangle, box, true)) {
          intersects = true;
          break;
        }
      }
    }
    if (contained || intersects) doc.selectedSolidIds.add(solid.id);
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
    if (entity.type === 'ellipse') return pointInEllipse(point, entity);
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
