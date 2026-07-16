import { describe, expect, it } from 'vitest';
import { dimensionGeometry, type DimensionEntity } from './types';

describe('dimensionGeometry', () => {
  it('creates an aligned dimension line at the selected offset', () => {
    const entity: DimensionEntity = {
      id: 'dim', type: 'dimension', dimensionKind: 'aligned', layer: '0', color: 0xffffff, selected: false,
      start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, offset: { x: 4, y: 5 },
      textHeight: 2.5, arrowSize: 2, arrowType: 'closed', extensionBeyond: 1.25, extensionOffset: 0.625, textOffset: 0.625, precision: 2, scale: 1,
    };
    const geometry = dimensionGeometry(entity);
    expect(geometry.dimensionLine).toEqual([{ x: 0, y: 5 }, { x: 10, y: 5 }]);
    expect(geometry.text).toBe('10.00');
  });

  it('offsets text perpendicular to a vertical dimension line', () => {
    const entity: DimensionEntity = {
      id: 'vertical', type: 'dimension', dimensionKind: 'aligned', layer: 'dims', color: 0xffffff, selected: false,
      start: { x: 0, y: 0 }, end: { x: 0, y: 10 }, offset: { x: -4, y: 5 },
      textHeight: 2.5, arrowSize: 2, arrowType: 'closed', extensionBeyond: 1, extensionOffset: 0.5, textOffset: 1.5, precision: 2, scale: 1,
    };
    const geometry = dimensionGeometry(entity);
    expect(geometry.dimensionLine).toEqual([{ x: -4, y: 0 }, { x: -4, y: 10 }]);
    expect(geometry.textPoint).toEqual({ x: -6.75, y: 5 });
    expect(geometry.textAngle).toBe(-Math.PI / 2);
  });

  it('formats radius and diameter dimension values', () => {
    const base: DimensionEntity = {
      id: 'radial', type: 'dimension', dimensionKind: 'radius', layer: 'dims', color: 0xffffff, selected: false,
      start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, offset: { x: 8, y: 2 },
      textHeight: 2.5, arrowSize: 2, arrowType: 'closed', extensionBeyond: 1, extensionOffset: 0.5, textOffset: 1, precision: 2, scale: 1,
    };
    expect(dimensionGeometry(base).text).toBe('R5.00');
    expect(dimensionGeometry({ ...base, dimensionKind: 'diameter' }).text).toBe('Ø10.00');
  });
});
