import type ModuleFactory from 'manifold-3d';
import type { Vec2, Vec3 } from '../../math/geometry';
import { closePolyline, polygonSignedArea } from '../../math/geometry';
import type { Entity, PrimitiveFeature, SolidEdgeSelection, SolidFaceRegion, SolidFeature, SolidMesh } from '../entities/types';
import { curvePoints } from '../entities/types';
import { solidPlanarFaces, type PlanarFace } from './SolidTopology';
import { localToWorld, workPlaneFromXAxis, workPlaneFromXYAxes, WORLD_WORK_PLANE, transformMeshByWorkPlane, transformMeshIndicesByWorkPlane, type WorkPlane } from '../../math/workplane';

type ManifoldModule = Awaited<ReturnType<typeof ModuleFactory>>;

let manifoldReady: Promise<ManifoldModule> | null = null;

export async function initManifold() {
  if (!manifoldReady) {
    manifoldReady = import('manifold-3d')
      .then(({ default: createModule }) => createModule())
      .then((manifold) => {
        manifold.setup();
        return manifold;
      })
      .catch((cause: unknown) => {
        // Caching the rejection would make one bad load permanent: every later
        // attempt would await the same settled promise and fail without ever
        // trying again. Clearing it means the next boolean gets a fresh go.
        manifoldReady = null;
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`the 3D engine (manifold) could not be loaded: ${reason}`, { cause });
      });
  }
  return manifoldReady;
}

function entityToPolygon(entity: Entity): Vec2[] | null {
  switch (entity.type) {
    case 'octagon':
      return closePolyline(entity.vertices);
    case 'rectangle':
      return closePolyline([
        entity.first,
        { x: entity.opposite.x, y: entity.first.y },
        entity.opposite,
        { x: entity.first.x, y: entity.opposite.y },
      ]);
    case 'polyline':
      if (entity.closed && entity.vertices.length >= 3) {
        return closePolyline(entity.vertices);
      }
      return null;
    case 'circle': {
      const segs = 64;
      const verts: Vec2[] = [];
      for (let i = 0; i < segs; i++) {
        const a = (2 * Math.PI * i) / segs;
        verts.push({
          x: entity.center.x + entity.radius * Math.cos(a),
          y: entity.center.y + entity.radius * Math.sin(a),
        });
      }
      return verts;
    }
    default:
      return null;
  }
}

function entityToPath(entity: Entity): { points: Vec2[]; closed: boolean } | null {
  switch (entity.type) {
    case 'line':
      return { points: [entity.start, entity.end], closed: false };
    case 'arc':
      return { points: curvePath(entity.center, entity.radius, entity.startAngle, entity.sweepAngle, 32), closed: false };
    case 'bezier':
      return { points: curvePoints(entity, 32), closed: false };
    case 'polyline':
      return entity.vertices.length >= 2
        ? { points: entity.closed ? closePolyline(entity.vertices).slice(0, -1) : [...entity.vertices], closed: entity.closed }
        : null;
    case 'circle':
      return { points: curvePath(entity.center, entity.radius, 0, Math.PI * 2, 64, true), closed: true };
    default:
      return null;
  }
}

function curvePath(center: Vec2, radius: number, startAngle: number, sweepAngle: number, segments: number, closed = false): Vec2[] {
  const points: Vec2[] = [];
  const limit = closed ? segments : segments + 1;
  for (let i = 0; i < limit; i++) {
    const t = i / segments;
    const a = startAngle + sweepAngle * t;
    points.push({ x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius });
  }
  return points;
}

function ensureCCW(verts: Vec2[]): Vec2[] {
  if (polygonSignedArea(verts) < 0) return [...verts].reverse();
  return verts;
}

function vec2ToManifoldPoly(manifold: ManifoldModule, verts: Vec2[]) {
  const closed = closePolyline(verts);
  const ccw = ensureCCW(closed);
  return ccw.slice(0, -1).map((v): [number, number] => [v.x, v.y]);
}

function profileRing(profile: Vec2[]): Vec2[] {
  const closed = closePolyline(profile);
  return ensureCCW(closed).slice(0, -1);
}

