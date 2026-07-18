import type { Vec2, Vec3 } from './geometry';

export interface WorkPlane {
  origin: Vec3;
  xAxis: Vec3;
  yAxis: Vec3;
  zAxis: Vec3;
}

export const WORLD_WORK_PLANE: WorkPlane = {
  origin: { x: 0, y: 0, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 },
};

export function cloneWorkPlane(plane: WorkPlane): WorkPlane {
  return JSON.parse(JSON.stringify(plane)) as WorkPlane;
}

/** Whether a plane is the world plane itself — i.e. the UCS is the WCS. */
export function isWorldWorkPlane(plane: WorkPlane): boolean {
  const zero = (v: number): boolean => Math.abs(v) < 1e-9;
  const one = (v: number): boolean => Math.abs(v - 1) < 1e-9;
  return zero(plane.origin.x) && zero(plane.origin.y) && zero(plane.origin.z)
    && one(plane.xAxis.x) && zero(plane.xAxis.y) && zero(plane.xAxis.z)
    && zero(plane.yAxis.x) && one(plane.yAxis.y) && zero(plane.yAxis.z)
    && zero(plane.zAxis.x) && zero(plane.zAxis.y) && one(plane.zAxis.z);
}

export function localToWorld(plane: WorkPlane, point: Vec2, z = 0): Vec3 {
  return {
    x: plane.origin.x + plane.xAxis.x * point.x + plane.yAxis.x * point.y + plane.zAxis.x * z,
    y: plane.origin.y + plane.xAxis.y * point.x + plane.yAxis.y * point.y + plane.zAxis.y * z,
    z: plane.origin.z + plane.xAxis.z * point.x + plane.yAxis.z * point.y + plane.zAxis.z * z,
  };
}

export function worldToLocal(plane: WorkPlane, point: Vec3): Vec3 {
  const offset = { x: point.x - plane.origin.x, y: point.y - plane.origin.y, z: point.z - plane.origin.z };
  return {
    x: offset.x * plane.xAxis.x + offset.y * plane.xAxis.y + offset.z * plane.xAxis.z,
    y: offset.x * plane.yAxis.x + offset.y * plane.yAxis.y + offset.z * plane.yAxis.z,
    z: offset.x * plane.zAxis.x + offset.y * plane.zAxis.y + offset.z * plane.zAxis.z,
  };
}

function normalize(value: Vec3): Vec3 {
  const length = Math.hypot(value.x, value.y, value.z);
  if (length < 1e-9) throw new Error('UCS axis points must be different.');
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

export function workPlaneFromAxis(origin: Vec3, axisPoint: Vec3): WorkPlane {
  const zAxis = normalize({ x: axisPoint.x - origin.x, y: axisPoint.y - origin.y, z: axisPoint.z - origin.z });
  const reference = Math.abs(zAxis.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  const xAxis = normalize(cross(reference, zAxis));
  const yAxis = normalize(cross(zAxis, xAxis));
  return { origin: { ...origin }, xAxis, yAxis, zAxis };
}

export function workPlaneFromXAxis(origin: Vec3, axisPoint: Vec3, referenceZ: Vec3): WorkPlane {
  const zAxis = normalize(referenceZ);
  const raw = { x: axisPoint.x - origin.x, y: axisPoint.y - origin.y, z: axisPoint.z - origin.z };
  const alongZ = raw.x * zAxis.x + raw.y * zAxis.y + raw.z * zAxis.z;
  const xAxis = normalize({
    x: raw.x - zAxis.x * alongZ,
    y: raw.y - zAxis.y * alongZ,
    z: raw.z - zAxis.z * alongZ,
  });
  const yAxis = normalize(cross(zAxis, xAxis));
  return { origin: { ...origin }, xAxis, yAxis, zAxis };
}

export function workPlaneFromXYAxes(origin: Vec3, xPoint: Vec3, yPoint: Vec3): WorkPlane {
  const xAxis = normalize({
    x: xPoint.x - origin.x,
    y: xPoint.y - origin.y,
    z: xPoint.z - origin.z,
  });
  const rawY = {
    x: yPoint.x - origin.x,
    y: yPoint.y - origin.y,
    z: yPoint.z - origin.z,
  };
  const alongX = rawY.x * xAxis.x + rawY.y * xAxis.y + rawY.z * xAxis.z;
  const yDirection = {
    x: rawY.x - xAxis.x * alongX,
    y: rawY.y - xAxis.y * alongX,
    z: rawY.z - xAxis.z * alongX,
  };
  const yAxis = normalize(yDirection);
  // AutoCAD-style UCS is right-handed: positive Z follows X × Y.
  const zAxis = normalize(cross(xAxis, yAxis));
  return { origin: { ...origin }, xAxis, yAxis, zAxis };
}

export function transformMeshIndicesByWorkPlane(indices: Uint32Array, plane: WorkPlane): Uint32Array {
  const handedness = plane.xAxis.x * (plane.yAxis.y * plane.zAxis.z - plane.yAxis.z * plane.zAxis.y)
    - plane.yAxis.x * (plane.xAxis.y * plane.zAxis.z - plane.xAxis.z * plane.zAxis.y)
    + plane.zAxis.x * (plane.xAxis.y * plane.yAxis.z - plane.xAxis.z * plane.yAxis.y);
  const transformed = indices.slice();
  if (handedness < 0) {
    for (let i = 0; i + 2 < transformed.length; i += 3) {
      const second = transformed[i + 1];
      transformed[i + 1] = transformed[i + 2];
      transformed[i + 2] = second;
    }
  }
  return transformed;
}

export function transformMeshByWorkPlane(positions: Float32Array, plane: WorkPlane): Float32Array {
  const transformed = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const point = localToWorld(plane, { x: positions[i], y: positions[i + 1] }, positions[i + 2]);
    transformed[i] = point.x; transformed[i + 1] = point.y; transformed[i + 2] = point.z;
  }
  return transformed;
}
