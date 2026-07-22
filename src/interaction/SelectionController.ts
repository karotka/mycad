import type { Document } from '../core/Document';
import type { Entity } from '../core/entities/types';
import type { Canvas2DRenderer } from '../render/Canvas2DRenderer';
import type { Viewport3D } from '../render/Viewport3D';
import { applyProjectedWindowSelection, applyWindowSelection } from './PickingService';
import type { WindowDragController, WindowDragPurpose } from './WindowDragController';

export interface SelectionControllerCallbacks {
  viewportSize(): { width: number; height: number };
  selectionChanged(): void;
  zoomFinished(): void;
  redraw(): void;
}

export class SelectionController {
  constructor(
    private readonly doc: Document,
    private readonly viewport: HTMLElement,
    private readonly renderer2d: Canvas2DRenderer,
    private readonly renderer3d: Viewport3D,
    private readonly windowDrag: WindowDragController,
    private readonly callbacks: SelectionControllerCallbacks,
  ) {}

  selectHit(entity: Entity | null | undefined, solidId: string | null | undefined, additive: boolean): boolean {
    if (entity) {
      this.doc.selectEntity(entity.id, additive);
      this.callbacks.selectionChanged();
      return true;
    }
    if (solidId) {
      this.doc.selectSolid(solidId, additive);
      this.callbacks.selectionChanged();
      return true;
    }
    return false;
  }

  beginWindow(event: Pick<PointerEvent, 'clientX' | 'clientY' | 'pointerId' | 'shiftKey'>, purpose: WindowDragPurpose): void {
    const rect = this.viewport.getBoundingClientRect();
    this.windowDrag.begin(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      event.pointerId,
      purpose,
      // Ordinary picking is cumulative in both views. Escape is the one clear
      // selection action, so a selection window follows the same rule.
      purpose === 'select' ? true : event.shiftKey,
    );
  }

  finishWindow(pointerId: number): boolean {
    const selection = this.windowDrag.finish(pointerId);
    if (!selection) return false;
    const moved = Math.hypot(selection.current.x - selection.start.x, selection.current.y - selection.start.y);
    const { width, height } = this.callbacks.viewportSize();
    if (selection.purpose === 'zoom') {
      if (moved >= 4) {
        if (this.doc.viewMode === '2d') {
          const a = this.renderer2d.screenToWorld(selection.start.x, selection.start.y, width, height);
          const b = this.renderer2d.screenToWorld(selection.current.x, selection.current.y, width, height);
          this.renderer2d.zoomWindow(a, b, width, height);
        } else {
          this.renderer3d.zoomScreenWindow(selection.start.x, selection.start.y, selection.current.x, selection.current.y, width, height);
        }
      }
      this.callbacks.zoomFinished();
      this.callbacks.redraw();
      return true;
    }
    if (moved >= 4) {
      const crossing = selection.current.x < selection.start.x;
      if (this.doc.viewMode === '2d') {
        const a = this.renderer2d.screenToWorld(selection.start.x, selection.start.y, width, height);
        const b = this.renderer2d.screenToWorld(selection.current.x, selection.current.y, width, height);
        const box = { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) };
        applyWindowSelection(this.doc, box, crossing, selection.additive);
      } else {
        const box = {
          minX: Math.min(selection.start.x, selection.current.x),
          maxX: Math.max(selection.start.x, selection.current.x),
          minY: Math.min(selection.start.y, selection.current.y),
          maxY: Math.max(selection.start.y, selection.current.y),
        };
        const canvas = this.renderer3d.renderer.domElement;
        applyProjectedWindowSelection(this.doc, box, crossing, selection.additive, (point) =>
          this.renderer3d.projectCadPoint(canvas, point));
      }
    }
    this.callbacks.selectionChanged();
    this.callbacks.redraw();
    return true;
  }
}
