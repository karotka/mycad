import type { Entity, SolidFaceRegion, SolidMesh } from '../entities/types';
import type { Vec3 } from '../../math/geometry';
import { polygonSignedArea, type Vec2 } from '../../math/geometry';
import { localToWorld, workPlaneFromXAxis, worldToLocal, WORLD_WORK_PLANE, type WorkPlane } from '../../math/workplane';

/** A visible crease or boundary in a triangulated solid, never a coplanar diagonal. */
export interface SolidFeatureEdge {
  a: number;
  b: number;
  start: Vec3;
  end: Vec3;
}

interface IndexedEdge {
  a: number;
  b: number;
  normals: Vec3[];
}

const DEFAULT_SMOOTH_DOT = 0.95;
const featureEdgeCache = new WeakMap<SolidMesh, SolidFeatureEdge[]>();
const circularCentreCache = new WeakMap<SolidMesh, Vec3[]>();
const planarFaceCache = new WeakMap<SolidMesh, PlanarFace[]>();

/** One connected coplanar surface reconstructed from indexed mesh triangles. */
export interface PlanarFace {
  triangleIndices: number[];
  vertexIndices: number[];
  normal: Vec3;
  plane: WorkPlane;
  /** Outer loop first (CCW in `plane`), then holes (CW). */
  loops: Vec2[][];
}

const pointAt = (mesh: SolidMesh, index: number): Vec3 => ({
  x: mesh.positions[index * 3],
  y: mesh.positions[index * 3 + 1],
  z: mesh.positions[index * 3 + 2],
});

function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 | null {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  const x = uy * vz - uz * vy;
  const y = uz * vx - ux * vz;
  const z = ux * vy - uy * vx;
  const length = Math.hypot(x, y, z);
  return length > 1e-12 ? { x: x / length, y: y / length, z: z / length } : null;
}

interface TriangleData {
  index: number;
  ids: [number, number, number];
  normal: Vec3;
  offset: number;
}

const edgeKey = (a: number, b: number): string => a < b ? `${a}:${b}` : `${b}:${a}`;
const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * Reconstructs real planar faces from triangle soup. Connectivity matters: two
 * parallel surfaces in one plane remain separate unless their triangles share
 * an edge. Internal triangulation diagonals disappear into the face.
 */
