/**
 * Dragging one grip along one axis — AutoCAD's own way of pulling a point out
 * of its plane.
 *
 * A grip drag otherwise reads the cursor as the pointer ray's intersection
 * with the entity's work plane, which by construction has no elevation at all:
 * a point could slide anywhere within its plane but never off it. Picking an
 * axis first turns the drag back into the one-dimensional question
 * `axisOffsetUnderRay` already answers for solid faces and extrude heights —
 * so the same skew-line math places the point, and z stops being unreachable.
 *
 * Separate from the pointer handler because this is the part that can be
 * wrong quietly (a sign slip pushes where you pulled, a missing start offset
 * makes the point jump the moment an axis is picked), and the part a test can
 * pin down without a camera.
 */
import { axisOffsetUnderRay } from './AxisDrag';
import type { Vec3 } from '../math/geometry';
import type { WorkPlane } from '../math/workplane';

export type GripAxisName = 'x' | 'y' | 'z';

export interface PointerRay { origin: Vec3; direction: Vec3 }

export interface GripAxisLock {
  axis: GripAxisName;
  /** Where the grip sat, in world space, when the axis was picked. */
  origin: Vec3;
  /** Unit world direction of the chosen axis. */
  direction: Vec3;
  /** How far along that axis the cursor already was at that moment, so the
   *  point travels from where it is rather than jumping to wherever the
   *  pointer happens to cross the axis first. */
  startOffset: number;
}

/** The chosen axis of `plane`, in world space. The entity's own plane, not
 *  the world axes: the point written back is local to it, so travelling along
 *  its z is exactly "off the plane" — and for a curve already bent through 3D
 *  (built in the world plane) the two are the same thing anyway. */
export function workPlaneAxis(plane: WorkPlane, axis: GripAxisName): Vec3 {
  return axis === 'x' ? plane.xAxis : axis === 'y' ? plane.yAxis : plane.zAxis;
}

/** Locks a drag to one axis through the grip's current world position.
 *  Null when the ray runs along the axis, where every point on it is equally
 *  close and the drag would be noise — the caller keeps the drag unlocked. */
export function beginGripAxisLock(axis: GripAxisName, plane: WorkPlane, origin: Vec3, ray: PointerRay): GripAxisLock | null {
  const direction = workPlaneAxis(plane, axis);
  const startOffset = axisOffsetUnderRay(origin, direction, ray.origin, ray.direction);
  return startOffset === null ? null : { axis, origin: { ...origin }, direction: { ...direction }, startOffset };
}

/** Where the locked grip belongs for this pointer ray — its own position
 *  displaced along the axis by however far the cursor has travelled since the
 *  lock. Null while the ray is parallel to the axis, where the caller should
 *  hold the last good position rather than snapping somewhere arbitrary. */
export function gripAxisPointUnderRay(lock: GripAxisLock, ray: PointerRay): Vec3 | null {
  const offset = axisOffsetUnderRay(lock.origin, lock.direction, ray.origin, ray.direction);
  if (offset === null) return null;
  const travel = offset - lock.startOffset;
  return {
    x: lock.origin.x + lock.direction.x * travel,
    y: lock.origin.y + lock.direction.y * travel,
    z: lock.origin.z + lock.direction.z * travel,
  };
}
