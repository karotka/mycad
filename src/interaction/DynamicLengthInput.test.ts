import { describe, expect, it } from 'vitest';
import { dynamicLengthMidpoint, dynamicLengthPoint } from './DynamicLengthInput';

describe('dynamicLengthPoint', () => {
  it('follows the live cursor with no typed override', () => {
    const point = dynamicLengthPoint({ x: 0, y: 0 }, { x: 3, y: 4 }, { length: '', angle: '' });
    expect(point.x).toBeCloseTo(3, 9);
    expect(point.y).toBeCloseTo(4, 9);
  });

  it('fixes the length at the typed magnitude, keeping the cursor\'s direction', () => {
    // 3-4-5 triangle: direction (0.6, 0.8), typed length 10.
    const point = dynamicLengthPoint({ x: 0, y: 0 }, { x: 3, y: 4 }, { length: '10', angle: '' });
    expect(point.x).toBeCloseTo(6, 6);
    expect(point.y).toBeCloseTo(8, 6);
  });

  it('treats a negative typed length as just another magnitude', () => {
    const point = dynamicLengthPoint({ x: 0, y: 0 }, { x: 3, y: 4 }, { length: '-10', angle: '' });
    expect(point.x).toBeCloseTo(6, 6);
    expect(point.y).toBeCloseTo(8, 6);
  });

  it('fixes the angle at the typed degrees, keeping the cursor\'s distance', () => {
    // Cursor is 5 away from start; angle fixed at 90° (straight up).
    const point = dynamicLengthPoint({ x: 0, y: 0 }, { x: 3, y: 4 }, { length: '', angle: '90' });
    expect(point.x).toBeCloseTo(0, 6);
    expect(point.y).toBeCloseTo(5, 6);
  });

  it('fixes both length and angle when both are typed, ignoring the cursor entirely', () => {
    const point = dynamicLengthPoint({ x: 0, y: 0 }, { x: 3, y: 4 }, { length: '10', angle: '180' });
    expect(point.x).toBeCloseTo(-10, 6);
    expect(point.y).toBeCloseTo(0, 6);
  });

  it('ignores unparsable text and falls back to the live cursor', () => {
    const point = dynamicLengthPoint({ x: 0, y: 0 }, { x: 3, y: 4 }, { length: 'abc', angle: 'xyz' });
    expect(point.x).toBeCloseTo(3, 9);
    expect(point.y).toBeCloseTo(4, 9);
  });

  it('keeps working from an off-origin start point', () => {
    const point = dynamicLengthPoint({ x: 10, y: 10 }, { x: 13, y: 14 }, { length: '10', angle: '' });
    expect(point.x).toBeCloseTo(16, 6);
    expect(point.y).toBeCloseTo(18, 6);
  });
});

describe('dynamicLengthMidpoint', () => {
  it('is the midpoint of the segment both boxes anchor to', () => {
    expect(dynamicLengthMidpoint({ x: 0, y: 0 }, { x: 6, y: 8 })).toEqual({ x: 3, y: 4 });
  });
});
