import type { Document } from '../core/Document';
import type { Vec2 } from '../math/geometry';
import type { Canvas2DRenderer } from '../render/Canvas2DRenderer';
import type { Viewport3D } from '../render/Viewport3D';

export interface ViewportNavigationCallbacks {
  enter3dForOrbit(): void;
  redraw(): void;
}

export class ViewportNavigationController {
  private panning = false;
  private panPointerId: number | null = null;
  private lastPointer: Vec2 = { x: 0, y: 0 };
  private panOrigin: Vec2 | null = null;
  private readonly wheel = (event: WheelEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const rect = this.viewport.getBoundingClientRect();
    const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (this.doc.viewMode === '2d') {
      if (event.metaKey) {
        if (Math.abs(event.deltaX) <= 0.01 && Math.abs(event.deltaY) <= 0.01) return;
        this.callbacks.enter3dForOrbit();
        this.renderer3d.orbitByScreenDelta(event.deltaX * 0.6, event.deltaY * 0.6);
        this.renderer3d.render();
        return;
      }
      const before = this.renderer2d.screenToWorld(cursor.x, cursor.y, rect.width, rect.height);
      const factor = Math.exp(-event.deltaY * 0.0025);
      this.renderer2d.zoom = Math.max(1e-6, Math.min(100_000, this.renderer2d.zoom * factor));
      const after = this.renderer2d.screenToWorld(cursor.x, cursor.y, rect.width, rect.height);
      this.renderer2d.pan.x += before.x - after.x;
      this.renderer2d.pan.y += before.y - after.y;
      this.callbacks.redraw();
      return;
    }
    if (event.metaKey) {
      if (Math.abs(event.deltaX) <= 0.01 && Math.abs(event.deltaY) <= 0.01) return;
      this.renderer3d.orbitByScreenDelta(event.deltaX * 0.6, event.deltaY * 0.6);
    } else if (Math.abs(event.deltaY) > 0.01) {
      this.renderer3d.zoomByWheelDelta(event.deltaY);
    }
    this.renderer3d.render();
  };

  constructor(
    private readonly doc: Document,
    private readonly viewport: HTMLElement,
    private readonly renderer2d: Canvas2DRenderer,
    private readonly renderer3d: Viewport3D,
    private readonly callbacks: ViewportNavigationCallbacks,
  ) {
    viewport.addEventListener('wheel', this.wheel, { passive: false });
  }

  get cursor(): Vec2 { return { ...this.lastPointer }; }
  get isPanning(): boolean { return this.panning; }

  /**
   * How far the pointer has travelled since the pan began. A press that pans
   * nowhere was a click, which is how the context menu is told apart from a drag.
   */
  get panDistance(): number {
    if (!this.panOrigin) return 0;
    return Math.hypot(this.lastPointer.x - this.panOrigin.x, this.lastPointer.y - this.panOrigin.y);
  }

  beginPan(point: Vec2, pointerId: number): void {
    this.panning = true;
    this.panPointerId = pointerId;
    this.lastPointer = { ...point };
    this.panOrigin = { ...point };
    this.viewport.classList.add('is-panning');
    this.viewport.setPointerCapture(pointerId);
  }

  updatePointer(point: Vec2): boolean {
    if (!this.panning) {
      this.lastPointer = { ...point };
      return false;
    }
    const dx = point.x - this.lastPointer.x;
    const dy = point.y - this.lastPointer.y;
    if (this.doc.viewMode === '2d') {
      this.renderer2d.pan.x -= dx / this.renderer2d.zoom;
      this.renderer2d.pan.y += dy / this.renderer2d.zoom;
    } else {
      this.renderer3d.panByScreenDelta(dx, dy);
    }
    this.lastPointer = { ...point };
    this.callbacks.redraw();
    return true;
  }

  endPan(pointerId: number): boolean {
    if (!this.panning || this.panPointerId !== pointerId) return false;
    this.panning = false;
    this.panPointerId = null;
    this.viewport.classList.remove('is-panning');
    if (this.viewport.hasPointerCapture(pointerId)) this.viewport.releasePointerCapture(pointerId);
    return true;
  }

  cancel(): void {
    if (this.panPointerId !== null && this.viewport.hasPointerCapture(this.panPointerId)) {
      this.viewport.releasePointerCapture(this.panPointerId);
    }
    this.panning = false;
    this.panPointerId = null;
    this.viewport.classList.remove('is-panning');
  }

  dispose(): void {
    this.cancel();
    this.viewport.removeEventListener('wheel', this.wheel);
  }
}
