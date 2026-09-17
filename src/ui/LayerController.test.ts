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
  /** Opening the picker is a click on the swatch. */
  function openPicker(list: HTMLElement) {
    const input = colourInput(list);
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return input;
  }

  it('leaves the colour input alone, so the picker anchored to it stays open', () => {
    const { controller, list } = setup();
    const input = openPicker(list);

    // What the browser sends while the picker is open and being used. Chromium
    // sends `change` here too, not only when the picker closes — acting on it
    // is what shut the picker on the first attempt at this.
    input.value = '#ff0000';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    controller.render();

    // The very same element, never taken out of the page: rebuilding the row
    // and putting the element back detaches it just as surely, and the picker
    // goes with it either way.
    expect(colourInput(list)).toBe(input);
  });

  it('applies each colour it is given while the picker is open', () => {
    const { doc, list } = setup();
    const input = openPicker(list);
    for (const [hex, value] of [['#ff0000', 0xff0000], ['#00ff00', 0x00ff00]] as const) {
      input.value = hex;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(doc.layerColors['0']).toBe(value);
    }
  });

  it('takes a press somewhere else as the picker being done with', () => {
    const { controller, list } = setup();
    const input = openPicker(list);
    input.value = '#00ff00';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // A press anywhere but the swatch: the one signal that cannot come from
    // inside the picker itself.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

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