function tangentAt(points: Vec2[], index: number, closed: boolean): Vec2 {
  const prev = closed ? points[(index - 1 + points.length) % points.length] : points[Math.max(0, index - 1)];
  const next = closed ? points[(index + 1) % points.length] : points[Math.min(points.length - 1, index + 1)];
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

export async function sweepProfile(profile: Entity, path: Entity, plane: WorkPlane = WORLD_WORK_PLANE): Promise<SolidMesh | null> {
  const profilePolygon = entityToPolygon(profile);
  const pathInfo = entityToPath(path);
  if (!profilePolygon || !pathInfo || pathInfo.points.length < 2) return null;
  if (profileRing(profilePolygon).length < 3) return null;

  const segmentMeshes: SolidMesh[] = [];
  const segments = pathInfo.closed ? pathInfo.points.length : pathInfo.points.length - 1;

  for (let index = 0; index < segments; index++) {
    const a = pathInfo.points[index];
    const b = pathInfo.points[(index + 1) % pathInfo.points.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;
    const tangent = tangentAt(pathInfo.points, index, pathInfo.closed);
    const normal = { x: -tangent.y, y: tangent.x };
    const origin = localToWorld(plane, a);
    const xPoint = localToWorld(plane, { x: a.x + normal.x, y: a.y + normal.y });
    const yPoint = localToWorld(plane, a, 1);
    const segmentPlane = workPlaneFromXYAxes(origin, xPoint, yPoint);
    const localMesh = await extrudeProfile([profile], length);
    if (!localMesh) return null;
    segmentMeshes.push({
      positions: transformMeshByWorkPlane(localMesh.positions, segmentPlane),
      indices: transformMeshIndicesByWorkPlane(localMesh.indices, segmentPlane),
    });
  }

  if (segmentMeshes.length === 0) return null;
  if (segmentMeshes.length === 1) return segmentMeshes[0];
  return booleanUnion(segmentMeshes);
}

function manifoldToMesh(manifold: ManifoldModule, m: InstanceType<ManifoldModule['Manifold']>): SolidMesh {
  const mesh = m.getMesh();
  return {
    positions: new Float32Array(mesh.vertProperties),
    indices: new Uint32Array(mesh.triVerts),
  };
}

export async function extrudeProfile(entities: Entity[], height: number): Promise<SolidMesh | null> {
  const manifold = await initManifold();
  const polys: InstanceType<typeof manifold.Manifold>[] = [];

  for (const entity of entities) {
    const poly = entityToPolygon(entity);
    if (!poly) continue;
    const mp = vec2ToManifoldPoly(manifold, poly);
    const solid = manifold.Manifold.extrude(mp, height);
    polys.push(solid);
  }

  if (polys.length === 0) return null;

  let result = polys[0];
  for (let i = 1; i < polys.length; i++) {
    const next = result.add(polys[i]);
    result.delete();
    polys[i].delete();
    result = next;
  }
  try {
    return manifoldToMesh(manifold, result);
  } finally {
    result.delete();
  }
}

/**
 * A recognised circular rim is one analytic edge, even though the render mesh
 * stores it as many straight segments.  Revolve the same 2D corner profile
 * used by the straight-edge operation so the cutter follows the complete rim.
 */
async function modifyCircularSolidEdge(
  mesh: SolidMesh,
  edge: SolidEdgeSelection,
  amount: number,
  rounded: boolean,
  amount2: number,
  adjacentNormals: Array<[number, number, number]>,
): Promise<SolidMesh | null> {
  const circular = edge.circular;
  if (!circular || adjacentNormals.length !== 2) return null;
  const normalize = (value: Vec3): Vec3 | null => {
    const length = Math.hypot(value.x, value.y, value.z);
    return length > 1e-9
      ? { x: value.x / length, y: value.y / length, z: value.z / length }
      : null;
  };
  const dot = (first: Vec3, second: Vec3): number =>
    first.x * second.x + first.y * second.y + first.z * second.z;
  const axis = normalize(circular.normal);
  if (!axis) return null;
  const fromCenter = {
    x: edge.start.x - circular.center.x,
    y: edge.start.y - circular.center.y,
    z: edge.start.z - circular.center.z,
  };
  const alongAxis = dot(fromCenter, axis);
  const radial = normalize({
    x: fromCenter.x - axis.x * alongAxis,
    y: fromCenter.y - axis.y * alongAxis,
    z: fromCenter.z - axis.z * alongAxis,
  });
  if (!radial) return null;

  const normals = adjacentNormals.map(([x, y, z]) => ({ x, y, z }));
  const capIndex = Math.abs(dot(normals[0], axis)) >= Math.abs(dot(normals[1], axis)) ? 0 : 1;
  const capNormal = normals[capIndex];
  const sideNormal = normals[1 - capIndex];
  const capAlignment = Math.abs(dot(capNormal, axis));
  const sideRadialSign = Math.sign(dot(sideNormal, radial));
  if (capAlignment < 0.95 || sideRadialSign === 0 || Math.abs(dot(sideNormal, axis)) > 0.2) return null;

  // Use the analytic radial normal instead of a single polygon facet normal.
  // This makes every angular copy of the profile identical and also handles
  // inner circular rims, whose outward side normal points towards the axis.
  const radialNormal = {
    x: radial.x * sideRadialSign,
    y: radial.y * sideRadialSign,
    z: radial.z * sideRadialSign,
  };
  const corner = { ...edge.start };
  const boundary: Vec3[] = [];
  if (!rounded) {
    boundary.push(
      {
        x: corner.x - radialNormal.x * amount,
        y: corner.y - radialNormal.y * amount,
        z: corner.z - radialNormal.z * amount,
      },
      {
        x: corner.x - capNormal.x * amount2,
        y: corner.y - capNormal.y * amount2,
        z: corner.z - capNormal.z * amount2,
      },
    );
  } else {
    const center = {
      x: corner.x - (radialNormal.x + capNormal.x) * amount,
      y: corner.y - (radialNormal.y + capNormal.y) * amount,
      z: corner.z - (radialNormal.z + capNormal.z) * amount,
    };
    const arcSegments = 12;
    for (let index = 0; index <= arcSegments; index++) {
      const angle = index / arcSegments * Math.PI / 2;
      const capWeight = Math.cos(angle);
      const radialWeight = Math.sin(angle);
      boundary.push({
        x: center.x + (capNormal.x * capWeight + radialNormal.x * radialWeight) * amount,
        y: center.y + (capNormal.y * capWeight + radialNormal.y * radialWeight) * amount,
        z: center.z + (capNormal.z * capWeight + radialNormal.z * radialWeight) * amount,
      });
    }
  }

  // Do not let the cutter merely touch the cap and side at the original rim.
  // Coincident polygons can leave a few radius-R seam vertices behind. Extend
  // only the outside of the tool; the chamfer line / fillet arc stays exact.
  const extension = Math.max(1e-5, meshExtent(mesh) * 1e-5, Math.max(amount, amount2) * 1e-4);
  const firstBoundary = boundary[0];
  const lastBoundary = boundary.at(-1)!;
  const section: Vec3[] = [
    ...boundary,
    {
      x: lastBoundary.x + radialNormal.x * extension,
      y: lastBoundary.y + radialNormal.y * extension,
      z: lastBoundary.z + radialNormal.z * extension,
    },
    {
      x: corner.x + (radialNormal.x + capNormal.x) * extension,
      y: corner.y + (radialNormal.y + capNormal.y) * extension,
      z: corner.z + (radialNormal.z + capNormal.z) * extension,
    },
    {
      x: firstBoundary.x + capNormal.x * extension,
      y: firstBoundary.y + capNormal.y * extension,
      z: firstBoundary.z + capNormal.z * extension,
    },
  ];
  const profile = section.map((point): Vec2 => {
    const offset = {
      x: point.x - circular.center.x,
      y: point.y - circular.center.y,
      z: point.z - circular.center.z,
    };
    return {
      x: dot(offset, radial),
      y: dot(offset, axis),
    };
  });
  const tolerance = Math.max(1e-6, meshExtent(mesh) * 1e-6);
  if (profile.some((point) => point.x <= tolerance)) return null;
  const polygon = ensureCCW(profile).map((point): [number, number] => [point.x, point.y]);

  const manifold = await initManifold();
  const crossSection = new manifold.CrossSection([polygon]);
  let localTool: InstanceType<typeof manifold.Manifold>;
  try {
    localTool = crossSection.revolve(Math.max(16, circular.segments ?? 64));
  } finally {
    crossSection.delete();
  }
  try {
    const toolPlane = workPlaneFromXAxis(circular.center, edge.start, axis);
    const localMesh = manifoldToMesh(manifold, localTool);
    const cutter = outwardWoundMesh({
      positions: transformMeshByWorkPlane(localMesh.positions, toolPlane),
      indices: transformMeshIndicesByWorkPlane(localMesh.indices, toolPlane),
    });
    const result = await booleanSubtract(outwardWoundMesh(mesh), cutter);
    if (!result || result.positions.length === 0 || result.indices.length === 0) return null;
    return result;
  } finally {
    localTool.delete();
  }
}

export async function modifySolidEdge(
  mesh: SolidMesh,
  edge: SolidEdgeSelection,
  amount: number,
  rounded: boolean,
  amount2 = amount,
): Promise<SolidMesh | null> {
  if (amount <= 0 || amount2 <= 0) return null;
  const normalize = (v: [number, number, number]): [number, number, number] => {
    const length = Math.hypot(...v);
    return [v[0] / length, v[1] / length, v[2] / length];
  };
  const meshOrientation = signedMeshVolume(mesh) < 0 ? -1 : 1;
  const edgeTolerance = Math.max(1e-6, meshExtent(mesh) * 1e-6);
  const pointAt = (index: number): Vec3 => ({
    x: mesh.positions[index * 3],
    y: mesh.positions[index * 3 + 1],
    z: mesh.positions[index * 3 + 2],
  });
  const pointDistance = (first: Vec3, second: Vec3): number => Math.hypot(
    first.x - second.x,
    first.y - second.y,
    first.z - second.z,
  );
  type TopologyEdge = {
    a: number;
    b: number;
    normals: Array<[number, number, number]>;
  };
  const topologyEdges = new Map<string, TopologyEdge>();
  for (let offset = 0; offset + 2 < mesh.indices.length; offset += 3) {
    const ids = [mesh.indices[offset], mesh.indices[offset + 1], mesh.indices[offset + 2]];
    const point = (index: number): [number, number, number] => [
      mesh.positions[index * 3],
      mesh.positions[index * 3 + 1],
      mesh.positions[index * 3 + 2],
    ];
    const first = point(ids[0]), second = point(ids[1]), third = point(ids[2]);
    const u: [number, number, number] = [second[0] - first[0], second[1] - first[1], second[2] - first[2]];
    const v: [number, number, number] = [third[0] - first[0], third[1] - first[1], third[2] - first[2]];
    const normal = normalize([
      (u[1] * v[2] - u[2] * v[1]) * meshOrientation,
      (u[2] * v[0] - u[0] * v[2]) * meshOrientation,
      (u[0] * v[1] - u[1] * v[0]) * meshOrientation,
    ]);
    for (let edgeIndex = 0; edgeIndex < 3; edgeIndex++) {
      const firstIndex = ids[edgeIndex], secondIndex = ids[(edgeIndex + 1) % 3];
      const a = Math.min(firstIndex, secondIndex), b = Math.max(firstIndex, secondIndex);
      const key = `${a}:${b}`;
      const topologyEdge = topologyEdges.get(key) ?? { a, b, normals: [] };
      topologyEdge.normals.push(normal);
      topologyEdges.set(key, topologyEdge);
    }
  }

  const pickedTopologyEdge = Array.from(topologyEdges.values()).find((candidate) => {
    const first = pointAt(candidate.a), second = pointAt(candidate.b);
    return (
      pointDistance(first, edge.start) <= edgeTolerance
      && pointDistance(second, edge.end) <= edgeTolerance
    ) || (
      pointDistance(first, edge.end) <= edgeTolerance
      && pointDistance(second, edge.start) <= edgeTolerance
    );
  });
  const adjacentNormals = pickedTopologyEdge?.normals ?? [];
  if (edge.circular) {
    return modifyCircularSolidEdge(mesh, edge, amount, rounded, amount2, adjacentNormals);
  }

  // Manifold may insert a vertex where a triangulation diagonal meets a design
  // edge. The picker then returns just one of those collinear segments. Extend
  // it through every connected segment between the same pair of support faces,
  // otherwise FILLET ends early with a round cap and a triangular remnant.
  let expandedStart = { ...edge.start };
  let expandedEnd = { ...edge.end };
  const pickedVector: [number, number, number] = [
    edge.end.x - edge.start.x,
    edge.end.y - edge.start.y,
    edge.end.z - edge.start.z,
  ];
  const pickedLength = Math.hypot(...pickedVector);
  if (pickedTopologyEdge && pickedTopologyEdge.normals.length === 2 && pickedLength > 1e-8) {
    const pickedAlong = normalize(pickedVector);
    // A short last segment magnifies Float32 endpoint noise when its direction
    // is extrapolated over the full edge, so allow several mesh tolerances here.
    const chainTolerance = Math.max(edgeTolerance * 64, pickedLength * 1e-5);
    const normalAgreement = (
      first: [number, number, number],
      second: [number, number, number],
    ): number => Math.abs(first[0] * second[0] + first[1] * second[1] + first[2] * second[2]);
    const hasSameSupportFaces = (candidate: TopologyEdge): boolean => {
      if (candidate.normals.length !== 2) return false;
      const direct = normalAgreement(candidate.normals[0], adjacentNormals[0])
        + normalAgreement(candidate.normals[1], adjacentNormals[1]);
      const swapped = normalAgreement(candidate.normals[0], adjacentNormals[1])
        + normalAgreement(candidate.normals[1], adjacentNormals[0]);
      return Math.max(direct, swapped) > 1.998;
    };
    const distanceFromPickedLine = (point: Vec3): number => {
      const dx = point.x - edge.start.x;
      const dy = point.y - edge.start.y;
      const dz = point.z - edge.start.z;
      return Math.hypot(
        dy * pickedAlong[2] - dz * pickedAlong[1],
        dz * pickedAlong[0] - dx * pickedAlong[2],
        dx * pickedAlong[1] - dy * pickedAlong[0],
      );
    };
    const candidates = Array.from(topologyEdges.values()).filter((candidate) => {
      if (!hasSameSupportFaces(candidate)) return false;
      const first = pointAt(candidate.a), second = pointAt(candidate.b);
      const dx = second.x - first.x, dy = second.y - first.y, dz = second.z - first.z;
      const length = Math.hypot(dx, dy, dz);
      if (length <= edgeTolerance) return false;
      const parallel = Math.abs(
        (dx * pickedAlong[0] + dy * pickedAlong[1] + dz * pickedAlong[2]) / length,
      );
      return parallel > 0.99999
        && distanceFromPickedLine(first) <= chainTolerance
        && distanceFromPickedLine(second) <= chainTolerance;
    });
    const connected: TopologyEdge[] = [pickedTopologyEdge];
    const remaining = candidates.filter((candidate) => candidate !== pickedTopologyEdge);
    const sharesEndpoint = (candidate: TopologyEdge): boolean => {
      const endpoints = [pointAt(candidate.a), pointAt(candidate.b)];
      return connected.some((member) => {
        const memberEndpoints = [pointAt(member.a), pointAt(member.b)];
        return endpoints.some((point) =>
          memberEndpoints.some((memberPoint) => pointDistance(point, memberPoint) <= chainTolerance)
        );
      });
    };
    let added = true;
    while (added) {
      added = false;
      for (let index = remaining.length - 1; index >= 0; index--) {
        if (!sharesEndpoint(remaining[index])) continue;
        connected.push(remaining[index]);
        remaining.splice(index, 1);
        added = true;
      }
    }

    let minProjection = 0, maxProjection = pickedLength;
    for (const candidate of connected) {
      for (const point of [pointAt(candidate.a), pointAt(candidate.b)]) {
        const projection = (
          (point.x - edge.start.x) * pickedAlong[0]
          + (point.y - edge.start.y) * pickedAlong[1]
          + (point.z - edge.start.z) * pickedAlong[2]
        );
        if (projection < minProjection) {
          minProjection = projection;
          expandedStart = point;
        }
        if (projection > maxProjection) {
          maxProjection = projection;
          expandedEnd = point;
        }
      }
    }
  }
  const p: [number, number, number] = [expandedStart.x, expandedStart.y, expandedStart.z];
  // Use the actual triangles touching this exact edge. Looking at the body's
  // global min/max worked for a plain box, but a face of a union can sit between
  // larger parts and is not a global supporting plane — which sent the cutter
  // through the model in the real UI even though synthetic box tests passed.
  const outwardNormal = (input: [number, number, number]): [number, number, number] => {
    let normal = normalize(input);
    const matching = adjacentNormals
      .map((candidate) => ({
        candidate,
        agreement: Math.abs(candidate[0] * normal[0] + candidate[1] * normal[1] + candidate[2] * normal[2]),
      }))
      .sort((first, second) => second.agreement - first.agreement)[0];
    if (matching && matching.agreement > 0.8) return matching.candidate;

    // Compatibility fallback for an old stored feature whose selected mesh was
    // subsequently regenerated with different vertex indexing.
    let min = Infinity, max = -Infinity;
    for (let index = 0; index < mesh.positions.length; index += 3) {
      const projection = normal[0] * mesh.positions[index]
        + normal[1] * mesh.positions[index + 1]
        + normal[2] * mesh.positions[index + 2];
      min = Math.min(min, projection);
      max = Math.max(max, projection);
    }
    const atEdge = normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2];
    if (Math.abs(atEdge - min) < Math.abs(atEdge - max)) normal = [-normal[0], -normal[1], -normal[2]];
    return normal;
  };
  const a = outwardNormal([edge.normalA.x, edge.normalA.y, edge.normalA.z]);
  const b = outwardNormal([edge.normalB.x, edge.normalB.y, edge.normalB.z]);
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const angle = Math.acos(dot);
  if (angle < 1e-4 || angle > Math.PI - 1e-4) return null;
  const bisector = normalize([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
  const edgeVector: [number, number, number] = [
    expandedEnd.x - expandedStart.x,
    expandedEnd.y - expandedStart.y,
    expandedEnd.z - expandedStart.z,
  ];
  const edgeLength = Math.hypot(...edgeVector);
  if (edgeLength < 1e-8) return null;
  const along: [number, number, number] = [
    edgeVector[0] / edgeLength,
    edgeVector[1] / edgeLength,
    edgeVector[2] / edgeLength,
  ];
  const section: Array<[number, number, number]> = [p];
  let filletCenter: [number, number, number] | null = null;
  if (!rounded) {
    const projectionLength = Math.sin(angle);
    if (projectionLength < 1e-8) return null;
    // `amount` runs along face A away from face B; `amount2` does the mirror
    // image on face B. Their two endpoints plus the selected edge define the
    // asymmetric chamfer plane exactly.
    const directionA: [number, number, number] = [
      (a[0] * dot - b[0]) / projectionLength,
      (a[1] * dot - b[1]) / projectionLength,
      (a[2] * dot - b[2]) / projectionLength,
    ];
    const directionB: [number, number, number] = [
      (b[0] * dot - a[0]) / projectionLength,
      (b[1] * dot - a[1]) / projectionLength,
      (b[2] * dot - a[2]) / projectionLength,
    ];
    const onA: [number, number, number] = [
      p[0] + directionA[0] * amount,
      p[1] + directionA[1] * amount,
      p[2] + directionA[2] * amount,
    ];
    const onB: [number, number, number] = [
      p[0] + directionB[0] * amount2,
      p[1] + directionB[1] * amount2,
      p[2] + directionB[2] * amount2,
    ];
    section.push(onA, onB);
  } else {
    // The centre is `radius` behind both support planes. Its projection onto
    // either outward normal is distance * cos(angle / 2); using sin happens to
    // work at 90°, but sends a fillet on a 45° chamfer deep through the body.
    const centerDistance = amount / Math.cos(angle / 2);
    const center: [number, number, number] = [
      p[0] - bisector[0] * centerDistance,
      p[1] - bisector[1] * centerDistance,
      p[2] - bisector[2] * centerDistance,
    ];
    filletCenter = center;
    const segments = 12;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const sinAngle = Math.sin(angle);
      const wa = Math.sin((1 - t) * angle) / sinAngle;
      const wb = Math.sin(t * angle) / sinAngle;
      const normal = normalize([a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb]);
      section.push([
        center[0] + normal[0] * amount,
        center[1] + normal[1] * amount,
        center[2] + normal[2] * amount,
      ]);
    }
  }

  // Orient the cutter section counter-clockwise when viewed along the edge.
  // The prism then has ordinary outward winding and can be subtracted as one
  // local tool instead of trimming the whole model with infinite planes.
  const firstLeg = {
    x: section[1][0] - p[0], y: section[1][1] - p[1], z: section[1][2] - p[2],
  };
  const lastLeg = {
    x: section.at(-1)![0] - p[0], y: section.at(-1)![1] - p[1], z: section.at(-1)![2] - p[2],
  };
  const orientation = (
    (firstLeg.y * lastLeg.z - firstLeg.z * lastLeg.y) * along[0]
    + (firstLeg.z * lastLeg.x - firstLeg.x * lastLeg.z) * along[1]
    + (firstLeg.x * lastLeg.y - firstLeg.y * lastLeg.x) * along[2]
  );
  if (orientation < 0) {
    // Keep the selected corner as the fan anchor. A fillet section is concave
    // (corner plus an inward arc); reversing the whole array moved that anchor
    // onto the arc and made the end caps overlap themselves. Manifold could
    // then preserve a long triangular remnant after the subtraction.
    section.splice(1, section.length - 1, ...section.slice(1).reverse());
  }

  if (rounded && filletCenter && isConvexSolidMesh(mesh)) {
    const manifold = await initManifold();
    const source = outwardWoundMesh(mesh);
    const sourceMesh = new manifold.Mesh({
      numProp: 3,
      vertProperties: source.positions,
      triVerts: source.indices,
    });
    let solid = new manifold.Manifold(sourceMesh);
    try {
      const segments = 12;
      const sinAngle = Math.sin(angle);
      for (let index = 0; index < segments; index++) {
        const t = (index + 0.5) / segments;
        const wa = Math.sin((1 - t) * angle) / sinAngle;
        const wb = Math.sin(t * angle) / sinAngle;
        const normal = normalize([
          a[0] * wa + b[0] * wb,
          a[1] * wa + b[1] * wb,
          a[2] * wa + b[2] * wb,
        ]);
        const tangentPoint: [number, number, number] = [
          filletCenter[0] + normal[0] * amount,
          filletCenter[1] + normal[1] * amount,
          filletCenter[2] + normal[2] * amount,
        ];
        const offset = normal[0] * tangentPoint[0]
          + normal[1] * tangentPoint[1]
          + normal[2] * tangentPoint[2];
        const next = solid.trimByPlane(
          [-normal[0], -normal[1], -normal[2]],
          -offset,
        );
        solid.delete();
        solid = next;
      }
      if (solid.isEmpty()) return null;
      return manifoldToMesh(manifold, solid);
    } finally {
      solid.delete();
    }
  }

  const sectionExtent = Math.max(...section.map((point) => Math.hypot(
    point[0] - p[0],
    point[1] - p[1],
    point[2] - p[2],
  )));
  // Extending only by a numeric epsilon leaves part of an oblique section
  // inside the body at the edge vertex. Its end cap then becomes the visible
  // triangular groove. Move the complete profile past both vertices.
  const extension = Math.max(1e-5, meshExtent(mesh) * 1e-5, sectionExtent * 2.1);
  const sectionX = normalize([
    section[1][0] - p[0],
    section[1][1] - p[1],
    section[1][2] - p[2],
  ]);
  const sectionY: [number, number, number] = [
    along[1] * sectionX[2] - along[2] * sectionX[1],
    along[2] * sectionX[0] - along[0] * sectionX[2],
    along[0] * sectionX[1] - along[1] * sectionX[0],
  ];
  const polygon = section.map((point): [number, number] => {
    const delta: [number, number, number] = [
      point[0] - p[0],
      point[1] - p[1],
      point[2] - p[2],
    ];
    return [
      delta[0] * sectionX[0] + delta[1] * sectionX[1] + delta[2] * sectionX[2],
      delta[0] * sectionY[0] + delta[1] * sectionY[1] + delta[2] * sectionY[2],
    ];
  });
  const toolOrigin = {
    x: p[0] - along[0] * extension,
    y: p[1] - along[1] * extension,
    z: p[2] - along[2] * extension,
  };
  const toolPlane = workPlaneFromXYAxes(
    toolOrigin,
    {
      x: toolOrigin.x + sectionX[0],
      y: toolOrigin.y + sectionX[1],
      z: toolOrigin.z + sectionX[2],
    },
    {
      x: toolOrigin.x + sectionY[0],
      y: toolOrigin.y + sectionY[1],
      z: toolOrigin.z + sectionY[2],
    },
  );
  const manifold = await initManifold();
  const crossSection = new manifold.CrossSection([polygon]);
  const localTool = crossSection.extrude(edgeLength + extension * 2);
  crossSection.delete();
  try {
    const localMesh = manifoldToMesh(manifold, localTool);
    const cutter = outwardWoundMesh({
      positions: transformMeshByWorkPlane(localMesh.positions, toolPlane),
      indices: transformMeshIndicesByWorkPlane(localMesh.indices, toolPlane),
    });
    const result = await booleanSubtract(outwardWoundMesh(mesh), cutter);
    if (!result || result.positions.length === 0 || result.indices.length === 0) return null;
    return result;
  } finally {
    localTool.delete();
  }
}

/**
 * A primitive, built and placed. Needs no WASM, so it stays synchronous and can
 * be called from anywhere — which matters, because the properties panel had
 * copied this whole switch rather than await a promise, and the copy had
 * already drifted: it never learned about scale, so editing the radius of an
 * ellipsoid quietly collapsed it back into a ball.
 */
export function primitiveMesh(feature: PrimitiveFeature): SolidMesh {
  const local = feature.primitive === 'box' ? createBoxMesh(feature.width ?? 1, feature.depth ?? 1, feature.height, feature.center.x, feature.center.y)
    : feature.primitive === 'wedge' ? createWedgeMesh(feature.width ?? 1, feature.depth ?? 1, feature.height, feature.center.x, feature.center.y)
    : feature.primitive === 'sphere' ? createSphereMesh(feature.radius ?? 1, feature.center.x, feature.center.y)
    : feature.primitive === 'cone' ? createConeMesh(feature.radius ?? 1, feature.height, feature.center.x, feature.center.y, 64, feature.radiusTop ?? 0)
    : feature.primitive === 'pyramid' ? createPyramidMesh(feature.radius ?? 1, feature.height, feature.center.x, feature.center.y)
    : feature.primitive === 'torus' ? createTorusMesh(feature.radius ?? 1, feature.tubeRadius ?? 0.25, feature.center.x, feature.center.y)
    : createCylinderMesh(feature.radius ?? 1, feature.height, feature.center.x, feature.center.y, 64);
  const scaled = feature.scale ? scaleMesh(local, feature.scale) : local;
  if (!feature.workPlane) return scaled;
  return {
    positions: transformMeshByWorkPlane(scaled.positions, feature.workPlane),
    indices: transformMeshIndicesByWorkPlane(scaled.indices, feature.workPlane),
  };
}

export async function regenerateSolidFeature(feature: SolidFeature): Promise<SolidMesh | null> {
  if (feature.kind === 'mesh') return null;
  if (feature.kind === 'primitive') return primitiveMesh(feature);
  if (feature.kind === 'extrusion') {
    const polygon = entityToPolygon(feature.profile);
    if (!polygon) return null;
    const transformed = polygon.map((point) => ({
      x: point.x * feature.transform.scaleX + feature.transform.translateX,
      y: point.y * feature.transform.scaleY + feature.transform.translateY,
    }));
    const manifold = await initManifold();
    const crossSection = vec2ToManifoldPoly(manifold, transformed);
    const solid = manifold.Manifold.extrude(crossSection, feature.height);
    try {
      const mesh = manifoldToMesh(manifold, solid);
      const translateZ = feature.transform.translateZ ?? 0;
      if (translateZ !== 0) {
        for (let i = 2; i < mesh.positions.length; i += 3) mesh.positions[i] += translateZ;
      }
      if (feature.workPlane) {
        mesh.positions = transformMeshByWorkPlane(mesh.positions, feature.workPlane);
        mesh.indices = transformMeshIndicesByWorkPlane(mesh.indices, feature.workPlane);
      }
      return mesh;
    } finally {
      solid.delete();
    }
  }
  if (feature.kind === 'sweep') {
    return sweepProfile(feature.profile, feature.path, feature.workPlane ?? WORLD_WORK_PLANE);
  }
  if (feature.kind === 'edge-modification') {
    // Most sources can be rebuilt from their recipe. A legacy/baked mesh has no
    // recipe, so the feature keeps exactly the geometry it received instead.
    const regenerated = await regenerateSolidFeature(feature.source);
    const source = regenerated ?? {
      positions: new Float32Array(feature.sourceMesh.positions),
      indices: new Uint32Array(feature.sourceMesh.indices),
    };
    return modifySolidEdge(
      source,
      feature.edge,
      feature.amount,
      feature.operation === 'fillet',
      feature.amount2 ?? feature.amount,
    );
  }
  if (feature.kind === 'presspull-region') {
    const regenerated = await regenerateSolidFeature(feature.source);
    const source = regenerated ?? {
      positions: new Float32Array(feature.sourceMesh.positions),
      indices: new Uint32Array(feature.sourceMesh.indices),
    };
    return pressPullRegion(source, feature.region, feature.distance);
  }

  const operands: SolidMesh[] = [];
  for (const operand of feature.operands) {
    const mesh = await regenerateSolidFeature(operand);
    if (!mesh) return null;
    operands.push(mesh);
  }
  if (feature.operation === 'union') return booleanUnion(operands);
  if (operands.length !== 2) return null;
  return booleanSubtract(operands[0], operands[1]);
}

export async function booleanUnion(solids: SolidMesh[]): Promise<SolidMesh | null> {
  if (solids.length === 0) return null;
  const manifold = await initManifold();

  const toManifold = (mesh: SolidMesh) => {
    const m = new manifold.Mesh({
      numProp: 3,
      vertProperties: mesh.positions,
      triVerts: mesh.indices,
    });
    return new manifold.Manifold(m);
  };

  let result = toManifold(solids[0]);
  for (let i = 1; i < solids.length; i++) {
    const operand = toManifold(solids[i]);
    const next = result.add(operand);
    result.delete();
    operand.delete();
    result = next;
  }
  try {
    return manifoldToMesh(manifold, result);
  } finally {
    result.delete();
  }
}

export async function booleanSubtract(base: SolidMesh, tool: SolidMesh): Promise<SolidMesh | null> {
  const manifold = await initManifold();

  const toManifold = (mesh: SolidMesh) => {
    const m = new manifold.Mesh({
      numProp: 3,
      vertProperties: mesh.positions,
      triVerts: mesh.indices,
    });
    return new manifold.Manifold(m);
  };

  const baseManifold = toManifold(base);
  const toolManifold = toManifold(tool);
  const result = baseManifold.subtract(toolManifold);
  try {
    return manifoldToMesh(manifold, result);
  } finally {
    result.delete();
    baseManifold.delete();
    toolManifold.delete();
  }
}

interface PlaneConstraint {
  face: PlanarFace;
  normal: Vec3;
  offset: number;
}

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

function sameVertexSet(first: readonly number[], second: readonly number[]): boolean {
  if (first.length !== second.length) return false;
  const expected = new Set(first);
  return second.every((index) => expected.has(index));
}

function planeIntersection(a: PlaneConstraint, b: PlaneConstraint, c: PlaneConstraint): Vec3 | null {
  const bc = cross(b.normal, c.normal);
  const ca = cross(c.normal, a.normal);
  const ab = cross(a.normal, b.normal);
  const determinant = dot(a.normal, bc);
  if (Math.abs(determinant) < 1e-9) return null;
  return {
    x: (a.offset * bc.x + b.offset * ca.x + c.offset * ab.x) / determinant,
    y: (a.offset * bc.y + b.offset * ca.y + c.offset * ab.y) / determinant,
    z: (a.offset * bc.z + b.offset * ca.z + c.offset * ab.z) / determinant,
  };
}

/**
 * Removes one plane from the half-space description of a convex body and heals
 * the gap where the remaining planes meet. This is the exact operation needed
 * to erase a baked chamfer: the two original side planes extend back to their
 * sharp intersection. A box top has no such intersection and is rejected
 * instead of being turned into an open or arbitrarily capped mesh.
 */
export async function deletePlanarSolidFace(
  mesh: SolidMesh,
  selectedVertexIndices: readonly number[],
): Promise<SolidMesh | null> {
  const faces = solidPlanarFaces(mesh);
  const removed = faces.find((face) => sameVertexSet(face.vertexIndices, selectedVertexIndices));
  if (!removed || removed.loops.length !== 1) return null;

  // Triple-plane intersection is cubic in the number of faces. This operation
  // is for planar mechanical bodies, not for treating every tessellated patch
  // of a sphere as a design face.
  if (faces.length < 5 || faces.length > 64) return null;
  const extent = meshExtent(mesh);
  const tolerance = Math.max(1e-6, extent * 1e-6);
  const removedOffset = dot(removed.normal, removed.plane.origin);
  const liesOnRemovedPlane = (face: PlanarFace): boolean =>
    dot(face.normal, removed.normal) > 1 - 1e-6
    && Math.abs(dot(removed.normal, face.plane.origin) - removedOffset) <= tolerance * 4;
  // Boolean engines often return one vertex set per triangle. Coplanar pieces
  // are nevertheless one design face, so selecting either half removes their
  // shared support plane rather than leaving an invisible duplicate constraint.
  const allConstraints: PlaneConstraint[] = faces.map((face) => ({
    face,
    normal: face.normal,
    offset: dot(face.normal, face.plane.origin),
  }));
  const constraints = allConstraints.filter((constraint) => !liesOnRemovedPlane(constraint.face));

  // A half-space reconstruction is valid only for a convex source. Concave
  // bodies and bodies with holes need local surface continuation, not a global
  // convex hull that would silently fill their missing material.
  for (let index = 0; index < mesh.positions.length; index += 3) {
    const point = {
      x: mesh.positions[index],
      y: mesh.positions[index + 1],
      z: mesh.positions[index + 2],
    };
    if (allConstraints.some((plane) => dot(plane.normal, point) - plane.offset > tolerance)) return null;
  }

  const points: Vec3[] = [];
  const addPoint = (point: Vec3): void => {
    if (![point.x, point.y, point.z].every(Number.isFinite)) return;
    if (constraints.some((plane) => dot(plane.normal, point) - plane.offset > tolerance * 4)) return;
    if (points.some((candidate) => Math.hypot(
      candidate.x - point.x,
      candidate.y - point.y,
      candidate.z - point.z,
    ) <= tolerance * 4)) return;
    points.push(point);
  };

  // Keeping the old vertices guarantees the healed body never cuts away any
  // source material. New triple intersections are the extended corners that
  // actually make the selected face disappear.
  for (let index = 0; index < mesh.positions.length; index += 3) {
    addPoint({
      x: mesh.positions[index],
      y: mesh.positions[index + 1],
      z: mesh.positions[index + 2],
    });
  }
  for (let first = 0; first < constraints.length - 2; first++) {
    for (let second = first + 1; second < constraints.length - 1; second++) {
      for (let third = second + 1; third < constraints.length; third++) {
        const point = planeIntersection(constraints[first], constraints[second], constraints[third]);
        if (point) addPoint(point);
      }
    }
  }

  if (!points.some((point) => dot(removed.normal, point) - removedOffset > tolerance * 4)) return null;
  if (points.length < 4) return null;

  const manifold = await initManifold();
  let healed: InstanceType<typeof manifold.Manifold> | null = null;
  try {
    healed = manifold.Manifold.hull(points.map((point): [number, number, number] => [point.x, point.y, point.z]));
    const result = manifoldToMesh(manifold, healed);
    if (result.indices.length < 12) return null;
    // If any part of the chosen support plane remains a hull face, this was not
    // a complete heal. Returning null is safer than claiming partial deletion.
    const stillPresent = solidPlanarFaces(result).some((face) => {
      const parallel = dot(face.normal, removed.normal) > 1 - 1e-6;
      return parallel && Math.abs(dot(removed.normal, face.plane.origin) - removedOffset) <= tolerance * 4;
    });
    return stillPresent ? null : result;
  } catch {
    return null;
  } finally {
    healed?.delete();
  }
}

/**
 * Cuts one watertight mesh into the two capped meshes on either side of a
 * world-space plane. A plane outside or merely tangent to the body is not a
 * split: returning null lets the command leave that source solid untouched.
 */
export async function splitSolidByPlane(
  mesh: SolidMesh,
  origin: Vec3,
  normal: Vec3,
): Promise<[SolidMesh, SolidMesh] | null> {
  const length = Math.hypot(normal.x, normal.y, normal.z);
  if (!Number.isFinite(length) || length < 1e-9) return null;
  const unit: [number, number, number] = [normal.x / length, normal.y / length, normal.z / length];
  const offset = unit[0] * origin.x + unit[1] * origin.y + unit[2] * origin.z;
  if (!Number.isFinite(offset)) return null;

  const manifold = await initManifold();
  const sourceMesh = new manifold.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices });
  const source = new manifold.Manifold(sourceMesh);
  let parts: InstanceType<typeof manifold.Manifold>[] = [];
  try {
    parts = source.splitByPlane(unit, offset);
    const nonEmpty = parts.filter((part) => !part.isEmpty());
    if (nonEmpty.length !== 2) return null;
    return [manifoldToMesh(manifold, nonEmpty[0]), manifoldToMesh(manifold, nonEmpty[1])];
  } finally {
    for (const part of parts) part.delete();
    source.delete();
  }
}

