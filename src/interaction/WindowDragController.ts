import type { Vec2 } from '../math/geometry';

export type WindowDragPurpose = 'select' | 'zoom';

export interface WindowDragState {
  start: Vec2;
  current: Vec2;
  additive: boolean;
  pointerId: number;
  purpose: WindowDragPurpose;
}

export class WindowDragController {
  private state: WindowDragState | null = null;

  constructor(private readonly viewport: HTMLElement, private readonly element: HTMLElement) {}

  get active(): WindowDragState | null { return this.state; }

  begin(point: Vec2, pointerId: number, purpose: WindowDragPurpose, additive = false): void {
    this.cancel();
    this.state = { start: { ...point }, current: { ...point }, additive, pointerId, purpose };
    this.element.style.left = `${point.x}px`;
    this.element.style.top = `${point.y}px`;
    this.element.style.width = '0px';
    this.element.style.height = '0px';
    this.element.classList.remove('crossing');
    this.element.hidden = false;
    this.viewport.setPointerCapture(pointerId);
  }

  update(point: Vec2): WindowDragState | null {
    if (!this.state) return null;
    this.state.current = { ...point };
    const left = Math.min(this.state.start.x, point.x);
    const top = Math.min(this.state.start.y, point.y);
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
    this.element.style.width = `${Math.abs(point.x - this.state.start.x)}px`;
    this.element.style.height = `${Math.abs(point.y - this.state.start.y)}px`;
    this.element.classList.toggle('crossing', this.state.purpose === 'select' && point.x < this.state.start.x);
    return this.state;
  }

  finish(pointerId: number): WindowDragState | null {
    if (!this.state || this.state.pointerId !== pointerId) return null;
    const result = this.state;
    this.state = null;
    this.element.hidden = true;
    if (this.viewport.hasPointerCapture(pointerId)) this.viewport.releasePointerCapture(pointerId);
    return result;
  }

  cancel(): void {
    if (this.state && this.viewport.hasPointerCapture(this.state.pointerId)) {
      this.viewport.releasePointerCapture(this.state.pointerId);
    }
    this.state = null;
    this.element.hidden = true;
  }
}
