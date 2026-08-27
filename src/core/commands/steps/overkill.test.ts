import { describe, expect, it, vi } from 'vitest';
import { Document } from '../../Document';
import { CommandHistory } from '../../history/CommandHistory';
import { CommandManager } from '../CommandManager';

function setup() {
  const doc = new Document();
  const history = new CommandHistory(doc);
  const log = vi.fn();
  const manager = new CommandManager({
    doc, history, log,
    moveObjects: vi.fn(),
    copyWorldDelta: () => undefined,
    prompt: vi.fn(),
    getCursor: () => ({ x: 0, y: 0 }),
    redraw: vi.fn(),
  });
  return { doc, history, log, manager };
}

describe('OVERKILL', () => {
  it('removes an exact duplicate line and keeps the original', () => {
    const { doc, manager, log } = setup();
    const kept = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const duplicate = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    doc.entities.push(kept, duplicate);

    manager.startCommand('OVERKILL');

    expect(doc.entities.map((e) => e.id)).toEqual([kept.id]);
    expect(log).toHaveBeenCalledWith('OVERKILL: removed 1 duplicate object(s).');
  });

  it('treats a line drawn in the opposite direction as the same duplicate', () => {
    const { doc, manager } = setup();
    const kept = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const reversed = doc.createLine({ x: 10, y: 0 }, { x: 0, y: 0 });
    doc.entities.push(kept, reversed);

    manager.startCommand('OVERKILL');

    expect(doc.entities).toHaveLength(1);
  });

  it('does not merge geometrically identical objects on different layers', () => {
    const { doc, manager } = setup();
    const a = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const b = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    b.layer = 'other';
    doc.layers.push('other');
    doc.entities.push(a, b);

    manager.startCommand('OVERKILL');

    expect(doc.entities).toHaveLength(2);
  });

  it('keeps circles that differ only in radius', () => {
    const { doc, manager } = setup();
    doc.entities.push(doc.createCircle({ x: 0, y: 0 }, 5), doc.createCircle({ x: 0, y: 0 }, 6));

    manager.startCommand('OVERKILL');

    expect(doc.entities).toHaveLength(2);
  });

  it('removes a duplicate placed block but keeps one placed at a different point', () => {
    const { doc, manager } = setup();
    const definition = { name: 'Bolt', basePoint: { x: 0, y: 0 }, entities: [doc.createCircle({ x: 0, y: 0 }, 1)] };
    doc.entities.push(
      doc.createInsert(definition, { x: 5, y: 5 }),
      doc.createInsert(definition, { x: 5, y: 5 }),
      doc.createInsert(definition, { x: 20, y: 5 }),
    );

    manager.startCommand('OVERKILL');

    expect(doc.entities).toHaveLength(2);
  });

  it('leaves the drawing alone and says so when nothing duplicates', () => {
    const { doc, manager, log } = setup();
    doc.entities.push(doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 }));

    manager.startCommand('OVERKILL');

    expect(doc.entities).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('OVERKILL: no geometric duplicates found.');
  });

  it('undoes back to both original objects', () => {
    const { doc, manager, history } = setup();
    doc.entities.push(
      doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 }),
      doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 }),
    );

    manager.startCommand('OVERKILL');
    expect(doc.entities).toHaveLength(1);

    history.undo();
    expect(doc.entities).toHaveLength(2);
  });
});