export async function pressPullSolid(mesh: SolidMesh, delta: number): Promise<SolidMesh | null> {
  // Approximate press/pull by scaling Z extent
  const positions = mesh.positions.slice();
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 2; i < positions.length; i += 3) {
    minZ = Math.min(minZ, positions[i]);
    maxZ = Math.max(maxZ, positions[i]);
  }
  const height = maxZ - minZ;
  if (!Number.isFinite(height) || height < 1e-12) return null;
  const newHeight = Math.max(0.01, height + delta);
  const scale = newHeight / height;

  for (let i = 2; i < positions.length; i += 3) {
    positions[i] = minZ + (positions[i] - minZ) * scale;
  }

  return { positions, indices: mesh.indices.slice() };
}

export function pressPullFace(
  mesh: SolidMesh,
  vertexIndices: readonly number[],
  normal: { x: number; y: number; z: number },
  delta: number,
): SolidMesh | null {
  if (vertexIndices.length === 0 || !Number.isFinite(delta)) return null;
  const positions = mesh.positions.slice();
  for (const vertexIndex of new Set(vertexIndices)) {
    const offset = vertexIndex * 3;
    if (offset < 0 || offset + 2 >= positions.length) continue;
    positions[offset] += normal.x * delta;
    positions[offset + 1] += normal.y * delta;
    positions[offset + 2] += normal.z * delta;
  }
  return { positions, indices: mesh.indices.slice() };
}

