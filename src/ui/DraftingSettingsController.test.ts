import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import { DraftingSettingsController, formatAngles, parseAngles } from './DraftingSettingsController';

function field(id: string) {
  return { id, value: '', addEventListener: vi.fn() } as unknown as HTMLInputElement;
}

function setup() {
  const doc = new Document();
  const fields = new Map<string, HTMLInputElement>([
    ['drafting-snap-size', field('drafting-snap-size')],
    ['drafting-grid-size', field('drafting-grid-size')],
    ['drafting-polar-angles', field('drafting-polar-angles')],
  ]);
  let onInput = (): void => {};
  const form = {
    querySelector: (selector: string) => fields.get(selector.slice(1)) ?? null,
    addEventListener: (_type: string, listener: () => void) => { onInput = listener; },
  } as unknown as HTMLFormElement;
  const panel = { hidden: true } as HTMLElement;
  const toggle = { addEventListener: vi.fn() } as unknown as HTMLElement;
  const close = { addEventListener: vi.fn() } as unknown as HTMLElement;
  const changed = vi.fn();
  const controller = new DraftingSettingsController(doc, panel, form, toggle, close, changed);
  return { doc, controller, fields, changed, type: (id: string, value: string) => { fields.get(id)!.value = value; onInput(); } };
}

describe('parseAngles', () => {
  it('reads a list however it is separated', () => {
    expect(parseAngles('30, 45, 90')).toEqual([30, 45, 90]);
    expect(parseAngles('30 45 90')).toEqual([30, 45, 90]);
    expect(parseAngles('30;45;90')).toEqual([30, 45, 90]);
  });

  it('sorts and de-duplicates, so the list reads back tidily', () => {
    expect(parseAngles('90, 30, 45, 30')).toEqual([30, 45, 90]);
  });

  it('drops what cannot be an angle', () => {
    expect(parseAngles('30, abc, 45')).toEqual([30, 45]);
    expect(parseAngles('0, 30, 360, 400, -15')).toEqual([30]);
  });

  it('reads back what it wrote', () => {
    expect(parseAngles(formatAngles([30, 45, 90]))).toEqual([30, 45, 90]);
  });
});

describe('DraftingSettingsController', () => {
  it('shows the values the document holds', () => {
    const { doc, controller, fields } = setup();
    doc.snapSize = 2.5;
    doc.gridSize = 10;
    doc.drafting.polarAngles = [15, 30];
    controller.render();
    expect(fields.get('drafting-snap-size')!.value).toBe('2.5');
    expect(fields.get('drafting-grid-size')!.value).toBe('10');
    expect(fields.get('drafting-polar-angles')!.value).toBe('15, 30');
  });

  it('writes the snap step and grid spacing back as they are typed', () => {
    const { doc, type, changed } = setup();
    type('drafting-snap-size', '0.25');
    expect(doc.snapSize).toBe(0.25);
    type('drafting-grid-size', '5');
    expect(doc.gridSize).toBe(5);
    expect(changed).toHaveBeenCalled();
  });

  it('keeps the last good value while a field is mid-edit', () => {
    const { doc, type } = setup();
    type('drafting-snap-size', '0.25');
    // Clearing the field, or typing a minus, must not set the step to zero.
    type('drafting-snap-size', '');
    expect(doc.snapSize).toBe(0.25);
    type('drafting-snap-size', '-3');
    expect(doc.snapSize).toBe(0.25);
  });

  // An empty list would leave polar tracking with only the four quadrants,
  // which looks like it broke rather than like it was cleared.
  it('keeps the last good polar angles rather than emptying them', () => {
    const { doc, type } = setup();
    type('drafting-polar-angles', '15, 75');
    expect(doc.drafting.polarAngles).toEqual([15, 75]);
    type('drafting-polar-angles', '');
    expect(doc.drafting.polarAngles).toEqual([15, 75]);
  });

  it('opens and closes, and reads the document each time it opens', () => {
    const { doc, controller, fields } = setup();
    expect(controller.isOpen).toBe(false);
    doc.snapSize = 3;
    controller.toggle();
    expect(controller.isOpen).toBe(true);
    expect(fields.get('drafting-snap-size')!.value).toBe('3');
    controller.toggle();
    expect(controller.isOpen).toBe(false);
  });
});
