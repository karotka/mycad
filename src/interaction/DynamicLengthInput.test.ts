import { describe, expect, it } from 'vitest';
import { dynamicLengthPoint } from './DynamicLengthInput';

describe('dynamicLengthPoint', () => {
  it('follows the live cursor with no typed override', () => {
    expect(dynamicLengthPoint({ x: 0, y: 0 }, { x: 3, y: 4 }, '')).toEqual({ x: 3, y: 4 });
  });

  it('fixes the length at the typed magnitude, keeping the cursor\'s direction', () => {
    // 3-4-5 triangle: direction (0.6, 0.8), typed length 10.
    const point = dynamicLengthPoint({ x: 0, y: 0 }, { x: 3, y: 4 }, '10');
    expect(point.x).toBeCloseTo(6, 6);
    expect(point.y).toBeCloseTo(8, 6);
  });

  it('treats a negative typed value as just another magnitude', () => {
    const point = dynamicLengthPoint({ x: 0, y: 0 }, { x: 3, y: 4 }, '-10');
    expect(point.x).toBeCloseTo(6, 6);
    expect(point.y).toBeCloseTo(8, 6);
  });

  it('ignores unparsable text and falls back to the live cursor', () => {
    expect(dynamicLengthPoint({ x: 0, y: 0 }, { x: 3, y: 4 }, 'abc')).toEqual({ x: 3, y: 4 });
  });

  it('keeps working from an off-origin start point', () => {
    const point = dynamicLengthPoint({ x: 10, y: 10 }, { x: 13, y: 14 }, '10');
    expect(point.x).toBeCloseTo(16, 6);
    expect(point.y).toBeCloseTo(18, 6);
  });
});