/**
 * Pulls one bounded planar region as a real watertight solid operation. Positive
 * distance unions an outward prism; negative distance subtracts an inward one.
 * The tiny overlap avoids asking a boolean to decide whether two exactly
 * coincident caps touch or belong to the same shell.
 */
export async function pressPullRegion(
  mesh: SolidMesh,
  region: SolidFaceRegion,
  distance: number,
): Promise<SolidMesh | null> {
  if (!Number.isFinite(distance) || Math.abs(distance) < 1e-9 || region.loops.length === 0) return null;
  const contours = region.loops
    .filter((loop) => loop.length >= 3)
    .map((loop) => loop.map((point): [number, number] => [point.x, point.y]));
  if (contours.length === 0) return null;

  const manifold = await initManifold();
  const crossSection = new manifold.CrossSection(contours);
  const extent = meshExtent(mesh);
  const overlap = Math.max(1e-6, extent * 1e-6);
  const height = Math.abs(distance) + overlap;
  const prism = crossSection.extrude(height);
  crossSection.delete();
  try {
    const local = manifoldToMesh(manifold, prism);
    const localOffset = distance > 0 ? -overlap : distance;
    for (let index = 2; index < local.positions.length; index += 3) local.positions[index] += localOffset;
    const tool = {
      positions: transformMeshByWorkPlane(local.positions, region.plane),
      indices: transformMeshIndicesByWorkPlane(local.indices, region.plane),
    };
    // Legacy primitives use the opposite winding from meshes emitted by
    // manifold. Mixing both conventions makes an additive boolean interpret
    // the source as its complement, while subtraction happens to look mostly
    // correct. Normalise both operands at this boundary so PRESSPULL behaves
    // the same for old primitives and newly generated solids.
    const source = outwardWoundMesh(mesh);
    const operand = outwardWoundMesh(tool);
    return distance > 0 ? booleanUnion([source, operand]) : booleanSubtract(source, operand);
  } finally {
    prism.delete();
  }
}

