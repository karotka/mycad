import { describe, expect, it } from 'vitest';
import { Document } from '../Document';
import { ellipseAxisPoints, ellipsePoints, entityBounds, transformEntityPoints, type EllipseEntity } from './types';

const make = (rotation = 0): EllipseEntity => {
  const doc = new Document();
  return doc.createEllipse({ x: 5, y: 3 }, 10, 4, rotation);
};

describe('ellipse geometry', () => {
  it('samples points that satisfy the ellipse equation in its own frame', () => {
    const e = make(0.7);
    for (const point of ellipsePoints(e, 32)) {
      const dx = point.x - e.center.x, dy = point.y - e.center.y;
      const cos = Math.cos(-e.rotation), sin = Math.sin(-e.rotation);
      const x = dx * cos - dy * sin, y = dx * sin + dy * cos;
      expect((x / e.radiusX) ** 2 + (y / e.radiusY) ** 2).toBeCloseTo(1, 6);
    }
  });

  it('gives the exact bounds of an unrotated ellipse', () => {
    expect(entityBounds(make(0))).toEqual({ min: { x: -5, y: -1 }, max: { x: 15, y: 7 } });
  });

  // A quarter turn swaps the extents; a sampled bound would only approximate this.
  it('gives the exact bounds of a rotated ellipse', () => {
    const bounds = entityBounds(make(Math.PI / 2));
    expect(bounds.min.x).toBeCloseTo(1);
    expect(bounds.max.x).toBeCloseTo(9);
    expect(bounds.min.y).toBeCloseTo(-7);
    expect(bounds.max.y).toBeCloseTo(13);
  });

  it('bounds a rotated ellipse no tighter than the curve itself', () => {
    const e = make(0.4);
    const bounds = entityBounds(e);
    for (const point of ellipsePoints(e, 128)) {
      expect(point.x).toBeGreaterThanOrEqual(bounds.min.x - 1e-6);
      expect(point.x).toBeLessThanOrEqual(bounds.max.x + 1e-6);
      expect(point.y).toBeGreaterThanOrEqual(bounds.min.y - 1e-6);
      expect(point.y).toBeLessThanOrEqual(bounds.max.y + 1e-6);
    }
  });

  it('puts the axis points on the ellipse, at the axis distances', () => {
    const e = make(0.3);
    const [right, top, left, bottom] = ellipseAxisPoints(e);
    expect(Math.hypot(right.x - e.center.x, right.y - e.center.y)).toBeCloseTo(e.radiusX);
    expect(Math.hypot(left.x - e.center.x, left.y - e.center.y)).toBeCloseTo(e.radiusX);
    expect(Math.hypot(top.x - e.center.x, top.y - e.center.y)).toBeCloseTo(e.radiusY);
    expect(Math.hypot(bottom.x - e.center.x, bottom.y - e.center.y)).toBeCloseTo(e.radiusY);
  });

  // transformEntityPoints returns the copy untouched for a type it forgot, so a
  // new entity fails silently here rather than at the compiler.
  it('moves with transformEntityPoints', () => {
    const moved = transformEntityPoints(make(0), (point) => ({ x: point.x + 2, y: point.y - 1 }));
    expect(moved.type).toBe('ellipse');
    if (moved.type !== 'ellipse') return;
    expect(moved.center).toEqual({ x: 7, y: 2 });
    expect(moved.radiusX).toBe(10);
  });
});
