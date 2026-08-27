import type { Vec3 } from './geometry';
import { cloneWorkPlane, type WorkPlane } from './workplane';

export type UcsAxisName = 'x' | 'y' | 'z';
export type UcsHandleName = UcsAxisName | 'origin';

/** Points one UCS axis at a world point and rebuilds a right-handed orthogonal frame. */
export function pointWorkPlaneAxisAt(plane: WorkPlane, axis: UcsAxisName, target: Vec3): WorkPlane | null {
  const direction = normalized(sub(target, plane.origin));
  if (!direction) return null;
  const result = cloneWorkPlane(plane);
  if (axis === 'x') {
    result.xAxis = direction;
    result.yAxis = perpendicularized(plane.yAxis, direction) ?? fallbackPerpendicular(direction);
    result.zAxis = normalized(cross(result.xAxis, result.yAxis))!;
    result.yAxis = normalized(cross(result.zAxis, result.xAxis))!;
  } else if (axis === 'y') {
    result.yAxis = direction;
    result.xAxis = perpendicularized(plane.xAxis, direction) ?? fallbackPerpendicular(direction);
    result.zAxis = normalized(cross(result.xAxis, result.yAxis))!;
    result.xAxis = normalized(cross(result.yAxis, result.zAxis))!;
  } else {
    result.zAxis = direction;
    result.xAxis = perpendicularized(plane.xAxis, direction) ?? fallbackPerpendicular(direction);
    result.yAxis = normalized(cross(result.zAxis, result.xAxis))!;
    result.xAxis = normalized(cross(result.yAxis, result.zAxis))!;
  }
  return result;
}

function perpendicularized(value: Vec3, axis: Vec3): Vec3 | null {
  const projection = dot(value, axis);
  return normalized({ x: value.x - axis.x * projection, y: value.y - axis.y * projection, z: value.z - axis.z * projection });
}

function fallbackPerpendicular(axis: Vec3): Vec3 {
  const seed = Math.abs(axis.z) < 0.8 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  return normalized(cross(seed, axis))!;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const normalized = (v: Vec3): Vec3 | null => { const length = Math.hypot(v.x, v.y, v.z); return length > 1e-9 ? { x: v.x / length, y: v.y / length, z: v.z / length } : null; };