function meshExtent(mesh: SolidMesh): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < mesh.positions.length; index += 3) {
    minX = Math.min(minX, mesh.positions[index]); maxX = Math.max(maxX, mesh.positions[index]);
    minY = Math.min(minY, mesh.positions[index + 1]); maxY = Math.max(maxY, mesh.positions[index + 1]);
    minZ = Math.min(minZ, mesh.positions[index + 2]); maxZ = Math.max(maxZ, mesh.positions[index + 2]);
  }
  return Math.max(1, maxX - minX, maxY - minY, maxZ - minZ);
}

function isConvexSolidMesh(mesh: SolidMesh): boolean {
  const tolerance = Math.max(1e-6, meshExtent(mesh) * 1e-5);
  for (const face of solidPlanarFaces(mesh)) {
    const offset = face.normal.x * face.plane.origin.x
      + face.normal.y * face.plane.origin.y
      + face.normal.z * face.plane.origin.z;
    for (let index = 0; index < mesh.positions.length; index += 3) {
      const distance = face.normal.x * mesh.positions[index]
        + face.normal.y * mesh.positions[index + 1]
        + face.normal.z * mesh.positions[index + 2]
        - offset;
      if (distance > tolerance) return false;
    }
  }
  return true;
}

function signedMeshVolume(mesh: SolidMesh): number {
  let signedVolume = 0;
  for (let offset = 0; offset + 2 < mesh.indices.length; offset += 3) {
    const ai = mesh.indices[offset] * 3;
    const bi = mesh.indices[offset + 1] * 3;
    const ci = mesh.indices[offset + 2] * 3;
    const ax = mesh.positions[ai], ay = mesh.positions[ai + 1], az = mesh.positions[ai + 2];
    const bx = mesh.positions[bi], by = mesh.positions[bi + 1], bz = mesh.positions[bi + 2];
    const cx = mesh.positions[ci], cy = mesh.positions[ci + 1], cz = mesh.positions[ci + 2];
    signedVolume += (
      ax * (by * cz - bz * cy)
      + ay * (bz * cx - bx * cz)
      + az * (bx * cy - by * cx)
    ) / 6;
  }
  return signedVolume;
}

