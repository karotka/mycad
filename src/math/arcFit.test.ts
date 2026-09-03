import { describe, expect, it } from 'vitest';
import { arcFromSagitta, dynamicArcPoint, sagittaForRadius, sagittaPoint, signedSagitta } from './arcFit';

const START = { x: -3, y: 0 };
const END = { x: 3, y: 0 };

describe('arcFromSagitta', () => {
  it('builds the minor arc bulging toward a point above the chord', () => {
    const arc = arcFromSagitta(START, END, { x: 0, y: 1 });
    expect(arc).not.toBeNull();
    expect(arc!.radius).toBeCloseTo(5, 6);
    expect(arc!.sweepAngle * 180 / Math.PI).toBeCloseTo(73.74, 1);
  });

  it('mirrors to the other side for a point below the chord', () => {
    const above = arcFromSagitta(START, END, { x: 0, y: 1 })!;
    const below = arcFromSagitta(START, END, { x: 0, y: -1 })!;
    expect(below.radius).toBeCloseTo(above.radius, 6);
    expect(below.sweepAngle).toBeCloseTo(above.sweepAngle, 6);
  });

  it('grows into a major arc automatically for a far point, no separate mode needed', () => {
    const near = arcFromSagitta(START, END, { x: 0, y: 1 })!;
    const far = arcFromSagitta(START, END, { x: 0, y: 8 })!;
    expect(far.sweepAngle).toBeGreaterThan(Math.PI); // more than half the circle
    expect(far.sweepAngle).toBeGreaterThan(near.sweepAngle);
  });

  it('always produces an arc whose two ends are exactly start and end', () => {
    const arc = arcFromSagitta(START, END, { x: 0, y: 8 })!;
    const a = { x: arc.center.x + Math.cos(arc.startAngle) * arc.radius, y: arc.center.y + Math.sin(arc.startAngle) * arc.radius };
    const endAngle = arc.startAngle + arc.sweepAngle;
    const b = { x: arc.center.x + Math.cos(endAngle) * arc.radius, y: arc.center.y + Math.sin(endAngle) * arc.radius };
    const endpoints = [a, b];
    for (const p of [START, END]) {
      expect(endpoints.some((e) => Math.hypot(e.x - p.x, e.y - p.y) < 1e-6)).toBe(true);
    }
  });

  it('is null when the third point sits on the chord itself', () => {
    expect(arcFromSagitta(START, END, { x: 0, y: 0 })).toBeNull();
  });

  it('is null when start and end coincide', () => {
    expect(arcFromSagitta(START, START, { x: 0, y: 1 })).toBeNull();
  });
});

describe('signedSagitta / sagittaPoint round-trip', () => {
  it('recovers the same sagitta a point was built from', () => {
    const point = sagittaPoint(START, END, 2.5);
    expect(signedSagitta(START, END, point)).toBeCloseTo(2.5, 9);
  });

  it('is negative on the opposite side', () => {
    expect(signedSagitta(START, END, { x: 0, y: -4 })).toBeLessThan(0);
  });
});

describe('sagittaForRadius', () => {
  it('picks the minor-arc sagitta for a positive typed radius', () => {
    const s = sagittaForRadius(3, 1 /* live side: positive */, 5);
    expect(s).toBeCloseTo(1, 6); // matches the r=5 minor-arc example above
  });

  it('picks the major-arc sagitta for a negative typed radius, same magnitude', () => {
    const s = sagittaForRadius(3, 1, -5);
    expect(s).toBeCloseTo(9, 6); // the complementary major-arc solution for r=5
  });

  it('keeps the sign of the live sagitta (which side of the chord)', () => {
    const positiveSide = sagittaForRadius(3, 1, 5)!;
    const negativeSide = sagittaForRadius(3, -1, 5)!;
    expect(positiveSide).toBeGreaterThan(0);
    expect(negativeSide).toBeLessThan(0);
    expect(Math.abs(positiveSide)).toBeCloseTo(Math.abs(negativeSide), 6);
  });

  it('rejects a radius too small to reach both points', () => {
    expect(sagittaForRadius(3, 1, 2)).toBeNull();
  });
});

describe('dynamicArcPoint', () => {
  it('follows the live cursor with no typed override', () => {
    const point = dynamicArcPoint(START, END, { x: 0, y: 1 }, '');
    expect(point).toEqual({ x: 0, y: 1 });
  });

  it('fixes the radius at the typed value, keeping the cursor\'s side', () => {
    const point = dynamicArcPoint(START, END, { x: 0, y: 1 }, '5');
    const arc = arcFromSagitta(START, END, point)!;
    expect(arc.radius).toBeCloseTo(5, 6);
    expect(point.y).toBeGreaterThan(0); // stayed on the cursor's (positive) side
  });

  it('falls back to the live cursor for an unreachable typed radius', () => {
    const point = dynamicArcPoint(START, END, { x: 0, y: 1 }, '2');
    expect(point).toEqual({ x: 0, y: 1 });
  });

  it('ignores unparsable text and falls back to the live cursor', () => {
    expect(dynamicArcPoint(START, END, { x: 0, y: 1 }, 'abc')).toEqual({ x: 0, y: 1 });
  });
});
