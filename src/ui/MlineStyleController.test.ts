// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import { MlineStyleController } from './MlineStyleController';

function setup() {
  document.body.innerHTML = `
    <button id="toggle"></button>
    <section id="panel" hidden><div id="list"></div><button id="create"></button><button id="close"></button></section>
  `;
  const doc = new Document();
  const callbacks = { log: vi.fn() };
  const controller = new MlineStyleController(
    doc,
    document.getElementById('panel')!,
    document.getElementById('list')!,
    document.getElementById('toggle')!,
    document.getElementById('create')!,
    document.getElementById('close')!,
    callbacks,
  );
  doc.subscribe(() => controller.render());
  return { doc, callbacks, controller };
}

describe('MlineStyleController', () => {
  it('lists STANDARD, undeletable and marked current, from a fresh document', () => {
    setup();
    const items = document.querySelectorAll('.mline-style-item');
    expect(items).toHaveLength(1);
    expect(items[0].classList.contains('active')).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('.mline-style-remove')!.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('.mline-style-name')!.disabled).toBe(true);
  });

  it('creates a new style with an auto-numbered name via the + button', () => {
    const { doc } = setup();
    document.getElementById('create')!.click();
    expect(doc.mlineStyles.map((style) => style.name)).toEqual(['STANDARD', 'MLSTYLE1']);
    expect(document.querySelectorAll('.mline-style-item')).toHaveLength(2);
  });

  it('renames a custom style through double-click, but not STANDARD', () => {
    const { doc } = setup();
    const style = doc.addMlineStyle('Wall');
    const standardName = document.querySelector<HTMLInputElement>(`[data-mline-style-id="standard"] .mline-style-name`)!;
    standardName.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(standardName.readOnly).toBe(true); // STANDARD ignores the rename gesture entirely

    const name = document.querySelector<HTMLInputElement>(`[data-mline-style-id="${style.id}"] .mline-style-name`)!;
    name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(name.readOnly).toBe(false);
    name.value = 'Wall 200';
    name.dispatchEvent(new FocusEvent('blur'));

    expect(doc.mlineStyles.find((item) => item.id === style.id)?.name).toBe('Wall 200');
  });

  it('sets a style current from its dot and reflects it back onto the list', () => {
    const { doc, callbacks } = setup();
    const style = doc.addMlineStyle('Wall');
    document.querySelector<HTMLButtonElement>(`[data-mline-style-id="${style.id}"] .mline-style-activate`)!.click();

    expect(doc.currentMlineStyleId).toBe(style.id);
    expect(document.querySelector(`[data-mline-style-id="${style.id}"]`)?.classList.contains('active')).toBe(true);
    expect(document.querySelector(`[data-mline-style-id="standard"]`)?.classList.contains('active')).toBe(false);
    expect(callbacks.log).toHaveBeenCalledWith('Wall set as the current MLSTYLE.');
  });

  it('refuses to delete STANDARD or the currently active style, but deletes any other', () => {
    const { doc } = setup();
    const style = doc.addMlineStyle('Wall');

    document.querySelector<HTMLButtonElement>(`[data-mline-style-id="standard"] .mline-style-remove`)!.click();
    expect(doc.mlineStyles.some((item) => item.id === 'standard')).toBe(true);

    document.querySelector<HTMLButtonElement>(`[data-mline-style-id="${style.id}"] .mline-style-remove`)!.click();
    expect(doc.mlineStyles.some((item) => item.id === style.id)).toBe(false);
  });

  it('expands into an editable element table and edits offset/color/linetype', () => {
    const { doc } = setup();
    document.querySelector<HTMLButtonElement>(`[data-mline-style-id="standard"] .mline-style-expand`)!.click();

    const rows = document.querySelectorAll('.mline-style-element');
    expect(rows).toHaveLength(2); // STANDARD's own default two lines

    const offset = rows[0].querySelector<HTMLInputElement>('input[type="number"]')!;
    offset.value = '2';
    offset.dispatchEvent(new Event('change'));

    expect(doc.mlineStyles[0].elements[0].offset).toBe(2);
  });

  it('adds and removes elements, but never below one', () => {
    const { doc } = setup();
    document.querySelector<HTMLButtonElement>(`[data-mline-style-id="standard"] .mline-style-expand`)!.click();

    document.querySelector<HTMLButtonElement>('.mline-style-add-element')!.click();
    expect(doc.mlineStyles[0].elements).toHaveLength(3);

    document.querySelectorAll<HTMLButtonElement>('.mline-style-element button').forEach((button) => button.click());
    // Two removed, one refused (the guard kicks in once only one element is left).
    expect(doc.mlineStyles[0].elements).toHaveLength(1);
  });
});
