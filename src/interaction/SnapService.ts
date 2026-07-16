import type { Document } from '../core/Document';
import { curvePoints, getEntityPoints, type Entity } from '../core/entities/types';
import type { Vec2, Vec3 } from '../math/geometry';
import { localToWorld, WORLD_WORK_PLANE, worldToLocal, type WorkPlane } from '../math/workplane';
import { solidBounds } from './PickingService';
import type { ObjectSnapMode } from '../core/settings';
export type { ObjectSnapMode } from '../core/settings';

export interface SnapTarget {
  point: Vec2;
  world: Vec3;
  /** Which object snap produced this, so the marker can show the right symbol. */
  mode?: ObjectSnapMode;
}

/** A world point offered by a snap, tagged with the snap that found it. */
export interface SnapCandidate {
  world: Vec3;
  mode?: ObjectSnapMode;
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

export function objectSnapCandidates(doc: Document, mode: ObjectSnapMode, excludedId?: string | null, reference?: Vec3 | null): SnapCandidate[] {
  const tag = (points: Vec3[]): SnapCandidate[] => points.map((world) => ({ world, mode }));
  if (mode === 'intersection' || mode === 'apparent-intersection') return tag(intersectionCandidates(doc, excludedId));
  if (mode === 'perpendicular') return tag(perpendicularCandidates(doc, reference, excludedId));
  const candidates: Vec3[] = [];
  const addLocal = (entity: Entity, point: Vec2): void => {
    candidates.push(localToWorld(entity.workPlane ?? WORLD_WORK_PLANE, point));
  };
  for (const entity of doc.entities) {
    if (entity.id === excludedId || doc.hiddenLayers.has(entity.layer)) continue;
    if (mode === 'end' || mode === 'mid2p') addEntityEnds(entity, addLocal);
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
  return tag(candidates);
}

function entitySegments(entity: Entity): Array<[Vec2, Vec2]> {
  let points: Vec2[] = [];
  let closed = false;
  if (entity.type === 'line') points = [entity.start, entity.end];
  else if (entity.type === 'rectangle') {
    points = [entity.first, { x: entity.opposite.x, y: entity.first.y }, entity.opposite, { x: entity.first.x, y: entity.opposite.y }];
    closed = true;
  } else if (entity.type === 'polyline' || entity.type === 'octagon') {
    points = entity.vertices;
    closed = entity.type === 'octagon' || entity.closed;
  } else if (entity.type === 'circle') {
    points = Array.from({ length: 32 }, (_, index) => {
      const angle = index / 32 * Math.PI * 2;
      return { x: entity.center.x + Math.cos(angle) * entity.radius, y: entity.center.y + Math.sin(angle) * entity.radius };
    });
    closed = true;
  } else if (entity.type === 'arc' || entity.type === 'bezier') {
    points = curvePoints(entity, 32);
  }
  const result: Array<[Vec2, Vec2]> = [];
  for (let index = 0; index < points.length - 1; index++) result.push([points[index], points[index + 1]]);
  if (closed && points.length > 2) result.push([points.at(-1)!, points[0]]);
  return result;
}

function segmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const ab = { x: b.x - a.x, y: b.y - a.y };
  const cd = { x: d.x - c.x, y: d.y - c.y };
  const denominator = ab.x * cd.y - ab.y * cd.x;
  if (Math.abs(denominator) < 1e-10) return null;
  const ac = { x: c.x - a.x, y: c.y - a.y };
  const t = (ac.x * cd.y - ac.y * cd.x) / denominator;
  const u = (ac.x * ab.y - ac.y * ab.x) / denominator;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: a.x + ab.x * t, y: a.y + ab.y * t };
}

function intersectionCandidates(doc: Document, excludedId?: string | null): Vec3[] {
  const entities = doc.entities.filter((entity) => entity.id !== excludedId && !doc.hiddenLayers.has(entity.layer));
  const candidates: Vec3[] = [];
  for (let first = 0; first < entities.length; first++) {
    const a = entities[first];
    const plane = a.workPlane ?? WORLD_WORK_PLANE;
    for (let second = first + 1; second < entities.length; second++) {
      const b = entities[second];
      const bSegments = entitySegments(b).map(([start, end]) => [
        worldToLocal(plane, localToWorld(b.workPlane ?? WORLD_WORK_PLANE, start)),
        worldToLocal(plane, localToWorld(b.workPlane ?? WORLD_WORK_PLANE, end)),
      ] as [Vec3, Vec3]);
      for (const [aStart, aEnd] of entitySegments(a)) for (const [bStart, bEnd] of bSegments) {
        const point = segmentIntersection(aStart, aEnd, bStart, bEnd);
        if (point) candidates.push(localToWorld(plane, point));
      }
    }
  }
  return candidates;
}

function perpendicularCandidates(doc: Document, reference?: Vec3 | null, excludedId?: string | null): Vec3[] {
  if (!reference) return [];
  const candidates: Vec3[] = [];
  for (const entity of doc.entities) {
    if (entity.id === excludedId || doc.hiddenLayers.has(entity.layer)) continue;
    const plane = entity.workPlane ?? WORLD_WORK_PLANE;
    const localReference = worldToLocal(plane, reference);
    for (const [start, end] of entitySegments(entity)) {
      const dx = end.x - start.x, dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;
      if (lengthSquared < 1e-12) continue;
      const t = Math.max(0, Math.min(1, ((localReference.x - start.x) * dx + (localReference.y - start.y) * dy) / lengthSquared));
      candidates.push(localToWorld(plane, { x: start.x + dx * t, y: start.y + dy * t }));
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

export function nearestCandidate2d(candidates: readonly SnapCandidate[], cursor: Vec2, plane: WorkPlane, tolerance: number): SnapTarget | null {
  let best = tolerance;
  let result: SnapTarget | null = null;
  for (const candidate of candidates) {
    const local = worldToLocal(plane, candidate.world);
    const distance = Math.hypot(local.x - cursor.x, local.y - cursor.y);
    if (distance <= best) {
      best = distance;
      result = { point: { x: local.x, y: local.y }, world: candidate.world, mode: candidate.mode };
    }
  }
  return result;
}

export function nearestCandidateProjected(
  candidates: readonly SnapCandidate[],
  cursor: Vec2,
  project: (point: Vec3) => Vec2 | null,
  tolerance: number,
  plane: WorkPlane,
): SnapTarget | null {
  let best = tolerance;
  let result: SnapCandidate | null = null;
  for (const candidate of candidates) {
    const projected = project(candidate.world);
    if (!projected) continue;
    const distance = Math.hypot(projected.x - cursor.x, projected.y - cursor.y);
    if (distance <= best) { best = distance; result = candidate; }
  }
  if (!result) return null;
  const local = worldToLocal(plane, result.world);
  return { point: { x: local.x, y: local.y }, world: result.world, mode: result.mode };
}
