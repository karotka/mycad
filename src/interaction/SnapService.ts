import type { Document } from '../core/Document';
import { curvePoints, ellipseAxisPoints, ellipsePoints, expandedInsertEntities, expandedInsertSolids, getEntityPoints, type Entity, type Solid, type SolidMesh } from '../core/entities/types';
import type { Vec2, Vec3 } from '../math/geometry';
import { localToWorld, WORLD_WORK_PLANE, worldToLocal, type WorkPlane } from '../math/workplane';
import { solidBounds } from './PickingService';
import type { ObjectSnapMode } from '../core/settings';
import { solidCircularEdgeCenters, solidFeatureEdges } from '../core/solids/SolidTopology';
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

const localPointZ = (point: Vec2): number | undefined => (point as Vec2 & { z?: number }).z;

/** The real, topological corners of a solid — endpoints of its true feature
 *  edges, deduplicated — rather than every triangle vertex the tessellation
 *  happened to produce (which, on a curved wall or a CSG seam, are many and
 *  none of them exactly the corner a user means by "endpoint"). */
function solidCornerVertices(mesh: SolidMesh): Vec3[] {
  const seen = new Set<string>();
  const vertices: Vec3[] = [];
  const add = (point: Vec3): void => {
    const key = `${point.x.toFixed(6)}:${point.y.toFixed(6)}:${point.z.toFixed(6)}`;
    if (seen.has(key)) return;
    seen.add(key);
    vertices.push(point);
  };
  for (const edge of solidFeatureEdges(mesh)) { add(edge.start); add(edge.end); }
  return vertices;
}

function visibleSnapSolids(doc: Document, excludedId?: string | null): Array<{ solid: Solid; ownerId: string }> {
  const result = doc.solids
    .filter((solid) => solid.id !== excludedId && !doc.hiddenLayers.has(solid.layer))
    .map((solid) => ({ solid, ownerId: solid.id }));
  for (const entity of doc.entities) {
    if (entity.type !== 'insert' || entity.id === excludedId || doc.hiddenLayers.has(entity.layer)) continue;
    expandedInsertSolids(entity).forEach((solid) => result.push({ solid, ownerId: entity.id }));
  }
  return result;
}

const entityPlaneOffset = (entity: Entity): number => {
  if (entity.type === 'insert') return localPointZ(entity.position) ?? 0;
  if (entity.type === 'point') return localPointZ(entity.position) ?? 0;
  if (entity.type === 'circle' || entity.type === 'ellipse' || entity.type === 'octagon' || entity.type === 'arc') {
    return localPointZ(entity.center) ?? 0;
  }
  if (entity.type === 'rectangle') return ((localPointZ(entity.first) ?? 0) + (localPointZ(entity.opposite) ?? 0)) / 2;
  if (entity.type === 'bezier') return localPointZ(entity.start) ?? 0;
  return 0;
};

const midpoint = (a: Vec2, b: Vec2): Vec2 => {
  const point = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } as Vec2 & { z?: number };
  const firstZ = localPointZ(a), secondZ = localPointZ(b);
  if (firstZ !== undefined || secondZ !== undefined) point.z = ((firstZ ?? 0) + (secondZ ?? 0)) / 2;
  return point;
};

