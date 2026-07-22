import type { SolidMesh } from '../entities/types';
import type { Vec3 } from '../../math/geometry';

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
