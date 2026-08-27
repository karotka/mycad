import { describe, expect, it } from 'vitest';
import { optimizePlotterPaths } from './PlotterPathOptimizer';

describe('optimizePlotterPaths', () => {
  it('joins touching paths in either direction into one stroke', () => {
    const result = optimizePlotterPaths([
      { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], closed: false },
      { points: [{ x: 2, y: 0 }, { x: 1, y: 0 }], closed: false },
      { points: [{ x: 2, y: 0 }, { x: 3, y: 0 }], closed: false },
    ]);
    expect(result).toEqual([{ points: [
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 },
    ], closed: false }]);
  });

  it('recognises a contour assembled from separate entities', () => {
    const result = optimizePlotterPaths([
      { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], closed: false },
      { points: [{ x: 1, y: 1 }, { x: 0, y: 1 }], closed: false },
      { points: [{ x: 1, y: 0 }, { x: 1, y: 1 }], closed: false },
      { points: [{ x: 0, y: 1 }, { x: 0, y: 0 }], closed: false },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].closed).toBe(true);
    expect(result[0].points).toHaveLength(4);
  });

  it('does not join a visible gap outside the tolerance', () => {
    const result = optimizePlotterPaths([
      { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], closed: false },
      { points: [{ x: 1.01, y: 0 }, { x: 2, y: 0 }], closed: false },
    ], 0.001);
    expect(result).toHaveLength(2);
  });
});
