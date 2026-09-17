// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import { CommandHistory } from '../core/history/CommandHistory';
import { LayerController } from './LayerController';

function setup() {
  document.body.innerHTML = `
    <button id="toggle"></button><button id="add"></button><button id="close"></button>
    <section id="panel" hidden><div id="list"></div></section><span id="current"></span>`;
  const doc = new Document();
  const history = new CommandHistory(doc);
  const callbacks = { log: vi.fn(), redraw: vi.fn(), objectsDeleted: vi.fn() };
  const controller = new LayerController(
    doc, history,
    document.getElementById('panel')!, document.getElementById('list')!, document.getElementById('current')!,
    document.getElementById('toggle')!, document.getElementById('add')!, document.getElementById('close')!,
    callbacks,
  );
  controller.toggle();   // open, which renders
  return { doc, controller, list: document.getElementById('list')! };
}

const colourInput = (list: HTMLElement) => list.querySelector<HTMLInputElement>('.layer-color')!;

describe('the layer panel while a colour is being picked', () => {
  it('leaves the colour input in place, so the picker it opened stays open', () => {
    const { doc, controller, list } = setup();
    const input = colourInput(list);
    input.focus();

    // What the browser sends while the colour panel is open and being used.
    input.value = '#ff0000';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // And what the document does about it: everything watching redraws, the
    // panel among them.
    controller.render();

    // The very same element, not a replacement. Rebuilding the row takes the
    // input out of the page, and the picker anchored to it closes — reported
    // as the dialog shutting the moment a number was clicked in it.
    expect(colourInput(list)).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it('applies the colour it was given all the same', () => {
    const { doc, list } = setup();
    const input = colourInput(list);
    input.focus();
    input.value = '#ff0000';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(doc.layerColors['0']).toBe(0xff0000);
  });

  it('rebuilds the row once the picking is over', () => {
    const { controller, list } = setup();
    const input = colourInput(list);
    input.focus();
    input.value = '#00ff00';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    controller.render();
    expect(colourInput(list)).not.toBe(input);
  });

  it('rebuilds as it always did when no colour is being picked', () => {
    const { controller, list } = setup();
    const input = colourInput(list);
    controller.render();
    expect(colourInput(list)).not.toBe(input);
  });
});
