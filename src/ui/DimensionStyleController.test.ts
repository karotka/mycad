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
