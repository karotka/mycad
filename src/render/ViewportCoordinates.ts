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

/**
 * The nav cube's own CSS rotation, from the 3D camera's azimuth/elevation
 * (see Viewport3D.viewCubeAngles). In 2D mode the 3D camera's actual pose is
 * unrelated to what's on screen — the 2D canvas is always a straight-down
 * view of the world plane (2D mode is defined that way; see
 * followWorkPlaneView in main.ts) — so the cube shows TOP there regardless
 * of wherever the (unused) 3D camera happens to be sitting, rather than
 * whatever isometric-ish angle it was last left at.
 */
export function viewCubeTransform(
  viewMode: '2d' | '3d',
  cameraAngles: { azimuth: number; elevation: number },
): { tilt: number; spin: number } {
  const { azimuth, elevation } = viewMode === '2d' ? { azimuth: 0, elevation: Math.PI / 2 } : cameraAngles;
  return {
    tilt: (-elevation * 180) / Math.PI,
    spin: (-(azimuth * 180) / Math.PI) - 90,
  };
}
