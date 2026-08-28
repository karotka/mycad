import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import type { LineEntity } from '../core/entities/types';
import type { Canvas2DRenderer } from '../render/Canvas2DRenderer';
import type { Viewport3D } from '../render/Viewport3D';
import type { WindowDragController } from './WindowDragController';
import { SelectionController } from './SelectionController';

function line(id: string): LineEntity {
  return { id, type: 'line', layer: '0', aci: 256, color: 0xffffff, selected: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } };
}

describe('SelectionController', () => {
  it('applies replacement and additive entity selection consistently', () => {
    const doc = new Document();
    doc.entities = [line('a'), line('b')];
    const selectionChanged = vi.fn();
    const controller = new SelectionController(
      doc,
      {} as HTMLElement,
      {} as Canvas2DRenderer,
      {} as Viewport3D,
      {} as WindowDragController,
      { viewportSize: () => ({ width: 100, height: 100 }), selectionChanged, zoomFinished: vi.fn(), redraw: vi.fn() },
    );

    expect(controller.selectHit(doc.entities[0], null, false)).toBe(true);
    expect([...doc.selectedEntityIds]).toEqual(['a']);
    controller.selectHit(doc.entities[1], null, true);
    expect([...doc.selectedEntityIds]).toEqual(['a', 'b']);
    expect(selectionChanged).toHaveBeenCalledTimes(2);
  });

  it('finishes a 3D selection window in projected screen space', () => {
    const doc = new Document();
    doc.viewMode = '3d';
    doc.entities = [line('inside')];
    const renderer2d = { screenToWorld: vi.fn() } as unknown as Canvas2DRenderer;
    const renderer3d = {
      renderer: { domElement: {} },
      projectCadPoint: (_canvas: HTMLCanvasElement, point: { x: number; y: number }) => ({ x: point.x, y: point.y }),
    } as unknown as Viewport3D;
    const windowDrag = {
      finish: () => ({
        start: { x: -1, y: -1 }, current: { x: 12, y: 12 }, additive: true, pointerId: 4, purpose: 'select' as const,
      }),
    } as unknown as WindowDragController;
    const controller = new SelectionController(
      doc, {} as HTMLElement, renderer2d, renderer3d, windowDrag,
      { viewportSize: () => ({ width: 100, height: 100 }), selectionChanged: vi.fn(), zoomFinished: vi.fn(), redraw: vi.fn() },
    );

    expect(controller.finishWindow(4)).toBe(true);
    expect([...doc.selectedEntityIds]).toEqual(['inside']);
    expect(renderer2d.screenToWorld).not.toHaveBeenCalled();
  });

  it('selects whatever was under a press that never moved far enough to be a drag', () => {
    // Starting a window drag from directly on top of an object — the only way
    // to let one begin there instead of just from empty space — must still
    // land as an ordinary click-select when the press turns out to not have
    // moved, rather than silently doing nothing.
    const doc = new Document();
    doc.entities = [line('under-the-press')];
    const windowDrag = {
      finish: () => ({
        start: { x: 50, y: 50 }, current: { x: 51, y: 51 }, additive: true, pointerId: 7, purpose: 'select' as const,
        clickFallback: { entity: doc.entities[0], solidId: null },
      }),
    } as unknown as WindowDragController;
    const controller = new SelectionController(
      doc, {} as HTMLElement, {} as Canvas2DRenderer, {} as Viewport3D, windowDrag,
      { viewportSize: () => ({ width: 100, height: 100 }), selectionChanged: vi.fn(), zoomFinished: vi.fn(), redraw: vi.fn() },
    );

    expect(controller.finishWindow(7)).toBe(true);
    expect([...doc.selectedEntityIds]).toEqual(['under-the-press']);
  });

  it('ignores the click fallback once the press moved enough to be a real selection window', () => {
    const doc = new Document();
    doc.entities = [line('under-the-press'), line('inside-the-window')];
    doc.entities[1] = { ...doc.entities[1], start: { x: 60, y: 60 }, end: { x: 70, y: 60 } } as LineEntity;
    const renderer2d = {
      screenToWorld: (x: number, y: number) => ({ x, y }),
    } as unknown as Canvas2DRenderer;
    const windowDrag = {
      finish: () => ({
        start: { x: 55, y: 55 }, current: { x: 75, y: 65 }, additive: true, pointerId: 9, purpose: 'select' as const,
        clickFallback: { entity: doc.entities[0], solidId: null },
      }),
    } as unknown as WindowDragController;
    const controller = new SelectionController(
      doc, {} as HTMLElement, renderer2d, {} as Viewport3D, windowDrag,
      { viewportSize: () => ({ width: 100, height: 100 }), selectionChanged: vi.fn(), zoomFinished: vi.fn(), redraw: vi.fn() },
    );

    expect(controller.finishWindow(9)).toBe(true);
    expect([...doc.selectedEntityIds]).toEqual(['inside-the-window']);
  });
});
