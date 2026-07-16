import { describe, expect, it } from 'vitest';
import { expandBulges } from './DxfBulge';

const onCircle = (points: Array<{ x: number; y: number }>, centre: { x: number; y: number }, radius: number) =>
  points.every((p) => Math.abs(Math.hypot(p.x - centre.x, p.y - centre.y) - radius) < 1e-6);

describe('bulge arcs', () => {
  // bulge = tan(θ/4); a half circle is θ = π, so bulge = tan(π/4) = 1.
  it('expands a half circle bulge onto its true arc', () => {
    const { points, arcs } = expandBulges([
      { x: 1, y: 0, bulge: 1 },
      { x: -1, y: 0, bulge: 0 },
    ], false);

    expect(arcs).toBe(1);
    expect(points.length).toBeGreaterThan(2);
    expect(onCircle(points, { x: 0, y: 0 }, 1)).toBe(true);
    // Positive bulge turns counter-clockwise: from (1,0) it must go up through (0,1).
    expect(points.some((p) => p.y > 0.9)).toBe(true);
    expect(points.some((p) => p.y < -0.9)).toBe(false);
  });

  it('turns clockwise for a negative bulge', () => {
    const { points } = expandBulges([
      { x: 1, y: 0, bulge: -1 },
      { x: -1, y: 0, bulge: 0 },
    ], false);
    expect(onCircle(points, { x: 0, y: 0 }, 1)).toBe(true);
    expect(points.some((p) => p.y < -0.9)).toBe(true);
    expect(points.some((p) => p.y > 0.9)).toBe(false);
  });

  it('keeps the endpoints exactly', () => {
    const { points } = expandBulges([
      { x: 1, y: 0, bulge: 1 },
      { x: -1, y: 0, bulge: 0 },
    ], false);
    expect(points[0]).toMatchObject({ x: 1, y: 0 });
    expect(points.at(-1)).toMatchObject({ x: -1, y: 0 });
  });

  it('expands a quarter arc onto the right circle', () => {
    // θ = π/2 → bulge = tan(π/8) ≈ 0.4142, from (1,0) to (0,1) about the origin.
    const { points } = expandBulges([
      { x: 1, y: 0, bulge: Math.tan(Math.PI / 8) },
      { x: 0, y: 1, bulge: 0 },
    ], false);
    expect(onCircle(points, { x: 0, y: 0 }, 1)).toBe(true);
  });

  it('leaves straight segments alone', () => {
    const { points, arcs } = expandBulges([
      { x: 0, y: 0, bulge: 0 },
      { x: 10, y: 0, bulge: 0 },
      { x: 10, y: 5, bulge: 0 },
    ], false);
    expect(arcs).toBe(0);
    expect(points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }]);
  });

  it('expands the closing segment of a closed polyline without repeating the first vertex', () => {
    const { points, arcs } = expandBulges([
      { x: 0, y: 0, bulge: 0 },
      { x: 10, y: 0, bulge: 0 },
      { x: 10, y: 10, bulge: 1 },
    ], true);
    expect(arcs).toBe(1);
    expect(points[0]).toMatchObject({ x: 0, y: 0 });
    // The wrap segment is expanded, but the list must not close itself.
    expect(points.at(-1)).not.toMatchObject({ x: 0, y: 0 });
  });
});
