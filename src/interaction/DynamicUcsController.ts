import type { SolidFaceRegion } from '../core/entities/types';
import type { Vec2, Vec3 } from '../math/geometry';
import { cloneWorkPlane, workPlaneFromXAxis, worldToLocal, type WorkPlane } from '../math/workplane';

/**
 * A right-angled face already says what its useful axes are. Prefer its two
 * perpendicular sides over the longest edge — which is the hypotenuse on a
 * triangular face and makes height/width dimensions unnecessarily rotated.
 */
export function preferredDynamicFacePlane(region: SolidFaceRegion): WorkPlane {
  const loop = region.loops[0];
  if (!loop || loop.length < 3) return cloneWorkPlane(region.plane);
  type Candidate = { direction: Vec2; length: number };
  let best: Candidate | null = null;
  for (let index = 0; index < loop.length; index++) {
    const point = loop[index];
    const previous = loop[(index - 1 + loop.length) % loop.length];
    const next = loop[(index + 1) % loop.length];
    const toPrevious = { x: previous.x - point.x, y: previous.y - point.y };
    const toNext = { x: next.x - point.x, y: next.y - point.y };
    const previousLength = Math.hypot(toPrevious.x, toPrevious.y);
    const nextLength = Math.hypot(toNext.x, toNext.y);
    if (previousLength < 1e-8 || nextLength < 1e-8) continue;
    const cosine = (
      toPrevious.x * toNext.x + toPrevious.y * toNext.y
    ) / (previousLength * nextLength);
    // Mesh coordinates carry small round-off errors, so accept roughly one
    // degree around a true 90° corner.
    if (Math.abs(cosine) > 0.02) continue;
    const candidate = previousLength >= nextLength
      ? { direction: toPrevious, length: previousLength }
      : { direction: toNext, length: nextLength };
    if (!best || candidate.length > best.length) best = candidate;
  }
  if (!best) return cloneWorkPlane(region.plane);

  let worldDirection = {
    x: region.plane.xAxis.x * best.direction.x + region.plane.yAxis.x * best.direction.y,
    y: region.plane.xAxis.y * best.direction.x + region.plane.yAxis.y * best.direction.y,
    z: region.plane.xAxis.z * best.direction.x + region.plane.yAxis.z * best.direction.y,
  };
  // Preserve the old plane's general positive-X sense so re-acquiring the same
  // face does not make the grid flip by 180 degrees.
  const alongExistingX = (
    worldDirection.x * region.plane.xAxis.x
    + worldDirection.y * region.plane.xAxis.y
    + worldDirection.z * region.plane.xAxis.z
  );
  if (alongExistingX < 0) {
    worldDirection = {
      x: -worldDirection.x,
      y: -worldDirection.y,
      z: -worldDirection.z,
    };
  }
  return workPlaneFromXAxis(
    region.plane.origin,
    {
      x: region.plane.origin.x + worldDirection.x,
      y: region.plane.origin.y + worldDirection.y,
      z: region.plane.origin.z + worldDirection.z,
    },
    region.plane.zAxis,
  );
}

/**
 * Owns the reversible part of Dynamic UCS. Applying the returned work plane to
 * the document and renderer stays with the application; this class only makes
 * sure the original UCS is captured once and restored exactly once.
 */
export class DynamicUcsController {
  private basePlane: WorkPlane | null = null;
  private temporaryPlane: WorkPlane | null = null;
  private faceKey: string | null = null;
  private locked = false;

  constructor(private enabledValue = true) {}

  get enabled(): boolean { return this.enabledValue; }
  get isTemporary(): boolean { return this.temporaryPlane !== null; }
  get isLocked(): boolean { return this.locked; }

  /**
   * Aligns to the hovered planar face. The first origin used on one face stays
   * fixed while the pointer moves across it, so the grid does not slide under
   * the cursor. A different face immediately gets its own plane and origin.
   */
  acquire(currentPlane: WorkPlane, facePlane: WorkPlane, origin: WorkPlane['origin'], key: string): WorkPlane | null {
    if (!this.enabledValue || this.locked) return null;
    if (!this.basePlane) this.basePlane = cloneWorkPlane(currentPlane);
    if (this.faceKey === key && this.temporaryPlane) return null;
    this.faceKey = key;
    this.temporaryPlane = cloneWorkPlane({ ...facePlane, origin: { ...origin } });
    return cloneWorkPlane(this.temporaryPlane);
  }

  /** Once the first point is accepted, the rest of that object uses one plane. */
  lock(): void {
    if (this.temporaryPlane) this.locked = true;
  }

  /**
   * A face raycast can disappear exactly on its boundary. Keep the acquired
   * plane while the cursor is snapping to a vertex that still lies on it,
   * instead of dropping back to the previous UCS one pixel before the click.
   */
  containsPoint(point: Vec3, tolerance = 1e-5): boolean {
    return Boolean(
      this.temporaryPlane
      && Math.abs(worldToLocal(this.temporaryPlane, point).z) <= tolerance
    );
  }

  /** Returns the UCS captured before the first face was acquired. */
  release(): WorkPlane | null {
    const restored = this.basePlane ? cloneWorkPlane(this.basePlane) : null;
    this.basePlane = null;
    this.temporaryPlane = null;
    this.faceKey = null;
    this.locked = false;
    return restored;
  }

  /** F6 changes the persistent mode and releases a live temporary UCS when off. */
  toggle(): WorkPlane | null {
    this.enabledValue = !this.enabledValue;
    return this.enabledValue ? null : this.release();
  }
}
