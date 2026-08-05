import type { Vec3 } from '../../math/geometry';
import { transformMeshByWorkPlane, transformMeshIndicesByWorkPlane } from '../../math/workplane';
import type { PrimitiveFeature, SolidMesh } from '../entities/types';

/**
 * Lightweight triangulations used only for immediate previews and test
 * fixtures. Modelled solids are always built by OpenCascade; none of these
 * meshes is a geometry source of truth.
 */
export function primitivePreviewMesh(feature: PrimitiveFeature): SolidMesh {
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

export function createBoxMesh(width: number, depth: number, height: number, cx = 0, cy = 0, z0 = 0): SolidMesh {
  const x0 = cx - width / 2, x1 = cx + width / 2;
  const y0 = cy - depth / 2, y1 = cy + depth / 2, z1 = z0 + height;
  return {
    positions: new Float32Array([
      x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
      x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
    ]),
    indices: new Uint32Array([
      0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
      0, 4, 5, 0, 5, 1, 2, 6, 7, 2, 7, 3,
      0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
    ]),
  };
}

export function createCylinderMesh(radius: number, height: number, cx = 0, cy = 0, segments = 32): SolidMesh {
  const positions: number[] = [], indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = Math.PI * 2 * i / segments;
    const x = cx + Math.cos(angle) * radius, y = cy + Math.sin(angle) * radius;
    positions.push(x, y, 0, x, y, height);
  }
  const bottom = positions.length / 3; positions.push(cx, cy, 0);
  const top = positions.length / 3; positions.push(cx, cy, height);
  for (let i = 0; i < segments; i++) {
    const a = i * 2, b = ((i + 1) % segments) * 2;
    indices.push(a, b, a + 1, a + 1, b, b + 1, bottom, b, a, top, a + 1, b + 1);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

export function createConeMesh(radius: number, height: number, cx = 0, cy = 0, segments = 64, radiusTop = 0): SolidMesh {
  if (radiusTop > 1e-9) return createFrustumMesh(radius, radiusTop, height, cx, cy, segments);
  const positions: number[] = [cx, cy, height, cx, cy, 0], indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = Math.PI * 2 * i / segments;
    positions.push(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 0);
  }
  for (let i = 0; i < segments; i++) {
    const a = 2 + i, b = 2 + (i + 1) % segments;
    indices.push(0, a, b, 1, b, a);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

function createFrustumMesh(radius: number, radiusTop: number, height: number, cx: number, cy: number, segments: number): SolidMesh {
  const positions: number[] = [], indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = Math.PI * 2 * i / segments;
    positions.push(
      cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 0,
      cx + Math.cos(angle) * radiusTop, cy + Math.sin(angle) * radiusTop, height,
    );
  }
  const bottom = positions.length / 3; positions.push(cx, cy, 0);
  const top = positions.length / 3; positions.push(cx, cy, height);
  for (let i = 0; i < segments; i++) {
    const a = i * 2, b = ((i + 1) % segments) * 2;
    indices.push(a, b, a + 1, a + 1, b, b + 1, bottom, b, a, top, a + 1, b + 1);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

export function scaleMesh(mesh: SolidMesh, scale: Vec3): SolidMesh {
  const positions = mesh.positions.slice(), indices = mesh.indices.slice();
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] *= scale.x; positions[i + 1] *= scale.y; positions[i + 2] *= scale.z;
  }
  if (scale.x * scale.y * scale.z < 0) {
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const swap = indices[i + 1]; indices[i + 1] = indices[i + 2]; indices[i + 2] = swap;
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

export function createTorusMesh(radius: number, tubeRadius: number, cx = 0, cy = 0, segments = 48, tubeSegments = 24): SolidMesh {
  const positions: number[] = [], indices: number[] = [];
  for (let segment = 0; segment < segments; segment++) {
    const u = Math.PI * 2 * segment / segments;
    for (let tube = 0; tube < tubeSegments; tube++) {
      const v = Math.PI * 2 * tube / tubeSegments, ring = radius + tubeRadius * Math.cos(v);
      positions.push(cx + ring * Math.cos(u), cy + ring * Math.sin(u), tubeRadius * Math.sin(v));
    }
  }
  for (let segment = 0; segment < segments; segment++) for (let tube = 0; tube < tubeSegments; tube++) {
    const a = segment * tubeSegments + tube;
    const b = ((segment + 1) % segments) * tubeSegments + tube;
    const c = ((segment + 1) % segments) * tubeSegments + (tube + 1) % tubeSegments;
    const d = segment * tubeSegments + (tube + 1) % tubeSegments;
    indices.push(a, b, c, a, c, d);
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
  const positions: number[] = [cx, cy, height, cx, cy, 0], indices: number[] = [];
  for (let index = 0; index < sides; index++) {
    const angle = Math.PI / 4 + index * Math.PI * 2 / sides;
    positions.push(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 0);
  }
  for (let index = 0; index < sides; index++) {
    const a = 2 + index, b = 2 + (index + 1) % sides;
    indices.push(0, a, b, 1, b, a);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
