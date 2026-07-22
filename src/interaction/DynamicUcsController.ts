import { cloneWorkPlane, type WorkPlane } from '../math/workplane';

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
