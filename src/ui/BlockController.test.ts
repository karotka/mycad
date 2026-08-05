// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import { CommandHistory } from '../core/history/CommandHistory';
import { BlockController } from './BlockController';
import { createBoxMesh } from '../core/geometry/PrimitiveMesh';

function setup() {
  document.body.innerHTML = `
    <button id="toggle"></button><button id="create"></button><button id="close"></button>
    <section id="panel" hidden><div id="list"></div></section><span id="count"></span>`;
  const doc = new Document();
  const history = new CommandHistory(doc);
  const callbacks = { startCreate: vi.fn(), startInsert: vi.fn(), log: vi.fn(), redraw: vi.fn() };
  const controller = new BlockController(
    doc, history,
    document.getElementById('panel')!, document.getElementById('list')!, document.getElementById('count')!,
    document.getElementById('toggle')!, document.getElementById('create')!, document.getElementById('close')!,
    callbacks,
  );
  return { doc, history, callbacks, controller };
}

function addBlock(doc: Document, name = 'Bracket') {
  const definition = {
    name, basePoint: { x: 0, y: 0 },
    entities: [doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 }), doc.createCircle({ x: 5, y: 4 }, 2)],
  };
  doc.blockDefinitions.push(definition);
  return definition;
}

describe('BlockController', () => {
  it('shows block geometry and starts insertion from its row action', () => {
    const { doc, callbacks, controller } = setup();
    addBlock(doc);
    controller.render();

    expect(document.getElementById('count')?.textContent).toBe('1');
    expect(document.querySelector('.block-thumbnail path')).not.toBeNull();
    expect(document.querySelector('.block-copy small')?.textContent).toBe('2 objects · 0 placed');
    document.querySelector<HTMLButtonElement>('.block-insert')!.click();
    expect(callbacks.startInsert).toHaveBeenCalledWith('Bracket');
  });

  it('shows a thumbnail and object count for a 3D block', () => {
    const { doc, controller } = setup();
    const solid = doc.createSolid(createBoxMesh(4, 6, 8), 'Box', 8, []);
    doc.blockDefinitions.push({ name: 'SolidPart', basePoint: { x: 0, y: 0 }, entities: [], solids: [solid] });

    controller.render();

    expect(document.querySelector('.block-thumbnail path')).not.toBeNull();
    expect(document.querySelector('.block-copy small')?.textContent).toBe('1 object · 0 placed');
  });

  it('renames a definition and every placed reference through undo history', () => {
    const { doc, history, controller } = setup();
    const definition = addBlock(doc);
    const insert = doc.createInsert(definition, { x: 20, y: 10 });
    doc.addEntity(insert);
    controller.render();

    const input = document.querySelector<HTMLInputElement>('.block-name')!;
    input.value = 'Support';
    input.dispatchEvent(new Event('change', { bubbles: true }));

    expect(doc.blockDefinitions[0].name).toBe('Support');
    expect(doc.entities[0]).toMatchObject({ type: 'insert', blockName: 'Support' });
    history.undo();
    expect(doc.blockDefinitions[0].name).toBe('Bracket');
    expect(doc.entities[0]).toMatchObject({ type: 'insert', blockName: 'Bracket' });
  });

  it('deletes only an unused definition and restores it with Undo', () => {
    const { doc, history, controller } = setup();
    addBlock(doc, 'Unused');
    controller.render();
    const remove = document.querySelector<HTMLButtonElement>('.block-delete')!;
    expect(remove.disabled).toBe(false);

    remove.click();
    expect(doc.blockDefinitions).toEqual([]);
    history.undo();
    expect(doc.blockDefinitions[0].name).toBe('Unused');
  });

  it('protects used definitions and selects all of their placed references', () => {
    const { doc, controller } = setup();
    const definition = addBlock(doc);
    doc.addEntity(doc.createInsert(definition, { x: 0, y: 0 }));
    doc.addEntity(doc.createInsert(definition, { x: 20, y: 0 }));
    controller.render();

    expect(document.querySelector<HTMLButtonElement>('.block-delete')!.disabled).toBe(true);
    document.querySelector<HTMLElement>('.block-row')!.click();
    expect(doc.getSelectedEntities()).toHaveLength(2);
  });
});
