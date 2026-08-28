import { describe, expect, it } from 'vitest';
import { DEFAULT_LINE_SPACING, STROKE_FONT } from '../text/strokeFont';
import { dimensionGeometry, entityBounds, removeBezierNode, removePolylineVertex, type BezierEntity, type DimensionEntity, type PolylineEntity, type TextEntity } from './types';

describe('entityBounds', () => {
  const text = (value: string): TextEntity => ({
    id: 't', type: 'text', layer: '0', aci: 256, color: 0xffffff, selected: false,
    position: { x: 0, y: 0 }, text: value, height: 10, font: STROKE_FONT,
  });

  it('grows the box downward for each extra line of MTEXT instead of stopping at one line', () => {
    const single = entityBounds(text('H'));
    const triple = entityBounds(text('H\nH\nH'));
    expect(triple.max.y).toBeCloseTo(single.max.y, 6); // first line's cap is still the top
    expect(triple.min.y).toBeCloseTo(-2 * 10 * DEFAULT_LINE_SPACING, 6); // two more lines dropped below
    expect(triple.max.x).toBeCloseTo(single.max.x, 6); // same glyph, not wider
  });
});

describe('removePolylineVertex', () => {
  const open = (vertices: PolylineEntity['vertices']): PolylineEntity => ({
    id: 'p', type: 'polyline', layer: '0', aci: 256, color: 0xffffff, selected: false, closed: false, vertices,
  });
  const closed = (vertices: PolylineEntity['vertices']): PolylineEntity => ({
    id: 'p', type: 'polyline', layer: '0', aci: 256, color: 0xffffff, selected: false, closed: true, vertices,
  });

  it('drops the picked vertex from an open polyline', () => {
    const source = open([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }, { x: 15, y: 5 }]);
    const result = removePolylineVertex(source, 1);
    expect(result?.vertices).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 15, y: 5 }]);
  });

  it('refuses to leave an open polyline with fewer than two vertices', () => {
    expect(removePolylineVertex(open([{ x: 0, y: 0 }, { x: 10, y: 0 }]), 0)).toBeNull();
  });

  it('drops a vertex from a closed polyline and keeps the closing point in sync', () => {
    // Stored with its closing duplicate, as createPolyline leaves it.
    const source = closed([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }]);
    const result = removePolylineVertex(source, 1); // drop (10, 0)
    expect(result?.vertices).toEqual([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }]);
  });

  it('refuses to leave a closed polyline with fewer than three corners', () => {
    const triangle = closed([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }, { x: 0, y: 0 }]);
    expect(removePolylineVertex(triangle, 0)).toBeNull();
  });

  it('rejects an out-of-range index rather than silently doing nothing useful', () => {
    const source = open([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    expect(removePolylineVertex(source, 5)).toBeNull();
    expect(removePolylineVertex(source, -1)).toBeNull();
  });
});

describe('removeBezierNode', () => {
  const spline = (): BezierEntity => ({
    id: 'b', type: 'bezier', layer: '0', aci: 256, color: 0xffffff, selected: false,
    start: { x: 0, y: 0 },
    segments: [
      { control1: { x: 1, y: 3 }, control2: { x: 3, y: 6 }, end: { x: 5, y: 8 } },
      { control1: { x: 7, y: 9 }, control2: { x: 9, y: 5 }, end: { x: 12, y: 3 } },
      { control1: { x: 14, y: 1 }, control2: { x: 16, y: 0 }, end: { x: 18, y: 0 } },
    ],
  });

  it('merges two segments at the removed joint, keeping each survivor’s own tangent handle', () => {
    const result = removeBezierNode(spline(), 0); // drop the joint at (5, 8)
    expect(result?.segments).toEqual([
      { control1: { x: 1, y: 3 }, control2: { x: 9, y: 5 }, end: { x: 12, y: 3 } }, // handle in from segment 0, out from segment 1
      { control1: { x: 14, y: 1 }, control2: { x: 16, y: 0 }, end: { x: 18, y: 0 } },
    ]);
    expect(result?.start).toEqual({ x: 0, y: 0 });
  });

  it('refuses to remove the curve’s own first or final point', () => {
    // Only an internal joint (0 here, between the only two segments) exists;
    // there is no boundary before the first segment or after the last one.
    const twoSegments: BezierEntity = { ...spline(), segments: spline().segments.slice(0, 2) };
    expect(removeBezierNode(twoSegments, -1)).toBeNull();
    expect(removeBezierNode(twoSegments, 1)).toBeNull();
  });

  it('refuses to leave a single-segment curve with no joint left to remove', () => {
    const oneSegment: BezierEntity = { ...spline(), segments: spline().segments.slice(0, 1) };
    expect(removeBezierNode(oneSegment, 0)).toBeNull();
  });
});

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

  it('draws the angular dimension arc in the sector chosen by its placement point', () => {
    const angular: DimensionEntity = {
      id: 'angle', type: 'dimension', dimensionKind: 'angular', layer: 'dims', aci: 256, color: 0xffffff, selected: false,
      start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, offset: { x: 0, y: 10 }, arcPoint: { x: 4, y: 4 },
      textHeight: 2.5, arrowSize: 2, arrowType: 'closed', extensionBeyond: 1, extensionOffset: 0.5, textOffset: 1, precision: 2, scale: 1,
    };
    const quarter = dimensionGeometry(angular);
    expect(quarter.text).toBe('90.00°');
    expect(quarter.dimensionLine.length).toBeGreaterThan(2);
    expect(Math.hypot(quarter.dimensionLine[0].x, quarter.dimensionLine[0].y)).toBeCloseTo(Math.sqrt(32));
    expect(quarter.extensionStart[0]).toEqual({ x: 0.5, y: 0 });
    expect(quarter.extensionEnd[0]).toEqual({ x: 0, y: 0.5 });

    const reflex = dimensionGeometry({ ...angular, arcPoint: { x: 4, y: -4 } });
    expect(reflex.text).toBe('270.00°');
  });

  it('formats units, custom text, prefixes, suffixes, and tolerances', () => {
    const base: DimensionEntity = {
      id: 'formatted', type: 'dimension', dimensionKind: 'aligned', layer: 'dims', aci: 256, color: 0xffffff, selected: false,
      start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, offset: { x: 5, y: 4 },
      textHeight: 2.5, arrowSize: 2, arrowType: 'closed', extensionBeyond: 1, extensionOffset: 0.5, textOffset: 1,
      precision: 2, angularPrecision: 1, unitSuffix: 'mm', scale: 1,
      textPrefix: '4× ', textSuffix: ' TYP', toleranceMode: 'symmetric', toleranceUpper: 0.1,
    };
    expect(dimensionGeometry(base).text).toBe('4× 10.00 ±0.10 mm TYP');
    expect(dimensionGeometry({ ...base, textOverride: 'REFERENCE' }).text).toBe('4× REFERENCE TYP');
    expect(dimensionGeometry({ ...base, textOverride: '[<>]' }).text).toBe('4× [10.00 ±0.10 mm] TYP');

    const angular = {
      ...base,
      dimensionKind: 'angular' as const,
      end: { x: 10, y: 0 },
      offset: { x: 0, y: 10 },
      arcPoint: { x: 4, y: 4 },
      textPrefix: '',
      textSuffix: '',
      textOverride: '',
      toleranceMode: 'deviation' as const,
      toleranceUpper: 0.5,
      toleranceLower: 0.2,
    };
    expect(dimensionGeometry(angular).text).toBe('90.0° +0.5°/-0.2°');
  });
});
