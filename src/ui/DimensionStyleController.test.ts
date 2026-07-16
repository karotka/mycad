import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import { DimensionStyleController } from './DimensionStyleController';

describe('DimensionStyleController', () => {
  it('validates and applies dimension style values', () => {
    const doc = new Document();
    const updated = doc.createDimension({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 4 });
    const untouched = doc.createDimension({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 2, y: 3 });
    untouched.layer = 'notes';
    doc.entities.push(updated, untouched);
    const values: Record<string, { value: string }> = {
      'dimension-text-height': { value: '4' }, 'dimension-arrow-size': { value: '3' },
      'dimension-arrow-type': { value: 'open' }, 'dimension-extension-beyond': { value: '1.5' },
      'dimension-extension-offset': { value: '0.75' }, 'dimension-text-offset': { value: '1.25' }, 'dimension-precision': { value: '3' },
      'dimension-scale': { value: '2' }, 'dimension-layer': { value: 'dims' },
    };
    const panel = { hidden: true } as HTMLElement;
    const form = { addEventListener: vi.fn(), querySelector: vi.fn((selector: string) => values[selector.slice(1)]) } as unknown as HTMLFormElement;
    const element = { addEventListener: vi.fn() } as unknown as HTMLElement;
    const controller = new DimensionStyleController(doc, panel, form, element, element, vi.fn());

    (controller as unknown as { apply(): void }).apply();
    expect(doc.dimensionStyle).toEqual({ textHeight: 4, arrowSize: 3, arrowType: 'open', extensionBeyond: 1.5, extensionOffset: 0.75, textOffset: 1.25, precision: 3, scale: 2, layer: 'dims' });
    expect(updated).toMatchObject({ textHeight: 4, arrowSize: 3, arrowType: 'open', extensionBeyond: 1.5, extensionOffset: 0.75, textOffset: 1.25, precision: 3, scale: 2 });
    expect(untouched).toMatchObject({ textHeight: 2.5, arrowType: 'closed', layer: 'notes' });
  });
});

describe('typing into an open dimension style panel', () => {
  function setup() {
    const doc = new Document();
    const ids = [
      'dimension-text-height', 'dimension-arrow-size', 'dimension-arrow-type', 'dimension-extension-beyond',
      'dimension-extension-offset', 'dimension-text-offset', 'dimension-precision', 'dimension-scale',
    ];
    const fields = new Map(ids.map((id) => [id, { value: '' } as HTMLInputElement]));
    // The layer field is a select the panel rebuilds when it renders.
    fields.set('dimension-layer', { value: 'dims', replaceChildren: vi.fn() } as unknown as HTMLInputElement);
    let onInput = (): void => {};
    const form = {
      querySelector: (selector: string) => fields.get(selector.slice(1)) ?? null,
      addEventListener: (_type: string, listener: () => void) => { onInput = listener; },
    } as unknown as HTMLFormElement;
    const panel = { hidden: true } as HTMLElement;
    const element = { addEventListener: vi.fn() } as unknown as HTMLElement;
    // render() rebuilds the layer select, which is the only DOM it needs.
    vi.stubGlobal('document', { createElement: () => ({ value: '', textContent: '' }) });
    const controller = new DimensionStyleController(doc, panel, form, element, element, vi.fn());
    doc.subscribe(() => { if (controller.isOpen) controller.render(); });
    controller.toggle();
    return { doc, fields, type: (id: string, value: string) => { fields.get(id)!.value = value; onInput(); } };
  }

  // The same round trip as the drafting panel: apply notifies, the notification
  // renders, and render put the last good value back into the box being typed.
  it('leaves a box alone while it is being cleared and retyped', () => {
    const { doc, fields, type } = setup();
    const height = fields.get('dimension-text-height')!;
    expect(height.value).toBe('2.5');

    type('dimension-text-height', '');
    expect(height.value, 'the panel typed over an empty box').toBe('');
    expect(doc.dimensionStyle.textHeight).toBe(2.5);

    type('dimension-text-height', '4');
    expect(height.value).toBe('4');
    expect(doc.dimensionStyle.textHeight).toBe(4);
  });

  it('still follows a change made outside it', () => {
    const { doc, fields } = setup();
    doc.dimensionStyle = { ...doc.dimensionStyle, textHeight: 9 };
    doc.notify();
    expect(fields.get('dimension-text-height')!.value).toBe('9');
  });
});