export function solidPlanarFaces(mesh: SolidMesh): PlanarFace[] {
  const cached = planarFaceCache.get(mesh);
  if (cached) return cached;

  const triangles: TriangleData[] = [];
  const incident = new Map<string, number[]>();
  for (let offset = 0; offset + 2 < mesh.indices.length; offset += 3) {
    const ids: [number, number, number] = [mesh.indices[offset], mesh.indices[offset + 1], mesh.indices[offset + 2]];
    const first = pointAt(mesh, ids[0]);
    const normal = triangleNormal(first, pointAt(mesh, ids[1]), pointAt(mesh, ids[2]));
    if (!normal) continue;
    const triangle: TriangleData = { index: offset / 3, ids, normal, offset: dot3(normal, first) };
    const storedIndex = triangles.length;
    triangles.push(triangle);
    for (let edge = 0; edge < 3; edge++) {
      const key = edgeKey(ids[edge], ids[(edge + 1) % 3]);
      incident.set(key, [...(incident.get(key) ?? []), storedIndex]);
    }
  }

  // Some built-in meshes predate Manifold's outward-winding convention and are
  // consistently inside-out. Signed volume tells us which way the complete
  // shell is wound, so face normals presented to modelling tools are outward in
  // either case.
  const orientation = signedMeshVolume(mesh) < 0 ? -1 : 1;
  const visited = new Set<number>();
  const faces: PlanarFace[] = [];
  for (let seed = 0; seed < triangles.length; seed++) {
    if (visited.has(seed)) continue;
    const group: number[] = [];
    const queue = [seed];
    const basis = triangles[seed];
    const scale = meshScale(mesh);
    const planeTolerance = Math.max(1e-6, scale * 1e-6);
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (visited.has(current)) continue;
      const triangle = triangles[current];
      if (dot3(triangle.normal, basis.normal) < 0.999999 || Math.abs(triangle.offset - basis.offset) > planeTolerance) continue;
      visited.add(current);
      group.push(current);
      for (let edge = 0; edge < 3; edge++) {
        for (const next of incident.get(edgeKey(triangle.ids[edge], triangle.ids[(edge + 1) % 3])) ?? []) {
          if (!visited.has(next)) queue.push(next);
        }
      }
    }
    if (group.length === 0) continue;

    const boundary = new Map<string, { count: number; a: number; b: number }>();
    const vertices = new Set<number>();
    for (const triangleIndex of group) {
      const triangle = triangles[triangleIndex];
      triangle.ids.forEach((id) => vertices.add(id));
      for (let edge = 0; edge < 3; edge++) {
        const a = triangle.ids[edge], b = triangle.ids[(edge + 1) % 3];
        const key = edgeKey(a, b);
        const stored = boundary.get(key);
        if (stored) stored.count++;
        else boundary.set(key, { count: 1, a, b });
      }
    }
    const loops3 = boundaryLoops([...boundary.values()].filter((edge) => edge.count === 1), mesh);
    if (loops3.length === 0) continue;
    const longest = longestLoopEdge(loops3);
    if (!longest) continue;
    const outwardNormal = {
      x: basis.normal.x * orientation,
      y: basis.normal.y * orientation,
      z: basis.normal.z * orientation,
    };
    const plane = workPlaneFromXAxis(longest.start, longest.end, outwardNormal);
    let loops = loops3.map((loop) => loop.map((point) => {
      const local = worldToLocal(plane, point);
      return { x: local.x, y: local.y };
    }));
    loops.sort((a, b) => Math.abs(polygonSignedArea(b)) - Math.abs(polygonSignedArea(a)));
    loops = loops.map((loop, index) => {
      const area = polygonSignedArea(loop);
      const wantsPositive = index === 0;
      return (wantsPositive ? area < 0 : area > 0) ? [...loop].reverse() : loop;
    });
    faces.push({
      triangleIndices: group.map((index) => triangles[index].index),
      vertexIndices: [...vertices],
      normal: outwardNormal,
      plane,
      loops,
    });
  }
  planarFaceCache.set(mesh, faces);
  return faces;
}

function signedMeshVolume(mesh: SolidMesh): number {
  let volume = 0;
  for (let offset = 0; offset + 2 < mesh.indices.length; offset += 3) {
    const a = pointAt(mesh, mesh.indices[offset]);
    const b = pointAt(mesh, mesh.indices[offset + 1]);
    const c = pointAt(mesh, mesh.indices[offset + 2]);
    volume += (
      a.x * (b.y * c.z - b.z * c.y)
      + a.y * (b.z * c.x - b.x * c.z)
      + a.z * (b.x * c.y - b.y * c.x)
    ) / 6;
  }
  return volume;
}

function meshScale(mesh: SolidMesh): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < mesh.positions.length; index += 3) {
    minX = Math.min(minX, mesh.positions[index]); maxX = Math.max(maxX, mesh.positions[index]);
    minY = Math.min(minY, mesh.positions[index + 1]); maxY = Math.max(maxY, mesh.positions[index + 1]);
    minZ = Math.min(minZ, mesh.positions[index + 2]); maxZ = Math.max(maxZ, mesh.positions[index + 2]);
  }
  return Math.max(1, maxX - minX, maxY - minY, maxZ - minZ);
}

function boundaryLoops(edges: Array<{ a: number; b: number }>, mesh: SolidMesh): Vec3[][] {
  const outgoing = new Map<number, number[]>();
  edges.forEach(({ a, b }) => outgoing.set(a, [...(outgoing.get(a) ?? []), b]));
  const unused = new Set(edges.map(({ a, b }) => `${a}:${b}`));
  const loops: Vec3[][] = [];
  for (const edge of edges) {
    if (!unused.has(`${edge.a}:${edge.b}`)) continue;
    const ids: number[] = [];
    const start = edge.a;
    let current = edge.a;
    let next = edge.b;
    while (unused.delete(`${current}:${next}`)) {
      ids.push(current);
      current = next;
      if (current === start) break;
      const candidate = (outgoing.get(current) ?? []).find((value) => unused.has(`${current}:${value}`));
      if (candidate === undefined) break;
      next = candidate;
    }
    if (current === start && ids.length >= 3) loops.push(ids.map((id) => pointAt(mesh, id)));
  }
  return loops;
}