function outwardWoundMesh(mesh: SolidMesh): SolidMesh {
  const signedVolume = signedMeshVolume(mesh);
  if (signedVolume >= 0) return mesh;
  const indices = mesh.indices.slice();
  for (let offset = 0; offset + 2 < indices.length; offset += 3) {
    const second = indices[offset + 1];
    indices[offset + 1] = indices[offset + 2];
    indices[offset + 2] = second;
  }
  return { positions: mesh.positions, indices };
}

export function createBoxMesh(width: number, depth: number, height: number, cx = 0, cy = 0, z0 = 0): SolidMesh {
  const hw = width / 2;
  const hd = depth / 2;
  const x0 = cx - hw, x1 = cx + hw;
  const y0 = cy - hd, y1 = cy + hd;
  const z1 = z0 + height;

  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);

  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,
    2, 6, 7, 2, 7, 3,
    0, 3, 7, 0, 7, 4,
    1, 5, 6, 1, 6, 2,
  ]);

  return { positions, indices };
}

export function createCylinderMesh(radius: number, height: number, cx = 0, cy = 0, segments = 32): SolidMesh {
  const positions: number[] = [];
  const sideIndices: number[] = [];

  for (let i = 0; i <= segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    const x = cx + radius * Math.cos(a);
    const y = cy + radius * Math.sin(a);
    positions.push(x, y, 0, x, y, height);
  }

  for (let i = 0; i < segments; i++) {
    const b = i * 2;
    const nb = ((i + 1) % segments) * 2;
    sideIndices.push(b, nb, b + 1, b + 1, nb, nb + 1);
  }

  const bottomCenter = positions.length / 3;
  positions.push(cx, cy, 0);
  const topCenter = positions.length / 3;
  positions.push(cx, cy, height);

  const capIndices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const b = i * 2;
    const nb = ((i + 1) % segments) * 2;
    capIndices.push(bottomCenter, nb, b);
    capIndices.push(topCenter, b + 1, nb + 1);
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array([...sideIndices, ...capIndices]),
  };
}

