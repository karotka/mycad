import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import type { LineEntity } from '../core/entities/types';
import type { Canvas2DRenderer } from '../render/Canvas2DRenderer';
import type { Viewport3D } from '../render/Viewport3D';
import type { WindowDragController } from './WindowDragController';
import { SelectionController } from './SelectionController';

function line(id: string): LineEntity {
  return { id, type: 'line', layer: '0', color: 0xffffff, selected: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } };
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
});
