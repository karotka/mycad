/**
 * How far along an axis the cursor is pointing.
 *
 * Dragging a face is a one-dimensional question asked with a two-dimensional
 * pointer: the face may only travel along its own normal, so the answer is the
 * point on that axis the pointer ray passes closest to. Separate from the
 * viewport because it is the part that can be wrong quietly — a sign slip pushes
 * where you pulled — and the part a test can pin down without a camera.
 */
import type { Vec3 } from '../math/geometry';

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

/**
 * The offset from `axisOrigin`, along `axisDirection`, of the closest point on
 * that axis to the ray — the classic closest approach between two skew lines.
 * Null when the ray is parallel to the axis, where every point on it is equally
 * close and the answer would be noise. Both must be in the same space, and both
 * directions are taken as unit vectors.
 */
export function axisOffsetUnderRay(
  axisOrigin: Vec3,
  axisDirection: Vec3,
  rayOrigin: Vec3,
  rayDirection: Vec3,
): number | null {
  const between = sub(axisOrigin, rayOrigin);
  const axisLength = dot(axisDirection, axisDirection);
  const alignment = dot(axisDirection, rayDirection);
  const rayLength = dot(rayDirection, rayDirection);
  const alongAxis = dot(axisDirection, between);
  const alongRay = dot(rayDirection, between);

  const denominator = axisLength * rayLength - alignment * alignment;
  // Looking straight down the axis: the ray meets it everywhere and nowhere.
  if (Math.abs(denominator) < 1e-9) return null;
  return (alignment * alongRay - rayLength * alongAxis) / denominator;
}

/** The middle of a set of the mesh's vertices — a face's own position. */
export function verticesCentre(positions: Float32Array, indices: readonly number[]): Vec3 | null {
  if (indices.length === 0) return null;
  let x = 0, y = 0, z = 0;
  for (const index of indices) {
    x += positions[index * 3];
    y += positions[index * 3 + 1];
    z += positions[index * 3 + 2];
  }
  return { x: x / indices.length, y: y / indices.length, z: z / indices.length };
}
