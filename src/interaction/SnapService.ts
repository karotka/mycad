import type { Document } from '../core/Document';
import { curvePoints, getEntityPoints, type Entity } from '../core/entities/types';
import type { Vec2, Vec3 } from '../math/geometry';
import { localToWorld, WORLD_WORK_PLANE, worldToLocal, type WorkPlane } from '../math/workplane';
import { solidBounds } from './PickingService';
import type { GripMode } from './GripController';

export interface SnapTarget {
  point: Vec2;
  world: Vec3;
}

const midpoint = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function measurementCandidates(doc: Document): Vec3[] {
  const candidates: Vec3[] = [];
  for (const entity of doc.entities) {
    if (doc.hiddenLayers.has(entity.layer)) continue;
    for (const point of getEntityPoints(entity)) {
      candidates.push(localToWorld(entity.workPlane ?? WORLD_WORK_PLANE, point));
    }
  }
  for (const solid of doc.solids) {
    if (doc.hiddenLayers.has(solid.layer)) continue;
    for (let index = 0; index < solid.mesh.positions.length; index += 3) {
      candidates.push({
        x: solid.mesh.positions[index],
        y: solid.mesh.positions[index + 1],
        z: solid.mesh.positions[index + 2],
      });
    }
  }
  return candidates;
}

export function objectSnapCandidates(doc: Document, mode: GripMode, excludedId?: string | null): Vec3[] {
  const candidates: Vec3[] = [];
  const addLocal = (entity: Entity, point: Vec2): void => {
    candidates.push(localToWorld(entity.workPlane ?? WORLD_WORK_PLANE, point));
  };
  for (const entity of doc.entities) {
    if (entity.id === excludedId || doc.hiddenLayers.has(entity.layer)) continue;
    if (mode === 'end') addEntityEnds(entity, addLocal);
    else if (mode === 'center') addEntityCenters(entity, addLocal);
    else addEntityMiddles(entity, addLocal);
  }
  for (const solid of doc.solids) {
    if (solid.id === excludedId || doc.hiddenLayers.has(solid.layer)) continue;
    const positions = solid.mesh.positions;
    if (mode === 'end') {
      for (let index = 0; index < positions.length; index += 3) {
        candidates.push({ x: positions[index], y: positions[index + 1], z: positions[index + 2] });
      }
    } else if (mode === 'center') {
      const bounds = solidBounds(solid);
      candidates.push({
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
        z: (bounds.minZ + bounds.maxZ) / 2,
      });
    } else {
      addSolidEdgeMiddles(solid.mesh.positions, solid.mesh.indices, candidates);
    }
  }
  return candidates;
}

function addEntityEnds(entity: Entity, add: (entity: Entity, point: Vec2) => void): void {
  if (entity.type === 'line') [entity.start, entity.end].forEach((point) => add(entity, point));
  else if (entity.type === 'rectangle') {
    [entity.first, { x: entity.opposite.x, y: entity.first.y }, entity.opposite, { x: entity.first.x, y: entity.opposite.y }]
      .forEach((point) => add(entity, point));
  } else if (entity.type === 'polyline' || entity.type === 'octagon') {
    const vertices = entity.type === 'polyline' && entity.closed ? entity.vertices.slice(0, -1) : entity.vertices;
    vertices.forEach((point) => add(entity, point));
  } else if (entity.type === 'arc' || entity.type === 'bezier') {
    const points = curvePoints(entity, 2);
    add(entity, points[0]); add(entity, points[2]);
  } else if (entity.type === 'text') add(entity, entity.position);
}

function addEntityCenters(entity: Entity, add: (entity: Entity, point: Vec2) => void): void {
  if (entity.type === 'circle' || entity.type === 'arc' || entity.type === 'octagon') add(entity, entity.center);
  else if (entity.type === 'rectangle') add(entity, midpoint(entity.first, entity.opposite));
  else if (entity.type === 'bezier') add(entity, curvePoints(entity, 2)[1]);
  else if (entity.type === 'text') add(entity, entity.position);
}

function addEntityMiddles(entity: Entity, add: (entity: Entity, point: Vec2) => void): void {
  if (entity.type === 'line') add(entity, midpoint(entity.start, entity.end));
  else if (entity.type === 'arc' || entity.type === 'bezier') add(entity, curvePoints(entity, 2)[1]);
  else if (entity.type === 'rectangle') {
    const corners = [entity.first, { x: entity.opposite.x, y: entity.first.y }, entity.opposite, { x: entity.first.x, y: entity.opposite.y }];
    corners.forEach((point, index) => add(entity, midpoint(point, corners[(index + 1) % corners.length])));
  } else if (entity.type === 'polyline' || entity.type === 'octagon') {
    const vertices = entity.type === 'polyline' && entity.closed ? entity.vertices.slice(0, -1) : entity.vertices;
    const segmentCount = entity.type === 'octagon' || entity.closed ? vertices.length : vertices.length - 1;
    for (let index = 0; index < segmentCount; index++) add(entity, midpoint(vertices[index], vertices[(index + 1) % vertices.length]));
  }
}

function addSolidEdgeMiddles(positions: Float32Array, indices: Uint32Array, candidates: Vec3[]): void {
  const seen = new Set<string>();
  for (let index = 0; index < indices.length; index += 3) {
    const triangle = [indices[index], indices[index + 1], indices[index + 2]];
    for (const [a, b] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        x: (positions[a * 3] + positions[b * 3]) / 2,
        y: (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2,
        z: (positions[a * 3 + 2] + positions[b * 3 + 2]) / 2,
      });
    }
  }
}

export function nearestCandidate2d(candidates: readonly Vec3[], cursor: Vec2, plane: WorkPlane, tolerance: number): SnapTarget | null {
  let best = tolerance;
  let result: SnapTarget | null = null;
  for (const world of candidates) {
    const local = worldToLocal(plane, world);
    const distance = Math.hypot(local.x - cursor.x, local.y - cursor.y);
    if (distance <= best) {
      best = distance;
      result = { point: { x: local.x, y: local.y }, world };
    }
  }
  return result;
}

export function nearestCandidateProjected(
  candidates: readonly Vec3[],
  cursor: Vec2,
  project: (point: Vec3) => Vec2 | null,
  tolerance: number,
  plane: WorkPlane,
): SnapTarget | null {
  let best = tolerance;
  let worldResult: Vec3 | null = null;
  for (const candidate of candidates) {
    const projected = project(candidate);
    if (!projected) continue;
    const distance = Math.hypot(projected.x - cursor.x, projected.y - cursor.y);
    if (distance <= best) { best = distance; worldResult = candidate; }
  }
  if (!worldResult) return null;
  const local = worldToLocal(plane, worldResult);
  return { point: { x: local.x, y: local.y }, world: worldResult };
}
