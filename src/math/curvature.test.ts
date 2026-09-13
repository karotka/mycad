import { describe, expect, it } from 'vitest';
import { minimumCurvatureRadius } from './curvature';

describe('minimumCurvatureRadius', () => {
  it('measures a circle as its own radius', () => {
    const points = Array.from({ length: 64 }, (_value, index) => {
      const angle = index / 64 * Math.PI * 2;
      return { x: Math.cos(angle) * 7, y: Math.sin(angle) * 7 };
    });
    expect(minimumCurvatureRadius(points)!).toBeCloseTo(7, 2);
  });

  it('reports the tightest bend, not the average one', () => {
    // A wide arc joined to a tight one: the tight one is the answer.
    const wide = Array.from({ length: 40 }, (_v, i) => {
      const a = i / 40 * Math.PI / 2;
      return { x: Math.cos(a) * 20, y: Math.sin(a) * 20 };
    });
    const tight = Array.from({ length: 40 }, (_v, i) => {
      const a = i / 40 * Math.PI / 2;
      return { x: 20 + Math.sin(a) * 2, y: 20 + 2 - Math.cos(a) * 2 };
    });
    expect(minimumCurvatureRadius([...wide, ...tight])!).toBeLessThan(3);
  });

  it('has no answer for a straight run, rather than an infinite one', () => {
    expect(minimumCurvatureRadius([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 9, y: 0 }])).toBeNull();
    expect(minimumCurvatureRadius([{ x: 0, y: 0 }])).toBeNull();
  });
});
