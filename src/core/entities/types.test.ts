import { describe, expect, it } from 'vitest';
import { dimensionGeometry, type DimensionEntity } from './types';

describe('dimensionGeometry', () => {
  it('creates an aligned dimension line at the selected offset', () => {
    const entity: DimensionEntity = {
      id: 'dim', type: 'dimension', dimensionKind: 'aligned', layer: '0', aci: 256, color: 0xffffff, selected: false,
      start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, offset: { x: 4, y: 5 },
      textHeight: 2.5, arrowSize: 2, arrowType: 'closed', extensionBeyond: 1.25, extensionOffset: 0.625, textOffset: 0.625, precision: 2, scale: 1,
    };
    const geometry = dimensionGeometry(entity);
    expect(geometry.dimensionLine).toEqual([{ x: 0, y: 5 }, { x: 10, y: 5 }]);
    expect(geometry.text).toBe('10.00');
  });

  it('offsets text perpendicular to a vertical dimension line', () => {
    const entity: DimensionEntity = {
      id: 'vertical', type: 'dimension', dimensionKind: 'aligned', layer: 'dims', aci: 256, color: 0xffffff, selected: false,
      start: { x: 0, y: 0 }, end: { x: 0, y: 10 }, offset: { x: -4, y: 5 },
      textHeight: 2.5, arrowSize: 2, arrowType: 'closed', extensionBeyond: 1, extensionOffset: 0.5, textOffset: 1.5, precision: 2, scale: 1,
    };
    const geometry = dimensionGeometry(entity);
    expect(geometry.dimensionLine).toEqual([{ x: -4, y: 0 }, { x: -4, y: 10 }]);
    expect(geometry.textPoint).toEqual({ x: -6.75, y: 5 });
    expect(geometry.textAngle).toBe(-Math.PI / 2);
  });

  /**
   * The thing that went wrong: a linear dimension of a sloped line came out
   * running *along the slope*, because both ends were shifted sideways by the
   * start's distance rather than each meeting the dimension line where it is.
   * An aligned dimension cannot show the difference — its direction is the
   * points' direction, so the two agree — which is why it was only visible on
   * screen. So this asks the one question that separates them.
   */
  const slope: DimensionEntity = {
    id: 'slope', type: 'dimension', dimensionKind: 'linear', layer: '0', aci: 256, color: 0xffffff, selected: false,
    start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, offset: { x: 1.5, y: 9 }, rotation: 0,
    textHeight: 2.5, arrowSize: 2, arrowType: 'closed', extensionBeyond: 1.25, extensionOffset: 0.625, textOffset: 0.625, precision: 2, scale: 1,
  };

  it('runs a linear dimension line in the direction it measures, not along the points', () => {
    const level = dimensionGeometry(slope);
    expect(level.dimensionLine).toEqual([{ x: 0, y: 9 }, { x: 3, y: 9 }]);
    expect(level.text).toBe('3.00'); // the horizontal leg, which is what it drew

    const upright = dimensionGeometry({ ...slope, rotation: Math.PI / 2, offset: { x: 9, y: 2 } });
    expect(upright.dimensionLine[0].x).toBeCloseTo(9);
    expect(upright.dimensionLine[1].x).toBeCloseTo(9);
    expect(upright.dimensionLine[0].y).toBeCloseTo(0);
    expect(upright.dimensionLine[1].y).toBeCloseTo(4);
    expect(upright.text).toBe('4.00');
  });

  it('reaches each measured point with its own extension line', () => {
    // The dimension line sits above both points, so both extensions grow up.
    const geometry = dimensionGeometry(slope);
    expect(geometry.extensionStart).toEqual([{ x: 0, y: 0.625 }, { x: 0, y: 10.25 }]);
    expect(geometry.extensionEnd).toEqual([{ x: 3, y: 4.625 }, { x: 3, y: 10.25 }]);

    // Drawn between them instead, they grow apart to meet it from either side.
    const between = dimensionGeometry({ ...slope, offset: { x: 1.5, y: 2 } });
    expect(between.extensionStart[1].y).toBeCloseTo(3.25);
    expect(between.extensionEnd[1].y).toBeCloseTo(0.75);
  });

  it('formats radius and diameter dimension values', () => {
    const base: DimensionEntity = {
      id: 'radial', type: 'dimension', dimensionKind: 'radius', layer: 'dims', aci: 256, color: 0xffffff, selected: false,
      start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, offset: { x: 8, y: 2 },
      textHeight: 2.5, arrowSize: 2, arrowType: 'closed', extensionBeyond: 1, extensionOffset: 0.5, textOffset: 1, precision: 2, scale: 1,
    };
    expect(dimensionGeometry(base).text).toBe('R5.00');
    expect(dimensionGeometry({ ...base, dimensionKind: 'diameter' }).text).toBe('Ø10.00');
  });
});
