import { describe, expect, it } from 'vitest';
import { Document } from '../../Document';
import { CommandHistory } from '../../history/CommandHistory';
import { changeToCurrentLayer, hideSelectedObjects, isolateSelectedObjects, showAllObjects } from './objectVisibility';
import type { CommandContext } from '../types';

const makeContext = (doc: Document): CommandContext => ({
  doc,
  history: new CommandHistory(doc),
  log: () => {}, prompt: () => {}, redraw: () => {},
  getCursor: () => ({ x: 0, y: 0 }),
  moveObjects: () => {}, copyWorldDelta: () => undefined,
});

const twoLines = (doc: Document) => {
  const a = doc.createLine({ x: 0, y: 0 }, { x: 5, y: 0 }); doc.addEntity(a);
  const b = doc.createLine({ x: 0, y: 1 }, { x: 5, y: 1 }); doc.addEntity(b);
  return { a, b };
};

describe('object visibility', () => {
  it('hides the selected objects and Show All restores them', () => {
    const doc = new Document();
    const { a, b } = twoLines(doc);
    doc.selectEntity(a.id);
    const ctx = makeContext(doc);

    hideSelectedObjects(ctx);
    expect(doc.hiddenObjects.has(a.id)).toBe(true);
    expect(doc.hiddenObjects.has(b.id)).toBe(false);

    showAllObjects(ctx);
    expect(doc.hiddenObjects.size).toBe(0);
  });

  it('isolate hides everything except the selection', () => {
    const doc = new Document();
    const { a, b } = twoLines(doc);
    doc.selectEntity(a.id);

    isolateSelectedObjects(makeContext(doc));

    expect(doc.hiddenObjects.has(b.id)).toBe(true);
    expect(doc.hiddenObjects.has(a.id)).toBe(false);
  });

  it('does nothing without a selection', () => {
    const doc = new Document();
    twoLines(doc);
    hideSelectedObjects(makeContext(doc));
    expect(doc.hiddenObjects.size).toBe(0);
  });
});

describe('change to current layer', () => {
  it('moves the selection to the current layer and undoes cleanly', () => {
    const doc = new Document();
    doc.layers.push('walls');
    const { a } = twoLines(doc); // created on layer '0'
    doc.currentLayer = 'walls';
    doc.selectEntity(a.id);
    const ctx = makeContext(doc);

    changeToCurrentLayer(ctx);
    expect(doc.getEntity(a.id)?.layer).toBe('walls');

    expect(ctx.history.undo()).toBe(true);
    expect(doc.getEntity(a.id)?.layer).toBe('0');
  });
});
