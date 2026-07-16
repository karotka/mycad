import { describe, expect, it } from 'vitest';
import { isSingleCubic, sampleSpline, type SplineData } from './DxfSpline';

/** Independent truth: the textbook cubic Bézier formula. */
const bezierAt = (t: number, p: Array<{ x: number; y: number }>) => {
  const u = 1 - t;
  return {
    x: u ** 3 * p[0].x + 3 * u ** 2 * t * p[1].x + 3 * u * t ** 2 * p[2].x + t ** 3 * p[3].x,
    y: u ** 3 * p[0].y + 3 * u ** 2 * t * p[1].y + 3 * u * t ** 2 * p[2].y + t ** 3 * p[3].y,
  };
};

describe('B-spline evaluation', () => {
  const control = [{ x: 0, y: 0 }, { x: 1, y: 3 }, { x: 4, y: 3 }, { x: 5, y: 0 }];

  // A clamped cubic B-spline over four control points *is* a cubic Bézier, so
  // de Boor must reproduce it exactly. This is what pins the implementation.
  it('reproduces the cubic Bezier it is equivalent to', () => {
    const spline: SplineData = {
      degree: 3, controlPoints: control, knots: [0, 0, 0, 0, 1, 1, 1, 1], closed: false,
    };
    const samples = sampleSpline(spline, 40);
    expect(samples.length).toBeGreaterThan(20);
    samples.forEach((point, index) => {
      const expected = bezierAt(index / (samples.length - 1), control);
      expect(point.x).toBeCloseTo(expected.x, 4);
      expect(point.y).toBeCloseTo(expected.y, 4);
    });
  });

  it('starts and ends on the first and last control point of a clamped spline', () => {
    const samples = sampleSpline({ degree: 3, controlPoints: control, knots: [0, 0, 0, 0, 1, 1, 1, 1], closed: false });
    expect(samples[0].x).toBeCloseTo(0);
    expect(samples[0].y).toBeCloseTo(0);
    expect(samples.at(-1)!.x).toBeCloseTo(5);
    expect(samples.at(-1)!.y).toBeCloseTo(0);
  });

  it('handles more control points than one segment', () => {
    const many = [{ x: 0, y: 0 }, { x: 1, y: 4 }, { x: 3, y: -2 }, { x: 6, y: 4 }, { x: 8, y: 0 }, { x: 10, y: 2 }];
    const samples = sampleSpline({ degree: 3, controlPoints: many, knots: [], closed: false });
    expect(samples.length).toBeGreaterThan(10);
    // A clamped spline still runs from the first control point to the last.
    expect(samples[0].x).toBeCloseTo(0);
    expect(samples.at(-1)!.x).toBeCloseTo(10, 3);
    expect(samples.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  });

  it('treats a degree 1 spline as the polyline it is', () => {
    const samples = sampleSpline({ degree: 1, controlPoints: control, knots: [], closed: false });
    expect(samples).toEqual(control);
  });

  it('follows the weights of a rational spline', () => {
    const heavy = sampleSpline({
      degree: 3, controlPoints: control, knots: [0, 0, 0, 0, 1, 1, 1, 1], weights: [1, 8, 8, 1], closed: false,
    });
    const plain = sampleSpline({ degree: 3, controlPoints: control, knots: [0, 0, 0, 0, 1, 1, 1, 1], closed: false });
    const midHeavy = heavy[Math.floor(heavy.length / 2)];
    const midPlain = plain[Math.floor(plain.length / 2)];
    // Heavier middle control points pull the curve towards them.
    expect(midHeavy.y).toBeGreaterThan(midPlain.y);
  });

  it('refuses a spline with too few control points', () => {
    expect(sampleSpline({ degree: 3, controlPoints: [{ x: 0, y: 0 }], knots: [], closed: false })).toEqual([]);
  });

  it('recognises exactly the splines our bezier can hold', () => {
    expect(isSingleCubic({ degree: 3, controlPoints: control, knots: [], closed: false })).toBe(true);
    expect(isSingleCubic({ degree: 3, controlPoints: control, knots: [], weights: [1, 2, 1, 1], closed: false })).toBe(false);
    expect(isSingleCubic({ degree: 3, controlPoints: control, knots: [], closed: true })).toBe(false);
    expect(isSingleCubic({ degree: 2, controlPoints: control, knots: [], closed: false })).toBe(false);
    expect(isSingleCubic({ degree: 3, controlPoints: [...control, { x: 7, y: 1 }], knots: [], closed: false })).toBe(false);
  });
});
