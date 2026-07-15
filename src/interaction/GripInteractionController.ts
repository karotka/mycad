import type { Entity, Solid } from '../core/entities/types';
import type { Vec2 } from '../math/geometry';
import { GripController, type GripMode } from './GripController';

export class GripInteractionController {
  private latched = false;
  private snapMode: GripMode | null = null;

  constructor(private readonly grips: GripController, private readonly viewport: HTMLElement) {}

  get isLatched(): boolean { return this.latched; }
  get targetSnapMode(): GripMode | null { return this.snapMode; }

  setTargetSnapMode(mode: GripMode | null): void { this.snapMode = mode; }

  begin(entity: Entity | undefined, solid: Solid | undefined, gripIndex: number, point: Vec2, pointerId: number): void {
    this.grips.begin(entity, solid, gripIndex, point);
    this.latched = true;
    this.viewport.setPointerCapture(pointerId);
  }

  finishClick(pointerId: number): void {
    this.grips.commit();
    this.latched = false;
    this.snapMode = null;
    this.grips.hoveredGrip = -1;
    this.release(pointerId);
  }

  commitIfNotLatched(): void {
    if (!this.latched) this.grips.commit();
  }

  applyRelativeDistance(distance: number): boolean {
    if (!this.grips.isDragging || !this.latched || !this.grips.applyRelativeDistance(distance)) return false;
    this.grips.commit();
    this.latched = false;
    this.snapMode = null;
    this.grips.hoveredGrip = -1;
    return true;
  }

  cancel(): void {
    this.grips.cancel();
    this.latched = false;
    this.snapMode = null;
  }

  private release(pointerId: number): void {
    if (this.viewport.hasPointerCapture(pointerId)) this.viewport.releasePointerCapture(pointerId);
  }
}
