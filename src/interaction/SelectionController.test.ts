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
});