export function measurementCandidates(doc: Document): Vec3[] {
  const candidates: Vec3[] = [];
  for (const entity of doc.entities) {
    if (doc.hiddenLayers.has(entity.layer)) continue;
    for (const point of getEntityPoints(entity)) {
      candidates.push(localToWorld(entity.workPlane ?? WORLD_WORK_PLANE, point, localPointZ(point) ?? entityPlaneOffset(entity)));
    }
    if (entity.type === 'insert') for (const solid of expandedInsertSolids(entity)) {
      for (let index = 0; index < solid.mesh.positions.length; index += 3) {
        candidates.push({
          x: solid.mesh.positions[index], y: solid.mesh.positions[index + 1], z: solid.mesh.positions[index + 2],
        });
      }
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
  // "Nearest" is not a set of discrete points but the point under the cursor on
  // an edge, so it is resolved separately in nearestEdgeWorldPoint.
  if (mode === 'nearest') return [];
  if (mode === 'intersection' || mode === 'apparent-intersection') return tag(intersectionCandidates(doc, excludedId));
  if (mode === 'perpendicular') return tag(perpendicularCandidates(doc, reference, excludedId));
  if (mode === 'tangent') return tag(tangentCandidates(doc, reference, excludedId));
  const candidates: Vec3[] = [];
  const addLocal = (entity: Entity, point: Vec2): void => {
    candidates.push(localToWorld(entity.workPlane ?? WORLD_WORK_PLANE, point, localPointZ(point) ?? entityPlaneOffset(entity)));
  };
  for (const entity of doc.entities) {
    if (entity.id === excludedId || doc.hiddenLayers.has(entity.layer)) continue;
    if (mode === 'node') {
      if (entity.type === 'point') addLocal(entity, entity.position);
      else if (entity.type === 'insert') expandedInsertEntities(entity)
        .filter((child) => child.type === 'point')
        .forEach((child) => addLocal(entity, (child as Extract<Entity, { type: 'point' }>).position));
    } else if (mode === 'end' || mode === 'mid2p') addEntityEnds(entity, addLocal);
    else if (mode === 'center') addEntityCenters(entity, addLocal);
    else addEntityMiddles(entity, addLocal);
  }
  for (const { solid } of visibleSnapSolids(doc, excludedId)) {
    if (mode === 'end') {
      // The raw triangulated mesh, not real topology: every tessellation
      // vertex on a curved wall or CSG seam offered itself as an "endpoint"
      // too, filling the space right around a real corner with a cloud of
      // close-but-not-quite candidates. solidFeatureEdges already exists to
      // reject exactly those (see its own doc comment) — the same filter
      // 'perpendicular' and 'nearest' already trust below.
      candidates.push(...solidCornerVertices(solid.mesh));
    } else if (mode === 'center') {
      const bounds = solidBounds(solid);
      candidates.push({
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
        z: (bounds.minZ + bounds.maxZ) / 2,
      });
      // A cylindrical hole has two usable centres: one on each face it opens
      // through. They are centres of circular feature-edge loops, not the
      // body's bounding-box centre.
      candidates.push(...solidCircularEdgeCenters(solid.mesh));
    } else if (mode === 'middle' || mode === 'mid2p') {
      addSolidEdgeMiddles(solid.mesh.positions, solid.mesh.indices, candidates);
    }
  }
  return tag(candidates);
}

/** Closest point on segment [a,b] to the infinite ray (origin, direction). */
function closestPointOnSegmentToRay(a: Vec3, b: Vec3, origin: Vec3, direction: Vec3): Vec3 {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const wx = a.x - origin.x, wy = a.y - origin.y, wz = a.z - origin.z;
  const uu = ux * ux + uy * uy + uz * uz;
  const uv = ux * direction.x + uy * direction.y + uz * direction.z;
  const vv = direction.x * direction.x + direction.y * direction.y + direction.z * direction.z;
  const uw = ux * wx + uy * wy + uz * wz;
  const vw = direction.x * wx + direction.y * wy + direction.z * wz;
  const denominator = uu * vv - uv * uv;
  let s = Math.abs(denominator) < 1e-9 ? 0 : (uv * vw - vv * uw) / denominator;
  s = Math.max(0, Math.min(1, s));
  return { x: a.x + ux * s, y: a.y + uy * s, z: a.z + uz * s };
}

/**
 * The point on the nearest edge under the cursor, in world space — the "Nearest"
 * object snap. Edges come from solid feature creases and from 2D entities; the
 * returned point keeps its true depth, so a line ended on it does not drop onto
 * the UCS/WCS plane. The point is the closest one on the edge to the cursor ray
 * (not a screen interpolation, which perspective would throw off), accepted only
 * when its projection lands within the aperture of the cursor.
 */
export function nearestEdgeWorldPoint(
  doc: Document,
  cursor: Vec2,
  ray: { origin: Vec3; direction: Vec3 },
  project: (point: Vec3) => Vec2 | null,
  pixelTolerance: number,
  excludedId?: string | null,
): Vec3 | null {
  let bestWorld: Vec3 | null = null;
  let bestDistance = Infinity;
  const consider = (a: Vec3, b: Vec3): void => {
    const point = closestPointOnSegmentToRay(a, b, ray.origin, ray.direction);
    const projected = project(point);
    if (!projected) return;
    const distance = Math.hypot(projected.x - cursor.x, projected.y - cursor.y);
    if (distance > pixelTolerance || distance >= bestDistance) return;
    bestDistance = distance;
    bestWorld = point;
  };
  for (const { solid } of visibleSnapSolids(doc, excludedId)) {
    for (const edge of solidFeatureEdges(solid.mesh)) consider(edge.start, edge.end);
  }
  for (const entity of doc.entities) {
    if (entity.id === excludedId || doc.hiddenLayers.has(entity.layer)) continue;
    const plane = entity.workPlane ?? WORLD_WORK_PLANE;
    const offset = entityPlaneOffset(entity);
    for (const [a, b] of entitySegments(entity)) {
      consider(
        localToWorld(plane, a, localPointZ(a) ?? offset),
        localToWorld(plane, b, localPointZ(b) ?? offset),
      );
    }
  }
  return bestWorld;
}

function entitySegments(entity: Entity): Array<[Vec2, Vec2]> {
  if (entity.type === 'insert') return expandedInsertEntities(entity).flatMap(entitySegments);
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
  } else if (entity.type === 'ellipse') {
    points = ellipsePoints(entity, 48).slice(0, -1);
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

interface XYBounds { minX: number; minY: number; maxX: number; maxY: number }

function segmentsXYBounds(segments: Array<[Vec2, Vec2]>): XYBounds | null {
  if (segments.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [a, b] of segments) {
    minX = Math.min(minX, a.x, b.x); maxX = Math.max(maxX, a.x, b.x);
    minY = Math.min(minY, a.y, b.y); maxY = Math.max(maxY, a.y, b.y);
  }
  return { minX, minY, maxX, maxY };
}

function intersectionCandidates(doc: Document, excludedId?: string | null): Vec3[] {
  const entities = doc.entities.filter((entity) => entity.id !== excludedId && !doc.hiddenLayers.has(entity.layer));
  // entitySegments() walks (and for an INSERT, expands) an entity's whole
  // geometry; computed inside the pair loop it ran once per *pair* instead of
  // once per entity — O(n) redundant work on top of the O(n^2) pairing itself,
  // which is what turned a few thousand entities into a multi-minute hang.
  const segmentsByEntity = entities.map((entity) => entitySegments(entity));
  // A drawing's entities mostly sit nowhere near each other, so most of the n^2
  // pairs can never intersect. A quick bounding-box overlap check (ignoring Z —
  // a false positive there just means an unnecessary full check, never a missed
  // intersection) skips the expensive segment-pair loop for those pairs. This is
  // what makes a few thousand entities with a couple of huge nested blocks
  // tractable instead of a multi-minute hang.
  const boundsByEntity = segmentsByEntity.map(segmentsXYBounds);
  const candidates: Vec3[] = [];
  for (let first = 0; first < entities.length; first++) {
    const a = entities[first];
    const plane = a.workPlane ?? WORLD_WORK_PLANE;
    const aSegments = segmentsByEntity[first];
    const aBounds = boundsByEntity[first];
    for (let second = first + 1; second < entities.length; second++) {
      const b = entities[second];
      const bPlane = b.workPlane ?? WORLD_WORK_PLANE;
      const transformToA = (point: Vec2): Vec3 =>
        worldToLocal(plane, localToWorld(bPlane, point, localPointZ(point) ?? entityPlaneOffset(b)));
      const bBoundsLocal = boundsByEntity[second];
      if (aBounds && bBoundsLocal) {
        const corners = [
          { x: bBoundsLocal.minX, y: bBoundsLocal.minY }, { x: bBoundsLocal.maxX, y: bBoundsLocal.minY },
          { x: bBoundsLocal.maxX, y: bBoundsLocal.maxY }, { x: bBoundsLocal.minX, y: bBoundsLocal.maxY },
        ].map(transformToA);
        const bMinX = Math.min(...corners.map((c) => c.x)), bMaxX = Math.max(...corners.map((c) => c.x));
        const bMinY = Math.min(...corners.map((c) => c.y)), bMaxY = Math.max(...corners.map((c) => c.y));
        if (bMaxX < aBounds.minX || bMinX > aBounds.maxX || bMaxY < aBounds.minY || bMinY > aBounds.maxY) continue;
      }
      const bSegments = segmentsByEntity[second].map(([start, end]) => [transformToA(start), transformToA(end)] as [Vec3, Vec3]);
      for (const [aStart, aEnd] of aSegments) for (const [bStart, bEnd] of bSegments) {
        const point = segmentIntersection(aStart, aEnd, bStart, bEnd);
        if (point) candidates.push(localToWorld(plane, point, entityPlaneOffset(a)));
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
      const startZ = localPointZ(start) ?? entityPlaneOffset(entity);
      const endZ = localPointZ(end) ?? entityPlaneOffset(entity);
      candidates.push(localToWorld(plane, { x: start.x + dx * t, y: start.y + dy * t }, startZ + (endZ - startZ) * t));
    }
  }
  for (const { solid } of visibleSnapSolids(doc, excludedId)) {
    for (const edge of solidFeatureEdges(solid.mesh)) {
      const dx = edge.end.x - edge.start.x;
      const dy = edge.end.y - edge.start.y;
      const dz = edge.end.z - edge.start.z;
      const lengthSquared = dx * dx + dy * dy + dz * dz;
      if (lengthSquared < 1e-12) continue;
      const t = Math.max(0, Math.min(1, (
        (reference.x - edge.start.x) * dx
        + (reference.y - edge.start.y) * dy
        + (reference.z - edge.start.z) * dz
      ) / lengthSquared));
      candidates.push({
        x: edge.start.x + dx * t,
        y: edge.start.y + dy * t,
        z: edge.start.z + dz * t,
      });
    }
  }
  return candidates;
}

/** True when `angle` lies within the arc's own sweep, starting at
 *  `startAngle` and running counter-clockwise (an arc's sweep is always
 *  stored positive) — a tangent point that only exists on the *rest* of the
 *  full circle is not one this arc actually offers. */
function angleWithinSweep(angle: number, startAngle: number, sweepAngle: number): boolean {
  const twoPi = Math.PI * 2;
  const delta = ((angle - startAngle) % twoPi + twoPi) % twoPi;
  return delta <= sweepAngle + 1e-9;
}

/**
 * The one or two points where a line from `reference` would run tangent to a
 * circle or arc — AutoCAD's Tangent object snap. From a point outside a
 * circle of radius r at distance d, the tangent points sit at angle
 * ±arccos(r/d) from the direction to the circle's centre; a point on or
 * inside the circle has none. Not solved for the previous point directly:
 * both candidates are always offered (tagged 'tangent' like everything else),
 * and nearestCandidate2d/nearestCandidateProjected already pick whichever one
 * the cursor sits closer to.
 */
function tangentCandidates(doc: Document, reference?: Vec3 | null, excludedId?: string | null): Vec3[] {
  if (!reference) return [];
  const candidates: Vec3[] = [];
  for (const entity of doc.entities) {
    if (entity.id === excludedId || doc.hiddenLayers.has(entity.layer)) continue;
    if (entity.type !== 'circle' && entity.type !== 'arc') continue;
    const plane = entity.workPlane ?? WORLD_WORK_PLANE;
    const local = worldToLocal(plane, reference);
    const dx = local.x - entity.center.x, dy = local.y - entity.center.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= entity.radius + 1e-9) continue; // on or inside: no real tangent line
    const centerAngle = Math.atan2(dy, dx);
    const offset = Math.acos(entity.radius / distance);
    const z = localPointZ(entity.center) ?? entityPlaneOffset(entity);
    for (const angle of [centerAngle + offset, centerAngle - offset]) {
      if (entity.type === 'arc' && !angleWithinSweep(angle, entity.startAngle, entity.sweepAngle)) continue;
      candidates.push(localToWorld(plane, {
        x: entity.center.x + Math.cos(angle) * entity.radius,
        y: entity.center.y + Math.sin(angle) * entity.radius,
      }, z));
    }
  }
  return candidates;
}

/**
 * Where a circle's own centre should land so that, at its own fixed radius,
 * it becomes tangent to a target line or circle/arc — grip-dragging a whole
 * circle onto Tangent, as distinct from `tangentCandidates` above (which
 * places a point ON a fixed circle, reached from a reference point). Here the
 * valid centres are not a couple of discrete points but a whole offset line
 * (parallel to a target line, radius away) or offset circle (concentric with
 * a target circle, at the sum or difference of the two radii), so the raw
 * cursor position stands in for the reference, picking the one point on that
 * locus nearest itself — recomputed fresh on every call since it tracks
 * the cursor rather than fixed geometry.
 */
export function tangentDragCandidates(doc: Document, radius: number, cursor: Vec3, excludedId?: string | null): SnapCandidate[] {
  if (!(radius > 1e-9)) return [];
  const candidates: SnapCandidate[] = [];
  for (const entity of doc.entities) {
    if (entity.id === excludedId || doc.hiddenLayers.has(entity.layer)) continue;
    const plane = entity.workPlane ?? WORLD_WORK_PLANE;
    const local = worldToLocal(plane, cursor);
    if (entity.type === 'circle' || entity.type === 'arc') {
      const dx = local.x - entity.center.x, dy = local.y - entity.center.y;
      const dist = Math.hypot(dx, dy);
      const ux = dist > 1e-9 ? dx / dist : 1, uy = dist > 1e-9 ? dy / dist : 0;
      const z = localPointZ(entity.center) ?? entityPlaneOffset(entity);
      const contactAngle = Math.atan2(uy, ux);
      if (entity.type === 'arc' && !angleWithinSweep(contactAngle, entity.startAngle, entity.sweepAngle)) continue;
      for (const separation of [entity.radius + radius, Math.abs(entity.radius - radius)]) {
        if (separation < 1e-9) continue;
        candidates.push({
          world: localToWorld(plane, { x: entity.center.x + ux * separation, y: entity.center.y + uy * separation }, z),
          mode: 'tangent',
        });
      }
    } else {
      for (const [start, end] of entitySegments(entity)) {
        const dx = end.x - start.x, dy = end.y - start.y;
        const lengthSquared = dx * dx + dy * dy;
        if (lengthSquared < 1e-12) continue;
        const length = Math.sqrt(lengthSquared);
        const t = Math.max(0, Math.min(1, ((local.x - start.x) * dx + (local.y - start.y) * dy) / lengthSquared));
        const footX = start.x + dx * t, footY = start.y + dy * t;
        const nx = -dy / length, ny = dx / length;
        const side = (local.x - footX) * nx + (local.y - footY) * ny >= 0 ? 1 : -1;
        const startZ = localPointZ(start) ?? entityPlaneOffset(entity);
        const endZ = localPointZ(end) ?? entityPlaneOffset(entity);
        candidates.push({
          world: localToWorld(
            plane,
            { x: footX + nx * radius * side, y: footY + ny * radius * side },
            startZ + (endZ - startZ) * t,
          ),
          mode: 'tangent',
        });
      }
    }
  }
  return candidates;
}

function addEntityEnds(entity: Entity, add: (entity: Entity, point: Vec2) => void): void {
  if (entity.type === 'insert') { expandedInsertEntities(entity).forEach((child) => addEntityEnds(child, (_child, point) => add(entity, point))); return; }
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
  } else if (entity.type === 'ellipse') ellipseAxisPoints(entity).forEach((point) => add(entity, point));
  else if (entity.type === 'text') add(entity, entity.position);
}

function addEntityCenters(entity: Entity, add: (entity: Entity, point: Vec2) => void): void {
  if (entity.type === 'insert') { expandedInsertEntities(entity).forEach((child) => addEntityCenters(child, (_child, point) => add(entity, point))); return; }
  if (entity.type === 'circle' || entity.type === 'arc' || entity.type === 'octagon' || entity.type === 'ellipse') add(entity, entity.center);
  else if (entity.type === 'rectangle') add(entity, midpoint(entity.first, entity.opposite));
  else if (entity.type === 'bezier') add(entity, curvePoints(entity, 2)[1]);
  else if (entity.type === 'text') add(entity, entity.position);
}

function addEntityMiddles(entity: Entity, add: (entity: Entity, point: Vec2) => void): void {
  if (entity.type === 'insert') { expandedInsertEntities(entity).forEach((child) => addEntityMiddles(child, (_child, point) => add(entity, point))); return; }
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

/** How close two candidates' screen distances have to be to call it a tie —
 *  see the depth tie-break below. */
const SCREEN_TIE_MARGIN_PX = 2;

export function nearestCandidateProjected(
  candidates: readonly SnapCandidate[],
  cursor: Vec2,
  project: (point: Vec3) => (Vec2 & { depth?: number }) | null,
  tolerance: number,
  plane: WorkPlane,
): SnapTarget | null {
  const withinTolerance: Array<{ candidate: SnapCandidate; distance: number; depth: number }> = [];
  for (const candidate of candidates) {
    const projected = project(candidate.world);
    if (!projected) continue;
    const distance = Math.hypot(projected.x - cursor.x, projected.y - cursor.y);
    if (distance <= tolerance) withinTolerance.push({ candidate, distance, depth: projected.depth ?? 0 });
  }
  if (withinTolerance.length === 0) return null;
  // A screen-space tie is routine under perspective — a solid's near and far
  // corner can land on almost the same pixel while being nowhere near each
  // other in the model. Among near-ties, the one actually facing the camera
  // (the smaller normalized depth) is the one a click there was meant for;
  // picking whichever merely projected fractionally closer used to snap a
  // line onto a hidden vertex sitting right behind the visible one.
  const minDistance = Math.min(...withinTolerance.map((entry) => entry.distance));
  const tied = withinTolerance.filter((entry) => entry.distance <= minDistance + SCREEN_TIE_MARGIN_PX);
  const result = tied.reduce((best, entry) => (entry.depth < best.depth ? entry : best)).candidate;
  const local = worldToLocal(plane, result.world);
  return { point: { x: local.x, y: local.y }, world: result.world, mode: result.mode };
}
