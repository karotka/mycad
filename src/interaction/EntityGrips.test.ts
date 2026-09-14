import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../math/geometry';
import type { ArcEntity, BezierEntity, CircleEntity, EllipseEntity, PolylineEntity, RectangleEntity } from '../core/entities/types';
import { entityReshapeGrips, reshapeEntityAtGrip } from './EntityGrips';

const base = { id: 'e1', layer: '0', aci: 256, color: 0xffffff, selected: false };
const elevated = (x: number, y: number, z: number): Vec2 => ({ x, y, z }) as Vec2;

describe('entityReshapeGrips', () => {
  it('uses stable Bezier indices for the start and every segment field', () => {
    const entity: BezierEntity = {
      ...base, type: 'bezier', start: { x: 0, y: 0 },
      segments: [
        { control1: { x: 1, y: 0 }, control2: { x: 2, y: 0 }, end: { x: 3, y: 0 } },
        { control1: { x: 4, y: 0 }, control2: { x: 5, y: 0 }, end: { x: 6, y: 0 } },
      ],
    };
    expect(entityReshapeGrips(entity)?.map(({ index }) => index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('keeps elevation on circle and arc rim grips', () => {
    const circle: CircleEntity = { ...base, type: 'circle', center: elevated(1, 2, 7), radius: 3 };
    const arc: ArcEntity = {
      ...base, type: 'arc', center: elevated(4, 5, 9), radius: 2,
      startAngle: 0, sweepAngle: Math.PI / 2,
    };
    expect(entityReshapeGrips(circle)?.every(({ point }) => point.z === 7)).toBe(true);
    expect(entityReshapeGrips(arc)?.every(({ point }) => point.z === 9)).toBe(true);
  });

  it('gives an elevated rectangle four spatial corner grips', () => {
    const rectangle: RectangleEntity = {
      ...base, type: 'rectangle', first: elevated(1, 2, 6), opposite: elevated(5, 4, 6),
    };
    const grips = entityReshapeGrips(rectangle);
    expect(grips?.map(({ point }) => point)).toEqual([
      elevated(1, 2, 6), elevated(5, 2, 6), elevated(5, 4, 6), elevated(1, 4, 6),
    ]);
  });
});

describe('reshapeEntityAtGrip', () => {
  it('preserves an old elevation unless an axis-constrained cursor supplies a new one', () => {
    const entity: BezierEntity = {
      ...base, type: 'bezier', start: elevated(0, 0, 2),
      segments: [{
        control1: elevated(1, 0, 3), control2: elevated(2, 0, 4), end: elevated(3, 0, 5),
      }],
    };
    const planar = reshapeEntityAtGrip(entity, 1, { x: 10, y: 20 }, 9, 20);
    const spatial = reshapeEntityAtGrip(entity, 1, elevated(10, 20, 12), 9, 20);
    expect(planar?.type === 'bezier' && (planar.segments[0].control1 as Vec2 & { z?: number }).z).toBe(3);
    expect(spatial?.type === 'bezier' && (spatial.segments[0].control1 as Vec2 & { z?: number }).z).toBe(12);
  });

  it('keeps a closed polyline first and closing vertex synchronized', () => {
    const entity: PolylineEntity = {
      ...base, type: 'polyline', closed: true,
      vertices: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 0 }],
    };
    const result = reshapeEntityAtGrip(entity, 0, { x: -1, y: -2 }, -1, -2);
    expect(result?.type).toBe('polyline');
    if (result?.type !== 'polyline') return;
    expect(result.vertices[0]).toEqual({ x: -1, y: -2 });
    expect(result.vertices.at(-1)).toEqual({ x: -1, y: -2 });
  });

  it('resizes a rotated ellipse in its own axis frame', () => {
    const ellipse: EllipseEntity = {
      ...base, type: 'ellipse', center: { x: 2, y: 3 },
      radiusX: 4, radiusY: 2, rotation: Math.PI / 2,
    };
    const result = reshapeEntityAtGrip(ellipse, 1, { x: 2, y: 10 }, 0, 7);
    expect(result?.type).toBe('ellipse');
    if (result?.type === 'ellipse') expect(result.radiusX).toBeCloseTo(7);
  });

  it('reshapes a rectangle from a corner while keeping the opposite corner fixed', () => {
    const rectangle: RectangleEntity = {
      ...base, type: 'rectangle', first: { x: 0, y: 0 }, opposite: { x: 8, y: 4 },
    };
    const result = reshapeEntityAtGrip(rectangle, 1, { x: 10, y: -2 }, 2, -2);
    expect(result).toMatchObject({
      type: 'rectangle', first: { x: 0, y: 4 }, opposite: { x: 10, y: -2 },
    });
  });
});
