import { describe, expect, it } from 'vitest';
import { hatchGeometry, type DxfPair } from './DxfHatch';

/** Build HATCH fields from flat [code, value, code, value, …] pairs. */
function fields(...flat: Array<number | string>): DxfPair[] {
  const out: DxfPair[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ code: Number(flat[i]), value: String(flat[i + 1]) });
  return out;
}

// A 10×10 square as a polyline boundary path (flag 3 = external | polyline).
const squarePolyline = [
  91, 1, 92, 3, 72, 0, 73, 1, 93, 4,
  10, 0, 20, 0, 10, 10, 20, 0, 10, 10, 20, 10, 10, 0, 20, 10,
];

describe('hatchGeometry', () => {
  it('returns a solid fill as its boundary loop, with no hatch lines', () => {
    const hatch = hatchGeometry(fields(70, 1, ...squarePolyline), 1);
    expect(hatch.solid).toBe(true);
    expect(hatch.loops).toHaveLength(1);
    expect(hatch.loops[0]).toHaveLength(4);
    expect(hatch.lines).toHaveLength(0);
  });

  it('generates horizontal hatch lines clipped to the boundary width', () => {
    // Pattern: one family, angle 0 (horizontal), offset (0, 2) → lines every 2 up.
    const hatch = hatchGeometry(fields(
      70, 0, ...squarePolyline,
      78, 1, 53, 0, 43, 0, 44, 0, 45, 0, 46, 2, 79, 0,
    ), 1);
    expect(hatch.solid).toBe(false);
    // y = 0,2,4,6,8,10 all lie on/within the square → six lines.
    expect(hatch.lines.length).toBeGreaterThanOrEqual(4);
    for (const [a, b] of hatch.lines) {
      // Each line spans the full 10 mm width and stays horizontal.
      expect(Math.abs(a.y - b.y)).toBeLessThan(1e-6);
      expect(Math.abs(Math.abs(b.x - a.x) - 10)).toBeLessThan(1e-6);
      expect(a.y).toBeGreaterThanOrEqual(-1e-6);
      expect(a.y).toBeLessThanOrEqual(10 + 1e-6);
    }
  });

  it('generates 45° hatch lines whose offset leans along the line', () => {
    // ANSI31-style: angle 45, offset with a component along the line — the family
    // index must be measured perpendicular or the lines land off the region.
    const hatch = hatchGeometry(fields(
      70, 0, ...squarePolyline,
      78, 1, 53, 45, 43, 0, 44, 0, 45, 3, 46, -1, 79, 0,
    ), 1);
    expect(hatch.lines.length).toBeGreaterThan(0);
    for (const [a, b] of hatch.lines) {
      // 45° direction: equal run and rise.
      expect(Math.abs(Math.abs(b.x - a.x) - Math.abs(b.y - a.y))).toBeLessThan(1e-6);
    }
  });

  it('flattens a spline boundary edge into loop points', () => {
    // Edge path (flag 1) with a single degree-1 spline from (0,0) to (10,0).
    const hatch = hatchGeometry(fields(
      70, 1, 91, 1, 92, 1, 93, 1,
      72, 4, 94, 1, 73, 0, 74, 0, 95, 4, 96, 2,
      40, 0, 40, 0, 40, 1, 40, 1,
      10, 0, 20, 0, 10, 10, 20, 0,
    ), 1);
    expect(hatch.solid).toBe(true);
    expect(hatch.loops).toHaveLength(1);
    expect(hatch.loops[0].length).toBeGreaterThanOrEqual(2);
    const xs = hatch.loops[0].map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(10, 6);
  });

  it('scales boundary coordinates by the unit scale', () => {
    const hatch = hatchGeometry(fields(70, 1, ...squarePolyline), 10);
    const xs = hatch.loops[0].map((p) => p.x);
    expect(Math.max(...xs)).toBeCloseTo(100, 6);
  });
});
