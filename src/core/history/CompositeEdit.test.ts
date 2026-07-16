import { describe, expect, it } from 'vitest';
import { Document } from '../Document';
import { CommandHistory } from './CommandHistory';
import { CompositeEdit, UpdateEntityEdit } from './edits';
import { cloneEntity, transformEntityPoints } from '../entities/types';

const setup = () => {
  const doc = new Document();
  const history = new CommandHistory(doc);
  const lines = [0, 1, 2].map((index) => {
    const line = doc.createLine({ x: index * 10, y: 0 }, { x: index * 10 + 5, y: 0 });
    doc.addEntity(line);
    return line;
  });
  return { doc, history, lines };
};

const moved = (doc: Document, id: string) => doc.getEntity(id);

describe('CompositeEdit', () => {
  // Moving three objects is one thing the user did, so one Undo must put all
  // three back — not one of them, three times.
  it('undoes every edit it holds in a single step', () => {
    const { doc, history, lines } = setup();
    const edits = lines.map((line) =>
      new UpdateEntityEdit('Move object', cloneEntity(line), transformEntityPoints(line, (p) => ({ x: p.x + 100, y: p.y }))));
    history.execute(new CompositeEdit('Move objects', edits));

    for (const line of lines) expect(moved(doc, line.id)).toMatchObject({ start: { x: line.start.x + 100 } });

    expect(history.undo()).toBe(true);
    for (const line of lines) expect(moved(doc, line.id)).toMatchObject({ start: { x: line.start.x } });
    // One step, so there is nothing left to undo.
    expect(history.undo()).toBe(false);
  });

  it('redoes them all again', () => {
    const { doc, history, lines } = setup();
    history.execute(new CompositeEdit('Move objects', lines.map((line) =>
      new UpdateEntityEdit('Move object', cloneEntity(line), transformEntityPoints(line, (p) => ({ x: p.x, y: p.y + 7 }))))));
    history.undo();
    expect(history.redo()).toBe(true);
    for (const line of lines) expect(moved(doc, line.id)).toMatchObject({ start: { y: 7 } });
  });

  // A later edit may rest on what an earlier one did, so undoing runs backwards.
  it('reverts in the reverse of the order it applied', () => {
    const order: string[] = [];
    const step = (name: string) => ({
      label: name,
      apply: () => order.push(`apply ${name}`),
      revert: () => order.push(`revert ${name}`),
    });
    const composite = new CompositeEdit('Three', [step('a'), step('b'), step('c')]);
    const doc = new Document();
    composite.apply(doc);
    composite.revert(doc);
    expect(order).toEqual(['apply a', 'apply b', 'apply c', 'revert c', 'revert b', 'revert a']);
  });

  it('keeps the objects where they were in the drawing order', () => {
    const { doc, history, lines } = setup();
    const before = doc.entities.map((entity) => entity.id);
    history.execute(new CompositeEdit('Move objects', [
      new UpdateEntityEdit('Move object', cloneEntity(lines[0]), transformEntityPoints(lines[0], (p) => ({ x: p.x + 1, y: p.y }))),
    ]));
    // Replacing in place, so a moved object does not jump to the front.
    expect(doc.entities.map((entity) => entity.id)).toEqual(before);
  });
});