function longestLoopEdge(loops: Vec3[][]): { start: Vec3; end: Vec3 } | null {
  let result: { start: Vec3; end: Vec3 } | null = null;
  let best = 0;
  for (const loop of loops) for (let index = 0; index < loop.length; index++) {
    const start = loop[index], end = loop[(index + 1) % loop.length];
    const length = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
    if (length > best) { best = length; result = { start, end }; }
  }
  return result;
}

/** Regions of a planar face after coplanar lines and closed profiles divide it. */
export function planarFaceRegions(face: PlanarFace, entities: readonly Entity[]): SolidFaceRegion[] {
  let regions: SolidFaceRegion[] = [{ plane: face.plane, loops: face.loops.map(cloneLoop) }];
  for (const entity of entities) {
    if (entity.type !== 'line') continue;
    const entityPlane = entity.workPlane ?? WORLD_WORK_PLANE;
    const start = worldToLocal(face.plane, localToWorld(entityPlane, entity.start));
    const end = worldToLocal(face.plane, localToWorld(entityPlane, entity.end));
    if (Math.abs(start.z) > 1e-5 || Math.abs(end.z) > 1e-5) continue;
    const splitter = [{ x: start.x, y: start.y }, { x: end.x, y: end.y }] as const;
    const next: SolidFaceRegion[] = [];
    for (const region of regions) {
      // Cutting a polygon with holes needs a full planar arrangement. Until
      // that generalisation, preserve such a region intact rather than lose
      // its holes and accidentally fill material that is not there.
      if (region.loops.length !== 1) { next.push(region); continue; }
      const split = splitPolygonBySegment(region.loops[0], splitter[0], splitter[1]);
      next.push(...(split?.map((outer) => ({ plane: face.plane, loops: [outer] })) ?? [region]));
    }
    regions = next;
  }

  // A closed sketch inside a face makes two regions: its interior and the
  // surrounding face with the sketch as a hole. This is enough for a true
  // pocket as well as an island; nested or intersecting profiles are accepted
  // only when one loop is wholly contained in one existing region.
  for (const entity of entities) {
    const profile = closedEntityLoopOnFace(entity, face.plane);
    if (!profile) continue;
    const containerIndex = regions.findIndex((region) => loopStrictlyInsideRegion(profile, region.loops));
    if (containerIndex < 0) continue;
    const container = regions[containerIndex];
    const outer = polygonSignedArea(profile) < 0 ? [...profile].reverse() : profile;
    regions.splice(containerIndex, 1,
      { plane: face.plane, loops: [container.loops[0], ...container.loops.slice(1), [...outer].reverse()] },
      { plane: face.plane, loops: [outer] },
    );
  }
  return regions;
}

/** The region under a world-space hit point, or null outside the face/inside a hole. */
export function planarFaceRegionAt(face: PlanarFace, entities: readonly Entity[], point: Vec3): SolidFaceRegion | null {
  const local = worldToLocal(face.plane, point);
  if (Math.abs(local.z) > 1e-4) return null;
  return planarFaceRegions(face, entities).find((region) => pointInRegion({ x: local.x, y: local.y }, region.loops)) ?? null;
}

function cloneLoop(loop: Vec2[]): Vec2[] { return loop.map((point) => ({ ...point })); }

