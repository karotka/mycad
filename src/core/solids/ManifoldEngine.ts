import Module from 'manifold-3d';
import type { Vec2 } from '../../math/geometry';
import { closePolyline, polygonSignedArea } from '../../math/geometry';
import type { Entity, SolidEdgeSelection, SolidFeature, SolidMesh } from '../entities/types';
import { transformMeshByWorkPlane, transformMeshIndicesByWorkPlane } from '../../math/workplane';

let manifoldReady: Promise<Awaited<ReturnType<typeof Module>>> | null = null;

export async function initManifold() {
  if (!manifoldReady) {
    manifoldReady = Module().then((manifold) => {
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

function ensureCCW(verts: Vec2[]): Vec2[] {
  if (polygonSignedArea(verts) < 0) return [...verts].reverse();
  return verts;
}

function vec2ToManifoldPoly(manifold: Awaited<ReturnType<typeof Module>>, verts: Vec2[]) {
  const closed = closePolyline(verts);
  const ccw = ensureCCW(closed);
  return ccw.slice(0, -1).map((v): [number, number] => [v.x, v.y]);
}

function manifoldToMesh(manifold: Awaited<ReturnType<typeof Module>>, m: InstanceType<Awaited<ReturnType<typeof Module>>['Manifold']>): SolidMesh {
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
