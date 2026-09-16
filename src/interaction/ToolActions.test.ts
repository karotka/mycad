import { describe, expect, it, vi } from 'vitest';
import { createToolActions, type ToolActionsContext } from './ToolActions';
import { Document } from '../core/Document';
import { CommandHistory } from '../core/history/CommandHistory';
import type { SolidMesh } from '../core/entities/types';

/** Only what deleting the selection actually reaches for; the rest of the
 *  context belongs to the other actions in this module. */
function actionsFor(doc: Document) {
  const history = new CommandHistory(doc);
  const log = vi.fn();
  const context = {
    doc, history, log,
    redraw: vi.fn(),
    size: () => ({ width: 800, height: 600 }),
    gripInteraction: { cancel: vi.fn() },
    gripController: { mode: null, hoveredGrip: -1 },
    previewController: { clearPreview: vi.fn() },
    renderer2d: { zoomExtents: vi.fn() },
    renderer3d: { frameContent: vi.fn() },
  } as unknown as ToolActionsContext;
  return { actions: createToolActions(context), history, log };
}

function mesh(): SolidMesh {
  return { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
}

describe('deleting the selection', () => {
  it('deletes a selected surface, and undo brings it back', () => {
    const doc = new Document();
    const surface = doc.createSurface(mesh(), 'Surface', [], undefined, { kind: 'mesh' });
    doc.addSurface(surface);
    doc.selectSurface(surface.id);
    const { actions, history, log } = actionsFor(doc);

    // Reported after SLICE: the off-cut was selected and Delete did nothing.
    expect(actions.deleteSelectedObjects()).toBe(true);
    expect(doc.surfaces).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('Deleted objects: 1');
    expect(history.undo()).toBe(true);
    expect(doc.surfaces).toHaveLength(1);
  });

  it('deletes entities and surfaces together', () => {
    const doc = new Document();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 });
    doc.addEntity(line);
    const surface = doc.createSurface(mesh(), 'Surface', [], undefined, { kind: 'mesh' });
    doc.addSurface(surface);
    doc.selectEntity(line.id);
    doc.selectSurface(surface.id, true);
    const { actions, log } = actionsFor(doc);

    expect(actions.deleteSelectedObjects()).toBe(true);
    expect(doc.entities).toHaveLength(0);
    expect(doc.surfaces).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('Deleted objects: 2');
  });

  it('says there was nothing to delete when nothing is selected', () => {
    const doc = new Document();
    doc.addSurface(doc.createSurface(mesh(), 'Surface', [], undefined, { kind: 'mesh' }));
    const { actions } = actionsFor(doc);

    expect(actions.deleteSelectedObjects()).toBe(false);
    expect(doc.surfaces).toHaveLength(1);
  });
});

describe('copying and pasting the selection', () => {
  it('carries a surface through the clipboard, as a fresh copy', () => {
    const doc = new Document();
    const surface = doc.createSurface(mesh(), 'Surface', [], undefined, { kind: 'mesh' });
    doc.addSurface(surface);
    doc.selectSurface(surface.id);
    const { actions, log } = actionsFor(doc);

    expect(actions.copySelectedObjects()).toBe(true);
    expect(actions.pasteClipboard()).toBe(true);
    expect(doc.surfaces).toHaveLength(2);
    // A paste is a new object, not the same one twice.
    expect(doc.surfaces[1].id).not.toBe(surface.id);
    expect(log).toHaveBeenCalledWith('Pasted objects: 1');
  });
});