function closedEntityLoopOnFace(entity: Entity, facePlane: WorkPlane): Vec2[] | null {
  const samples: Vec2[] | null = entity.type === 'circle'
    ? Array.from({ length: 64 }, (_unused, index) => {
      const angle = index * Math.PI * 2 / 64;
      return { x: entity.center.x + Math.cos(angle) * entity.radius, y: entity.center.y + Math.sin(angle) * entity.radius };
    })
    : entity.type === 'ellipse'
      ? Array.from({ length: 64 }, (_unused, index) => {
        const angle = index * Math.PI * 2 / 64;
        const x = Math.cos(angle) * entity.radiusX, y = Math.sin(angle) * entity.radiusY;
        const cos = Math.cos(entity.rotation), sin = Math.sin(entity.rotation);
        return { x: entity.center.x + x * cos - y * sin, y: entity.center.y + x * sin + y * cos };
      })
      : entity.type === 'rectangle'
        ? [entity.first, { x: entity.opposite.x, y: entity.first.y }, entity.opposite, { x: entity.first.x, y: entity.opposite.y }]
        : entity.type === 'octagon'
          ? entity.vertices
          : entity.type === 'polyline' && entity.closed
            ? entity.vertices
            : null;
  if (!samples || samples.length < 3) return null;
  const entityPlane = entity.workPlane ?? WORLD_WORK_PLANE;
  const projected: Vec2[] = [];
  for (const sample of samples) {
    const local = worldToLocal(facePlane, localToWorld(entityPlane, sample));
    if (Math.abs(local.z) > 1e-5) return null;
    projected.push({ x: local.x, y: local.y });
  }
  const loop = dedupeLoop(projected);
  return loop.length >= 3 && Math.abs(polygonSignedArea(loop)) > 1e-9 ? loop : null;
}

function loopStrictlyInsideRegion(loop: Vec2[], regionLoops: Vec2[][]): boolean {
  if (!loop.every((point) => pointInRegion(point, regionLoops))) return false;
  for (const boundary of regionLoops) {
    for (const point of loop) {
      for (let index = 0; index < boundary.length; index++) {
        if (pointOnSegment(point, boundary[index], boundary[(index + 1) % boundary.length], 1e-7)) return false;
      }
    }
    for (let first = 0; first < loop.length; first++) {
      for (let second = 0; second < boundary.length; second++) {
        if (segmentIntersection(
          loop[first], loop[(first + 1) % loop.length],
          boundary[second], boundary[(second + 1) % boundary.length],
        )) return false;
      }
    }
  }
  return true;
}

function pointInRegion(point: Vec2, loops: Vec2[][]): boolean {
  if (!pointInPolygon(point, loops[0])) return false;
  return !loops.slice(1).some((hole) => pointInPolygon(point, hole));
}

function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index], b = polygon[previous];
    if (pointOnSegment(point, a, b, 1e-7)) return true;
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function splitPolygonBySegment(polygon: Vec2[], start: Vec2, end: Vec2): [Vec2[], Vec2[]] | null {
  if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-8) return null;
  const crossings: Vec2[] = [];
  for (let index = 0; index < polygon.length; index++) {
    const hit = segmentIntersection(start, end, polygon[index], polygon[(index + 1) % polygon.length]);
    if (hit && !crossings.some((point) => Math.hypot(point.x - hit.x, point.y - hit.y) < 1e-6)) crossings.push(hit);
  }
  if (crossings.length < 2) return null;
  const positive = clipHalfPlane(polygon, start, end, 1);
  const negative = clipHalfPlane(polygon, start, end, -1);
  if (positive.length < 3 || negative.length < 3) return null;
  const epsilon = Math.max(1e-10, Math.abs(polygonSignedArea(polygon)) * 1e-9);
  if (Math.abs(polygonSignedArea(positive)) <= epsilon || Math.abs(polygonSignedArea(negative)) <= epsilon) return null;
  return [positive, negative];
}

function clipHalfPlane(polygon: Vec2[], lineStart: Vec2, lineEnd: Vec2, sign: 1 | -1): Vec2[] {
  const side = (point: Vec2): number => sign * ((lineEnd.x - lineStart.x) * (point.y - lineStart.y) - (lineEnd.y - lineStart.y) * (point.x - lineStart.x));
  const output: Vec2[] = [];
  for (let index = 0; index < polygon.length; index++) {
    const current = polygon[index], next = polygon[(index + 1) % polygon.length];
    const currentSide = side(current), nextSide = side(next);
    if (currentSide >= -1e-8) output.push({ ...current });
    if ((currentSide > 1e-8 && nextSide < -1e-8) || (currentSide < -1e-8 && nextSide > 1e-8)) {
      const t = currentSide / (currentSide - nextSide);
      output.push({ x: current.x + (next.x - current.x) * t, y: current.y + (next.y - current.y) * t });
    }
  }
  return dedupeLoop(output);
}

