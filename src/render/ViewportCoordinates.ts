import type { Vec2, Vec3 } from '../math/geometry';

export type StandardView = 'top' | 'front' | 'left' | 'right';

export function cadToThree(point: Vec3): Vec3 {
  return { x: point.x, y: point.z, z: -point.y };
}

export function threeToCad(point: Vec3): Vec3 {
  return { x: point.x, y: -point.z, z: point.y };
}

export function standardViewDelta(delta: Vec2, view: StandardView | null): Vec3 | null {
  if (view === 'top') return { x: delta.x, y: delta.y, z: 0 };
  if (view === 'front') return { x: delta.x, y: 0, z: delta.y };
  if (view === 'left') return { x: 0, y: -delta.x, z: delta.y };
  if (view === 'right') return { x: 0, y: delta.x, z: delta.y };
  return null;
}
