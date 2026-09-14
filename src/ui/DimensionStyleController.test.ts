import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import { DimensionStyleController } from './DimensionStyleController';

describe('DimensionStyleController', () => {
  it('validates and applies dimension style values', () => {
    const doc = new Document();
    const onStyleLayer = doc.createDimension({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 4 });
    // A dimension on some other layer — how a drawing whose dimensions were put
    // on a layer of the drafter's own naming looks. It follows the style too:
    // a drawing has one dimension style, and a setting that reached only the
    // style's own layer changed nothing anyone could see.
    const onAnotherLayer = doc.createDimension({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 2, y: 3 });
    onAnotherLayer.layer = 'notes';
    doc.entities.push(onStyleLayer, onAnotherLayer);
    const values: Record<string, { value: string }> = {
      'dimension-text-height': { value: '4' }, 'dimension-arrow-size': { value: '3' },
      'dimension-arrow-type': { value: 'open' }, 'dimension-extension-beyond': { value: '1.5' },
      'dimension-extension-offset': { value: '0.75' }, 'dimension-text-offset': { value: '1.25' }, 'dimension-precision': { value: '3' },
      'dimension-angular-precision': { value: '1' }, 'dimension-unit-suffix': { value: 'mm' },
      'dimension-scale': { value: '2' }, 'dimension-layer': { value: 'dims' },
    };
    const form = { addEventListener: vi.fn(), querySelector: vi.fn((selector: string) => values[selector.slice(1)]) } as unknown as HTMLFormElement;
    const controller = new DimensionStyleController(doc, form, vi.fn());

    (controller as unknown as { apply(): void }).apply();
    expect(doc.dimensionStyle).toEqual({ textHeight: 4, arrowSize: 3, arrowType: 'open', extensionBeyond: 1.5, extensionOffset: 0.75, textOffset: 1.25, precision: 3, angularPrecision: 1, unitSuffix: 'mm', scale: 2, layer: 'dims' });
    const styled = { textHeight: 4, arrowSize: 3, arrowType: 'open', extensionBeyond: 1.5, extensionOffset: 0.75, textOffset: 1.25, precision: 3, angularPrecision: 1, unitSuffix: 'mm', scale: 2 };
    expect(onStyleLayer).toMatchObject(styled);
    expect(onAnotherLayer).toMatchObject(styled);
    // The style's layer says where a NEW dimension is put; it does not move
    // the ones already drawn.
    expect(onAnotherLayer.layer).toBe('notes');
  });
});

describe('typing into an open dimension style panel', () => {
  function setup() {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    const doc = new Document();
    const ids = [
      'dimension-text-height', 'dimension-arrow-size', 'dimension-arrow-type', 'dimension-extension-beyond',
      'dimension-extension-offset', 'dimension-text-offset', 'dimension-precision', 'dimension-angular-precision',
      'dimension-unit-suffix', 'dimension-scale',
    ];
    const fields = new Map(ids.map((id) => [id, { value: '' } as HTMLInputElement]));
    // The layer field is a select the panel rebuilds when it renders.
    fields.set('dimension-layer', { value: 'dims', replaceChildren: vi.fn() } as unknown as HTMLInputElement);
    let onInput = (): void => {};
    const form = {
      querySelector: (selector: string) => fields.get(selector.slice(1)) ?? null,
      addEventListener: (_type: string, listener: () => void) => { onInput = listener; },
    } as unknown as HTMLFormElement;
    // render() rebuilds the layer select, which is the only DOM it needs.
    vi.stubGlobal('document', { createElement: () => ({ value: '', textContent: '' }) });
    const controller = new DimensionStyleController(doc, form, vi.fn());
    doc.subscribe(() => controller.render());
    controller.render();
    return { doc, fields, store, type: (id: string, value: string) => { fields.get(id)!.value = value; onInput(); } };
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

  it('remembers a changed style as the global default for the next new project', () => {
    const { store, type } = setup();
    type('dimension-text-height', '4');
    const saved = JSON.parse(store.get('mycad.defaults.dimensionStyle')!);
    expect(saved.textHeight).toBe(4);
  });
});

describe('the setting reaching the drawing', () => {
  /** The reported case, in miniature: a house plan saved with a style of
   *  textHeight 200 whose 140 dimensions all sat at 2.5 on a layer called
   *  "koty". The style was in the file and read back correctly — it simply
   *  never reached the dimensions. */
  it('brings dimensions saved at another size up to the drawing\'s style', () => {
    const doc = new Document();
    doc.dimensionStyle = { ...doc.dimensionStyle, textHeight: 200, arrowSize: 200, layer: 'dims' };
    const drawn = Array.from({ length: 3 }, () => {
      const dimension = doc.createDimension({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 4 });
      dimension.layer = 'koty';
      dimension.textHeight = 2.5;
      dimension.arrowSize = 2.5;
      doc.entities.push(dimension);
      return dimension;
    });
    const values: Record<string, { value: string }> = {
      'dimension-text-height': { value: '200' }, 'dimension-arrow-size': { value: '200' },
      'dimension-arrow-type': { value: 'tick' }, 'dimension-extension-beyond': { value: '100' },
      'dimension-extension-offset': { value: '50' }, 'dimension-text-offset': { value: '10' },
      'dimension-precision': { value: '0' }, 'dimension-angular-precision': { value: '1' },
      'dimension-unit-suffix': { value: 'none' }, 'dimension-scale': { value: '1' },
      'dimension-layer': { value: 'dims' },
    };
    const form = { addEventListener: vi.fn(), querySelector: vi.fn((selector: string) => values[selector.slice(1)]) } as unknown as HTMLFormElement;
    const controller = new DimensionStyleController(doc, form, vi.fn());

    (controller as unknown as { apply(): void }).apply();

    for (const dimension of drawn) {
      expect(dimension.textHeight).toBe(200);
      expect(dimension.arrowSize).toBe(200);
      expect(dimension.arrowType).toBe('tick');
      expect(dimension.layer).toBe('koty');
    }
  });
});

describe('Apply style to all', () => {
  it('syncs a drawing whose dimensions never followed its own saved style', () => {
    // Nothing in the panel needs changing here — the style already says 200.
    // That is exactly why editing a value cannot be the only way to apply it.
    const doc = new Document();
    doc.dimensionStyle = { ...doc.dimensionStyle, textHeight: 200, arrowSize: 200, arrowType: 'tick' };
    const stale = doc.createDimension({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 4 });
    stale.layer = 'koty';
    stale.textHeight = 2.5;
    stale.arrowSize = 2.5;
    stale.arrowType = 'closed';
    doc.entities.push(stale);
    const form = { addEventListener: vi.fn(), querySelector: vi.fn(() => null) } as unknown as HTMLFormElement;
    const changed = vi.fn();
    const controller = new DimensionStyleController(doc, form, changed);

    expect(controller.applyToAllDimensions()).toBe(1);

    expect(stale).toMatchObject({ textHeight: 200, arrowSize: 200, arrowType: 'tick', layer: 'koty' });
    expect(changed).toHaveBeenCalled();
  });

  it('leaves everything that is not a dimension alone', () => {
    const doc = new Document();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 });
    doc.entities.push(line);
    const form = { addEventListener: vi.fn(), querySelector: vi.fn(() => null) } as unknown as HTMLFormElement;

    expect(new DimensionStyleController(doc, form, vi.fn()).applyToAllDimensions()).toBe(0);
    expect(line).not.toHaveProperty('textHeight');
  });
});
