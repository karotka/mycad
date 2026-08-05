import type { Vec2, Vec3 } from '../../math/geometry';
import { localToWorld, type WorkPlane } from '../../math/workplane';
import type { ExactSolidGeometry, Solid } from '../entities/types';
import type { AffineTransform3 } from './GeometryKernel';

export const IDENTITY_AFFINE: AffineTransform3 = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
];

export function translationAffine(delta: Vec3): AffineTransform3 {
  return [
    1, 0, 0, delta.x,
    0, 1, 0, delta.y,
    0, 0, 1, delta.z,
  ];
}

export function scaleAffine(base: Vec3, scale: Vec3): AffineTransform3 {
  return [
    scale.x, 0, 0, base.x * (1 - scale.x),
    0, scale.y, 0, base.y * (1 - scale.y),
    0, 0, scale.z, base.z * (1 - scale.z),
  ];
}

export function rotationAffine(origin: Vec3, axis: Vec3, angle: number): AffineTransform3 {
  const length = Math.hypot(axis.x, axis.y, axis.z);
  if (length <= Number.EPSILON) throw new Error('Rotation axis must be non-zero.');
  const x = axis.x / length, y = axis.y / length, z = axis.z / length;
  const cos = Math.cos(angle), sin = Math.sin(angle), oneMinusCos = 1 - cos;
  const r00 = cos + x * x * oneMinusCos;
  const r01 = x * y * oneMinusCos - z * sin;
  const r02 = x * z * oneMinusCos + y * sin;
  const r10 = y * x * oneMinusCos + z * sin;
  const r11 = cos + y * y * oneMinusCos;
  const r12 = y * z * oneMinusCos - x * sin;
  const r20 = z * x * oneMinusCos - y * sin;
  const r21 = z * y * oneMinusCos + x * sin;
  const r22 = cos + z * z * oneMinusCos;
  return [
    r00, r01, r02, origin.x - r00 * origin.x - r01 * origin.y - r02 * origin.z,
    r10, r11, r12, origin.y - r10 * origin.x - r11 * origin.y - r12 * origin.z,
    r20, r21, r22, origin.z - r20 * origin.x - r21 * origin.y - r22 * origin.z,
  ];
}

/** Reflection across the plane that contains the drawn axis and the UCS Z axis. */
export function mirrorAffine(plane: WorkPlane, axisStart: Vec2, axisEnd: Vec2): AffineTransform3 {
  const dx = axisEnd.x - axisStart.x, dy = axisEnd.y - axisStart.y;
  const length = Math.hypot(dx, dy);
  if (length <= Number.EPSILON) throw new Error('Mirror axis must have a non-zero length.');
  const ux = dx / length, uy = dy / length;
  const r00 = 2 * ux * ux - 1;
  const r01 = 2 * ux * uy;
  const r10 = r01;
  const r11 = 2 * uy * uy - 1;
  const x = plane.xAxis, y = plane.yAxis, z = plane.zAxis;
  const linear = (row: 'x' | 'y' | 'z', column: 'x' | 'y' | 'z'): number =>
    x[row] * (r00 * x[column] + r01 * y[column])
    + y[row] * (r10 * x[column] + r11 * y[column])
    + z[row] * z[column];
  const m00 = linear('x', 'x'), m01 = linear('x', 'y'), m02 = linear('x', 'z');
  const m10 = linear('y', 'x'), m11 = linear('y', 'y'), m12 = linear('y', 'z');
  const m20 = linear('z', 'x'), m21 = linear('z', 'y'), m22 = linear('z', 'z');
  const anchor = localToWorld(plane, axisStart);
  return [
    m00, m01, m02, anchor.x - m00 * anchor.x - m01 * anchor.y - m02 * anchor.z,
    m10, m11, m12, anchor.y - m10 * anchor.x - m11 * anchor.y - m12 * anchor.z,
    m20, m21, m22, anchor.z - m20 * anchor.x - m21 * anchor.y - m22 * anchor.z,
  ];
}

/** `next` is applied after `current`, matching successive mesh edits. */
export function composeAffine(next: AffineTransform3, current: AffineTransform3): AffineTransform3 {
  const value = (row: number, column: number): number => {
    if (column === 3) {
      return next[row * 4] * current[3]
        + next[row * 4 + 1] * current[7]
        + next[row * 4 + 2] * current[11]
        + next[row * 4 + 3];
    }
    return next[row * 4] * current[column]
      + next[row * 4 + 1] * current[4 + column]
      + next[row * 4 + 2] * current[8 + column];
  };
  return [
    value(0, 0), value(0, 1), value(0, 2), value(0, 3),
    value(1, 0), value(1, 1), value(1, 2), value(1, 3),
    value(2, 0), value(2, 1), value(2, 2), value(2, 3),
  ];
}

export function transformPoint(transform: AffineTransform3, point: Vec3): Vec3 {
  return {
    x: transform[0] * point.x + transform[1] * point.y + transform[2] * point.z + transform[3],
    y: transform[4] * point.x + transform[5] * point.y + transform[6] * point.z + transform[7],
    z: transform[8] * point.x + transform[9] * point.y + transform[10] * point.z + transform[11],
  };
}

export function transformedExactGeometry(
  exact: ExactSolidGeometry | undefined,
  sourceRevision: number,
  transform: AffineTransform3,
  nextRevision: number,
): ExactSolidGeometry | undefined {
  if (!exact || exact.revision !== sourceRevision || Math.abs(affineDeterminant(transform)) <= 1e-15) return undefined;
  return {
    ...exact,
    revision: nextRevision,
    shape: { ...exact.shape },
    transform: composeAffine(transform, exact.transform ?? IDENTITY_AFFINE),
  };
}

function affineDeterminant(transform: AffineTransform3): number {
  return transform[0] * (transform[5] * transform[10] - transform[6] * transform[9])
    - transform[1] * (transform[4] * transform[10] - transform[6] * transform[8])
    + transform[2] * (transform[4] * transform[9] - transform[5] * transform[8]);
}

/** Carries a current exact snapshot through the same transform already applied to its mesh. */
export function preserveExactTransform(
  solid: Solid,
  transform: AffineTransform3,
  nextRevision = solid.revision + 1,
): void {
  solid.exact = transformedExactGeometry(solid.exact, solid.revision, transform, nextRevision);
}
