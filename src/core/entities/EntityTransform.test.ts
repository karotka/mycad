import { describe, expect, it } from 'vitest';
import { rotateEntity } from './EntityTransform';
import type { BezierEntity, DimensionEntity, HatchEntity, RectangleEntity } from './types';
import type { Vec2 } from '../../math/geometry';

const base = {
  id: 'entity-1', layer: '0', aci: 256, color: 0xffffff, selected: false,
};
const elevated = (x: number, y: number, z: number): Vec2 => ({ x, y, z }) as Vec2;
const expectPoint = (actual: Vec2 | undefined, x: number, y: number, z?: number): void => {
  expect(actual?.x).toBeCloseTo(x);
  expect(actual?.y).toBeCloseTo(y);
  if (z !== undefined) expect((actual as Vec2 & { z?: number } | undefined)?.z).toBeCloseTo(z);
};

describe('rotateEntity', () => {
  it('preserves the elevation of every point on a 3D Bezier', () => {
    const entity: BezierEntity = {
      ...base,
      type: 'bezier',
      start: elevated(1, 0, 2),
      segments: [{
        control1: elevated(2, 0, 3),
        control2: elevated(3, 0, 4),
        end: elevated(4, 0, 5),
      }],
    };

    const rotated = rotateEntity(entity, { x: 0, y: 0 }, Math.PI / 2);
    expect(rotated.type).toBe('bezier');
    if (rotated.type !== 'bezier') return;
    expectPoint(rotated.start, 0, 1, 2);
    expectPoint(rotated.segments[0].control1, 0, 2, 3);
    expectPoint(rotated.segments[0].control2, 0, 3, 4);
    expectPoint(rotated.segments[0].end, 0, 4, 5);
  });

  it('rotates all dimension placement points and its measurement direction', () => {
    const entity: DimensionEntity = {
      ...base,
      type: 'dimension', dimensionKind: 'linear',
      start: { x: 1, y: 0 }, end: { x: 2, y: 0 }, offset: { x: 1, y: 1 },
      arcPoint: { x: 2, y: 1 }, textPosition: { x: 1.5, y: 1 }, rotation: 0,
      textHeight: 2.5, arrowSize: 2.5, arrowType: 'closed', extensionBeyond: 1,
      extensionOffset: 0, textOffset: 1, precision: 2, unitSuffix: 'none', scale: 1,
    };

    const rotated = rotateEntity(entity, { x: 0, y: 0 }, Math.PI / 2);
    expect(rotated.type).toBe('dimension');
    if (rotated.type !== 'dimension') return;
    expectPoint(rotated.start, 0, 1);
    expectPoint(rotated.end, 0, 2);
    expectPoint(rotated.offset, -1, 1);
    expectPoint(rotated.arcPoint, -1, 2);
    expectPoint(rotated.textPosition, -1, 1.5);
    expect(rotated.rotation).toBeCloseTo(Math.PI / 2);
  });

  it('rotates hatch loops and pattern vectors together', () => {
    const entity: HatchEntity = {
      ...base,
      type: 'hatch', loops: [[{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }]],
      pattern: 'lines', angle: 0, spacing: 2,
      patternLines: [{ angle: 0, base: { x: 1, y: 0 }, offset: { x: 0, y: 2 } }],
    };

    const rotated = rotateEntity(entity, { x: 0, y: 0 }, Math.PI / 2);
    expect(rotated.type).toBe('hatch');
    if (rotated.type !== 'hatch') return;
    expect(rotated.angle).toBeCloseTo(90);
    expectPoint(rotated.loops[0][0], 0, 1);
    expectPoint(rotated.loops[0][1], 0, 2);
    expectPoint(rotated.loops[0][2], -1, 1);
    expect(rotated.patternLines[0].angle).toBeCloseTo(Math.PI / 2);
    expectPoint(rotated.patternLines[0].base, 0, 1);
    expectPoint(rotated.patternLines[0].offset, -2, 0);
  });

  it('turns a rectangle into a closed polyline without a Document dependency', () => {
    const entity: RectangleEntity = {
      ...base, type: 'rectangle', first: { x: 0, y: 0 }, opposite: { x: 4, y: 2 },
    };

    const rotated = rotateEntity(entity, { x: 0, y: 0 }, Math.PI / 2);
    expect(rotated).toMatchObject({ id: entity.id, type: 'polyline', closed: true });
    if (rotated.type !== 'polyline') return;
    expectPoint(rotated.vertices[0], 0, 0);
    expectPoint(rotated.vertices[1], 0, 4);
    expectPoint(rotated.vertices[2], -2, 4);
    expectPoint(rotated.vertices[3], -2, 0);
  });
});
