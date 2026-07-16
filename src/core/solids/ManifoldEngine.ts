import type ModuleFactory from 'manifold-3d';
import type { Vec2, Vec3 } from '../../math/geometry';
import { closePolyline, polygonSignedArea } from '../../math/geometry';
import type { Entity, SolidEdgeSelection, SolidFeature, SolidMesh } from '../entities/types';
import { curvePoints } from '../entities/types';
import { localToWorld, workPlaneFromXYAxes, WORLD_WORK_PLANE, transformMeshByWorkPlane, transformMeshIndicesByWorkPlane, type WorkPlane } from '../../math/workplane';

type ManifoldModule = Awaited<ReturnType<typeof ModuleFactory>>;

let manifoldReady: Promise<ManifoldModule> | null = null;

export async function initManifold() {
  if (!manifoldReady) {
    manifoldReady = import('manifold-3d').then(({ default: createModule }) => createModule()).then((manifold) => {
      manifold.setup();
      return manifold;
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

export async function modifySolidEdge(
  mesh: SolidMesh,
  edge: SolidEdgeSelection,
  amount: number,
  rounded: boolean,
): Promise<SolidMesh | null> {
  if (amount <= 0) return null;
  const manifold = await initManifold();
  const sourceMesh = new manifold.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices });
  let solid = manifold.Manifold.ofMesh(sourceMesh);
  const normalize = (v: [number, number, number]): [number, number, number] => {
    const length = Math.hypot(...v);
    return [v[0] / length, v[1] / length, v[2] / length];
  };
  const a = normalize([edge.normalA.x, edge.normalA.y, edge.normalA.z]);
  const b = normalize([edge.normalB.x, edge.normalB.y, edge.normalB.z]);
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const angle = Math.acos(dot);
  if (angle < 1e-4 || angle > Math.PI - 1e-4) { solid.delete(); return null; }
  const bisector = normalize([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
  const p: [number, number, number] = [edge.start.x, edge.start.y, edge.start.z];
  const planes: Array<{ normal: [number, number, number]; offset: number }> = [];
  if (!rounded) {
    const threshold = bisector[0] * p[0] + bisector[1] * p[1] + bisector[2] * p[2]
      - amount * Math.sin(angle / 2);
    planes.push({ normal: bisector, offset: threshold });
  } else {
    const centerDistance = amount / Math.sin(angle / 2);
    const center: [number, number, number] = [
      p[0] - bisector[0] * centerDistance,
      p[1] - bisector[1] * centerDistance,
      p[2] - bisector[2] * centerDistance,
    ];
    const segments = 12;
    for (let i = 1; i < segments; i++) {
      const t = i / segments;
      const sinAngle = Math.sin(angle);
      const wa = Math.sin((1 - t) * angle) / sinAngle;
      const wb = Math.sin(t * angle) / sinAngle;
      const normal = normalize([a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb]);
      planes.push({
        normal,
        offset: normal[0] * center[0] + normal[1] * center[1] + normal[2] * center[2] + amount,
      });
    }
  }
  try {
    for (const plane of planes) {
      const next = solid.trimByPlane(
        [-plane.normal[0], -plane.normal[1], -plane.normal[2]],
        -plane.offset,
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

export async function regenerateSolidFeature(feature: SolidFeature): Promise<SolidMesh | null> {
  if (feature.kind === 'mesh') return null;
  if (feature.kind === 'primitive') {
    const local = feature.primitive === 'box' ? createBoxMesh(feature.width ?? 1, feature.depth ?? 1, feature.height, feature.center.x, feature.center.y)
      : feature.primitive === 'wedge' ? createWedgeMesh(feature.width ?? 1, feature.depth ?? 1, feature.height, feature.center.x, feature.center.y)
      : feature.primitive === 'sphere' ? createSphereMesh(feature.radius ?? 1, feature.center.x, feature.center.y)
      : feature.primitive === 'cone' ? createConeMesh(feature.radius ?? 1, feature.height, feature.center.x, feature.center.y)
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

export function createConeMesh(radius: number, height: number, cx = 0, cy = 0, segments = 64): SolidMesh {
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