/**
 * `radiusTop` cuts the point off: 0 is a cone, anything else is a frustum, and
 * the same value as `radius` is a cylinder.
 *
 * Nothing here had two radii, and almost everything tapered does — a table leg,
 * a chamfer, a draft angle, an elephant's trunk. Faking one meant a chain of
 * overlapping capsules, which is what the elephant's trunk still is.
 */
export function createConeMesh(radius: number, height: number, cx = 0, cy = 0, segments = 64, radiusTop = 0): SolidMesh {
  if (radiusTop > 1e-9) return createFrustumMesh(radius, radiusTop, height, cx, cy, segments);
  const positions: number[] = [cx, cy, height, cx, cy, 0];
  for (let i = 0; i < segments; i++) {
    const angle = i * Math.PI * 2 / segments;
    positions.push(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 0);
  }
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = 2 + i, b = 2 + (i + 1) % segments;
    indices.push(0, a, b, 1, b, a);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Two rings and two caps, wound the way the cylinder is — Manifold needs that. */
function createFrustumMesh(radius: number, radiusTop: number, height: number, cx: number, cy: number, segments: number): SolidMesh {
  const positions: number[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = i * Math.PI * 2 / segments;
    positions.push(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 0);
    positions.push(cx + Math.cos(angle) * radiusTop, cy + Math.sin(angle) * radiusTop, height);
  }
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const base = i * 2, next = ((i + 1) % segments) * 2;
    indices.push(base, next, base + 1, base + 1, next, next + 1);
  }
  const bottomCenter = positions.length / 3;
  positions.push(cx, cy, 0);
  const topCenter = positions.length / 3;
  positions.push(cx, cy, height);
  for (let i = 0; i < segments; i++) {
    const base = i * 2, next = ((i + 1) % segments) * 2;
    indices.push(bottomCenter, next, base);
    indices.push(topCenter, base + 1, next + 1);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/**
 * Stretches a mesh along the axes it was built on. A sphere scaled this way is
 * an ellipsoid, which is the whole point: the primitives are all surfaces of
 * revolution, so without it every squashed or stretched shape has to be faked
 * out of dozens of round ones.
 */
export function scaleMesh(mesh: SolidMesh, scale: Vec3): SolidMesh {
  const positions = mesh.positions.slice();
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] *= scale.x;
    positions[i + 1] *= scale.y;
    positions[i + 2] *= scale.z;
  }
  // An odd number of negative factors mirrors the mesh, which turns it inside
  // out. Manifold refuses a mesh wound the wrong way, so the winding is put
  // back — the same care transformMeshIndicesByWorkPlane takes for a left-
  // handed plane, and for the same reason.
  const indices = mesh.indices.slice();
  if (scale.x * scale.y * scale.z < 0) {
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const second = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = second;
    }
  }
  return { positions, indices };
}

