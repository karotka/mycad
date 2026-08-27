import { describe, expect, it, vi } from 'vitest';
import { Document } from '../../Document';
import { CommandHistory } from '../../history/CommandHistory';
import { CommandManager } from '../CommandManager';
import type { BlockDefinition } from '../../entities/types';

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

function definition(name: string, entities: BlockDefinition['entities'] = []): BlockDefinition {
  return { name, basePoint: { x: 0, y: 0 }, entities };
}

describe('PURGEBLOCKS', () => {
  it('leaves a block placed directly in the drawing alone', () => {
    const { doc, manager, log } = setup();
    const used = definition('Used');
    doc.blockDefinitions.push(used);
    doc.entities.push(doc.createInsert(used, { x: 0, y: 0 }));

    manager.startCommand('PURGEBLOCKS');

    expect(doc.blockDefinitions.map((d) => d.name)).toEqual(['Used']);
    expect(log).toHaveBeenCalledWith('PURGEBLOCKS: every block definition is reachable from the drawing.');
  });

  it('keeps a block only reachable through nesting inside a placed block', () => {
    const { doc, manager } = setup();
    const hinge = definition('Hinge');
    doc.blockDefinitions.push(hinge);
    const cabinetInsert = doc.createInsert(hinge, { x: 1, y: 1 });
    const cabinet = definition('Cabinet', [cabinetInsert]);
    doc.blockDefinitions.push(cabinet);
    doc.entities.push(doc.createInsert(cabinet, { x: 0, y: 0 }));

    manager.startCommand('PURGEBLOCKS');

    expect(doc.blockDefinitions.map((d) => d.name).sort()).toEqual(['Cabinet', 'Hinge']);
  });

  it('deletes a definition with zero placements', () => {
    const { doc, manager, log } = setup();
    doc.blockDefinitions.push(definition('Orphan'));

    manager.startCommand('PURGEBLOCKS');

    expect(doc.blockDefinitions).toEqual([]);
    expect(log).toHaveBeenCalledWith('PURGEBLOCKS: removed 1 block definition(s) not reachable from anything placed in the drawing.');
  });

  it('deletes a whole chain of blocks that only keep each other alive, including a reference cycle', () => {
    const { doc, manager } = setup();
    // A -> B -> A: neither is placed anywhere, so the cycle must not protect
    // them from purge, and must not infinite-loop the reachability walk either.
    const a = definition('A');
    const b = definition('B');
    doc.blockDefinitions.push(a, b);
    a.entities.push(doc.createInsert(b, { x: 0, y: 0 }));
    b.entities.push(doc.createInsert(a, { x: 0, y: 0 }));

    manager.startCommand('PURGEBLOCKS');

    expect(doc.blockDefinitions).toEqual([]);
  });

  it('undoes a purge back to the exact prior set of definitions', () => {
    const { doc, manager, history } = setup();
    doc.blockDefinitions.push(definition('Orphan'), definition('AlsoOrphan'));

    manager.startCommand('PURGEBLOCKS');
    expect(doc.blockDefinitions).toEqual([]);

    history.undo();
    expect(doc.blockDefinitions.map((d) => d.name).sort()).toEqual(['AlsoOrphan', 'Orphan']);
  });
});
