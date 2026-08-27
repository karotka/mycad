import { describe, expect, it } from 'vitest';
import { fitCubicBeziers } from './bezierFit';

describe('fitCubicBeziers', () => {
  it('reduces sampled smooth geometry to fewer cubic Beziers', () => {
    const points = Array.from({ length: 21 }, (_, index) => {
      const t = index / 20, u = 1 - t;
      return { x: 3 * u * u * t + 6 * u * t * t + 3 * t ** 3, y: 6 * u * t * t };
    });
    const result = fitCubicBeziers(points, 0.05);
    expect(result.length).toBeLessThan(6);
    expect(result[0].start).toEqual(points[0]);
    expect(result.at(-1)?.end).toEqual(points.at(-1));
  });

  it('splits a sharp corner instead of rounding beyond tolerance', () => {
    const result = fitCubicBeziers([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }], 0.01);
    expect(result.length).toBeGreaterThan(1);
  });
});