export function createSphereMesh(radius: number, cx = 0, cy = 0, segments = 32, rings = 16): SolidMesh {
  const positions: number[] = [cx, cy, radius, cx, cy, -radius], indices: number[] = [];
  for (let ring = 1; ring < rings; ring++) {
    const phi = Math.PI * ring / rings;
    for (let segment = 0; segment < segments; segment++) {
      const theta = Math.PI * 2 * segment / segments;
      positions.push(cx + radius * Math.sin(phi) * Math.cos(theta), cy + radius * Math.sin(phi) * Math.sin(theta), radius * Math.cos(phi));
    }
  }
  for (let segment = 0; segment < segments; segment++) indices.push(0, 2 + segment, 2 + (segment + 1) % segments);
  for (let ring = 0; ring < rings - 2; ring++) for (let segment = 0; segment < segments; segment++) {
    const a = 2 + ring * segments + segment, next = 2 + ring * segments + (segment + 1) % segments;
    const b = a + segments, nextB = next + segments;
    indices.push(a, b, next, next, b, nextB);
  }
  const lastRing = 2 + (rings - 2) * segments;
  for (let segment = 0; segment < segments; segment++) indices.push(1, lastRing + (segment + 1) % segments, lastRing + segment);
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/**
 * `radius` is the distance from the centre to the middle of the tube, `tubeRadius`
 * the thickness of the tube itself. Triangles wind counter-clockwise seen from
 * outside, which Manifold requires to accept the mesh in a boolean.
 */
export function createTorusMesh(
  radius: number,
  tubeRadius: number,
  cx = 0,
  cy = 0,
  segments = 48,
  tubeSegments = 24,
): SolidMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let segment = 0; segment < segments; segment++) {
    const u = (Math.PI * 2 * segment) / segments;
    for (let tube = 0; tube < tubeSegments; tube++) {
      const v = (Math.PI * 2 * tube) / tubeSegments;
      const ring = radius + tubeRadius * Math.cos(v);
      positions.push(cx + ring * Math.cos(u), cy + ring * Math.sin(u), tubeRadius * Math.sin(v));
    }
  }
  for (let segment = 0; segment < segments; segment++) {
    const nextSegment = (segment + 1) % segments;
    for (let tube = 0; tube < tubeSegments; tube++) {
      const nextTube = (tube + 1) % tubeSegments;
      const a = segment * tubeSegments + tube;
      const b = nextSegment * tubeSegments + tube;
      const c = nextSegment * tubeSegments + nextTube;
      const d = segment * tubeSegments + nextTube;
      indices.push(a, b, c, a, c, d);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

export function createWedgeMesh(width: number, depth: number, height: number, cx = 0, cy = 0): SolidMesh {
  const x0 = cx - width / 2, x1 = cx + width / 2, y0 = cy - depth / 2, y1 = cy + depth / 2;
  return {
    positions: new Float32Array([x0,y0,0, x1,y0,0, x1,y1,0, x0,y1,0, x0,y0,height, x0,y1,height]),
    indices: new Uint32Array([0,1,2, 0,2,3, 0,3,5, 0,5,4, 0,4,1, 3,2,5, 1,4,5, 1,5,2]),
  };
}

export function createPyramidMesh(radius: number, height: number, cx = 0, cy = 0, sides = 4): SolidMesh {
  const positions: number[] = [cx, cy, height, cx, cy, 0];
  for (let index = 0; index < sides; index++) {
    const angle = Math.PI / 4 + index * Math.PI * 2 / sides;
    positions.push(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 0);
  }
  const indices: number[] = [];
  for (let index = 0; index < sides; index++) {
    const a = 2 + index, b = 2 + (index + 1) % sides;
    indices.push(0, a, b, 1, b, a);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