function dedupeLoop(points: Vec2[]): Vec2[] {
  const result = points.filter((point, index) => index === 0 || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > 1e-7);
  if (result.length > 1 && Math.hypot(result[0].x - result.at(-1)!.x, result[0].y - result.at(-1)!.y) < 1e-7) result.pop();
  return result;
}

function segmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const ab = { x: b.x - a.x, y: b.y - a.y };
  const cd = { x: d.x - c.x, y: d.y - c.y };
  const denominator = ab.x * cd.y - ab.y * cd.x;
  if (Math.abs(denominator) < 1e-10) {
    for (const point of [a, b]) if (pointOnSegment(point, c, d, 1e-7)) return { ...point };
    for (const point of [c, d]) if (pointOnSegment(point, a, b, 1e-7)) return { ...point };
    return null;
  }
  const ac = { x: c.x - a.x, y: c.y - a.y };
  const t = (ac.x * cd.y - ac.y * cd.x) / denominator;
  const u = (ac.x * ab.y - ac.y * ab.x) / denominator;
  if (t < -1e-8 || t > 1 + 1e-8 || u < -1e-8 || u > 1 + 1e-8) return null;
  return { x: a.x + ab.x * t, y: a.y + ab.y * t };
}

function pointOnSegment(point: Vec2, start: Vec2, end: Vec2, tolerance: number): boolean {
  const dx = end.x - start.x, dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < tolerance) return Math.hypot(point.x - start.x, point.y - start.y) <= tolerance;
  return Math.abs(dx * (point.y - start.y) - dy * (point.x - start.x)) <= tolerance * length
    && (point.x - start.x) * (point.x - end.x) + (point.y - start.y) * (point.y - end.y) <= tolerance * tolerance;
}

/**
 * Extracts topological-looking edges from a triangle mesh. Adjacent coplanar
 * triangles are one face, and the shallow facets used to approximate a round
 * wall are one smooth surface; their internal edges must not become snap
 * targets. The default keeps creases sharper than about 18 degrees.
 */
export function solidFeatureEdges(mesh: SolidMesh, smoothDot = DEFAULT_SMOOTH_DOT): SolidFeatureEdge[] {
  if (smoothDot === DEFAULT_SMOOTH_DOT) {
    const cached = featureEdgeCache.get(mesh);
    if (cached) return cached;
  }
  const indexed = new Map<string, IndexedEdge>();
  for (let offset = 0; offset + 2 < mesh.indices.length; offset += 3) {
    const ids = [mesh.indices[offset], mesh.indices[offset + 1], mesh.indices[offset + 2]];
    const normal = triangleNormal(pointAt(mesh, ids[0]), pointAt(mesh, ids[1]), pointAt(mesh, ids[2]));
    if (!normal) continue;
    for (let edgeIndex = 0; edgeIndex < 3; edgeIndex++) {
      const first = ids[edgeIndex], second = ids[(edgeIndex + 1) % 3];
      const a = Math.min(first, second), b = Math.max(first, second);
      const key = `${a}:${b}`;
      const edge = indexed.get(key) ?? { a, b, normals: [] };
      edge.normals.push(normal);
      indexed.set(key, edge);
    }
  }

  const result: SolidFeatureEdge[] = [];
  for (const edge of indexed.values()) {
    const boundary = edge.normals.length !== 2;
    const crease = edge.normals.length === 2
      && edge.normals[0].x * edge.normals[1].x
        + edge.normals[0].y * edge.normals[1].y
        + edge.normals[0].z * edge.normals[1].z < smoothDot;
    if (!boundary && !crease) continue;
    result.push({ ...edge, start: pointAt(mesh, edge.a), end: pointAt(mesh, edge.b) });
  }
  if (smoothDot === DEFAULT_SMOOTH_DOT) featureEdgeCache.set(mesh, result);
  return result;
}

/**
 * Centres of round feature-edge loops, including both rims of a cylindrical
 * through-hole. A box's connected edge cage is deliberately rejected: every
 * vertex of a candidate loop must have degree two, the loop must be planar,
 * and all of its vertices must lie on one radius.
 */
