import { describe, expect, it } from 'vitest';
import { fitCubicBeziers, interpolatingBeziers } from './bezierFit';

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

describe('interpolatingBeziers', () => {
  const points = [{ x: 0, y: 0 }, { x: 3, y: 1 }, { x: 6, y: 0 }, { x: 9, y: -1 }, { x: 12, y: 0 }];

  it('passes exactly through every point with one segment per interval', () => {
    const result = interpolatingBeziers(points);
    expect(result).toHaveLength(points.length - 1);
    expect(result[0].start).toEqual(points[0]);
    for (let index = 0; index < result.length; index++) expect(result[index].end).toEqual(points[index + 1]);
  });

  it('never leaves a genuinely bent stretch as a flat straight segment', () => {
    // Every one of these points bends the path — an adaptive fit like
    // fitCubicBeziers can flatten a run like this into one straight cubic;
    // this must keep every interval curved because Catmull-Rom tangents are
    // never zero here. Checked by how far the curve's own midpoint sits from
    // the straight chord's midpoint — a straight segment scores exactly 0.
    for (const segment of interpolatingBeziers(points)) {
      const mid = (a: number, b: number, c: number, d: number): number => (a + 3 * b + 3 * c + d) / 8; // Bezier at t=0.5
      const curveMid = { x: mid(segment.start.x, segment.control1.x, segment.control2.x, segment.end.x), y: mid(segment.start.y, segment.control1.y, segment.control2.y, segment.end.y) };
      const chordMid = { x: (segment.start.x + segment.end.x) / 2, y: (segment.start.y + segment.end.y) / 2 };
      expect(Math.hypot(curveMid.x - chordMid.x, curveMid.y - chordMid.y)).toBeGreaterThan(1e-6);
    }
  });

  it('keeps every already-placed segment exactly the same after a further point is appended', () => {
    // This is the whole reason this function exists instead of reusing
    // fitCubicBeziers for interactive drawing: fitCubicBeziers is free to
    // redraw its segment boundaries — and even flatten a curved stretch to a
    // straight one — across the *entire* point set as more points arrive.
    const before = interpolatingBeziers(points);
    const after = interpolatingBeziers([...points, { x: 15, y: 2 }]);
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, before.length - 1));
  });

  it('degenerates to a straight line for two points, and to nothing for fewer', () => {
    expect(interpolatingBeziers([{ x: 0, y: 0 }])).toEqual([]);
    const line = interpolatingBeziers([{ x: 0, y: 0 }, { x: 4, y: 0 }]);
    expect(line).toHaveLength(1);
    expect(line[0]).toMatchObject({ start: { x: 0, y: 0 }, end: { x: 4, y: 0 } });
  });
});