export function solidCircularEdgeCenters(mesh: SolidMesh): Vec3[] {
  const cached = circularCentreCache.get(mesh);
  if (cached) return cached;
  const edges = solidFeatureEdges(mesh);
  const incident = new Map<number, number[]>();
  edges.forEach((edge, index) => {
    incident.set(edge.a, [...(incident.get(edge.a) ?? []), index]);
    incident.set(edge.b, [...(incident.get(edge.b) ?? []), index]);
  });

  const visited = new Set<number>();
  const centres: Vec3[] = [];
  for (let seed = 0; seed < edges.length; seed++) {
    if (visited.has(seed)) continue;
    const componentEdges: number[] = [];
    const queue = [seed];
    const vertices = new Set<number>();
    while (queue.length > 0) {
      const edgeIndex = queue.pop()!;
      if (visited.has(edgeIndex)) continue;
      visited.add(edgeIndex);
      componentEdges.push(edgeIndex);
      const edge = edges[edgeIndex];
      vertices.add(edge.a); vertices.add(edge.b);
      for (const vertex of [edge.a, edge.b]) {
        for (const next of incident.get(vertex) ?? []) if (!visited.has(next)) queue.push(next);
      }
    }
    if (vertices.size < 8 || componentEdges.length !== vertices.size) continue;
    if ([...vertices].some((vertex) => (incident.get(vertex)?.filter((index) => componentEdges.includes(index)).length ?? 0) !== 2)) continue;

    const adjacency = new Map<number, number[]>();
    for (const edgeIndex of componentEdges) {
      const edge = edges[edgeIndex];
      adjacency.set(edge.a, [...(adjacency.get(edge.a) ?? []), edge.b]);
      adjacency.set(edge.b, [...(adjacency.get(edge.b) ?? []), edge.a]);
    }
    const start = vertices.values().next().value as number;
    const ordered: number[] = [];
    let previous = -1, current = start;
    do {
      ordered.push(current);
      const next = adjacency.get(current)?.find((value) => value !== previous);
      if (next === undefined) break;
      previous = current;
      current = next;
    } while (current !== start && ordered.length <= vertices.size);
    if (current !== start || ordered.length !== vertices.size) continue;

    const points = ordered.map((index) => pointAt(mesh, index));
    const centre = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y, z: sum.z + point.z }), { x: 0, y: 0, z: 0 });
    centre.x /= points.length; centre.y /= points.length; centre.z /= points.length;
    let nx = 0, ny = 0, nz = 0;
    for (let index = 0; index < points.length; index++) {
      const a = points[index], b = points[(index + 1) % points.length];
      const ax = a.x - centre.x, ay = a.y - centre.y, az = a.z - centre.z;
      const bx = b.x - centre.x, by = b.y - centre.y, bz = b.z - centre.z;
      nx += ay * bz - az * by;
      ny += az * bx - ax * bz;
      nz += ax * by - ay * bx;
    }
    const normalLength = Math.hypot(nx, ny, nz);
    if (normalLength < 1e-9) continue;
    nx /= normalLength; ny /= normalLength; nz /= normalLength;
    const radii = points.map((point) => Math.hypot(point.x - centre.x, point.y - centre.y, point.z - centre.z));
    const radius = radii.reduce((sum, value) => sum + value, 0) / radii.length;
    if (radius < 1e-8) continue;
    const planarTolerance = Math.max(1e-5, radius * 1e-3);
    const radiusTolerance = Math.max(1e-5, radius * 0.02);
    const planar = points.every((point) => Math.abs((point.x - centre.x) * nx + (point.y - centre.y) * ny + (point.z - centre.z) * nz) <= planarTolerance);
    const round = radii.every((value) => Math.abs(value - radius) <= radiusTolerance);
    if (!planar || !round) continue;
    if (!centres.some((other) => Math.hypot(other.x - centre.x, other.y - centre.y, other.z - centre.z) <= planarTolerance)) centres.push(centre);
  }
  circularCentreCache.set(mesh, centres);
  return centres;
}
