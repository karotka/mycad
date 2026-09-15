import { describe, expect, it } from 'vitest';
import { helixCurve, helixLength } from './helix';

/** Where the chain of cubics actually is at parameter `t` of segment `index`. */
function pointOn(curve: NonNullable<ReturnType<typeof helixCurve>>, index: number, t: number) {
  const segment = curve.segments[index];
  const p0 = index === 0 ? curve.start : curve.segments[index - 1].end;
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  const pts = [p0, segment.control1, segment.control2, segment.end];
  return {
    x: pts.reduce((sum, p, i) => sum + p.x * w[i], 0),
    y: pts.reduce((sum, p, i) => sum + p.y * w[i], 0),
    z: pts.reduce((sum, p, i) => sum + p.z * w[i], 0),
  };
}

describe('helixCurve', () => {
  const center = { x: 10, y: -4 };

  it('follows the true helix to well under a thousandth of the radius', () => {
    const curve = helixCurve({ center, baseRadius: 20, topRadius: 20, height: 100, turns: 2 })!;
    expect(curve).not.toBeNull();
    // Distance from each sampled point to the nearest point of the true helix,
    // found by walking the ideal curve finely — the honest measure of how far
    // the cubics stray, rather than a phase comparison that a cubic is not
    // obliged to keep.
    const ideal = Array.from({ length: 20001 }, (_, i) => {
      const angle = (i / 20000) * Math.PI * 4;
      return { x: center.x + Math.cos(angle) * 20, y: center.y + Math.sin(angle) * 20, z: (angle / (Math.PI * 4)) * 100 };
    });
    let worst = 0;
    for (let index = 0; index < curve.segments.length; index++) {
      for (const t of [0.17, 0.33, 0.5, 0.71, 0.9]) {
        const point = pointOn(curve, index, t);
        const nearest = ideal.reduce((best, p) => Math.min(best, Math.hypot(p.x - point.x, p.y - point.y, p.z - point.z)), Infinity);
        worst = Math.max(worst, nearest);
      }
    }
    expect(worst).toBeLessThan(0.02);
  });

  it('starts on the base circle and ends a full rise above it', () => {
    const curve = helixCurve({ center, baseRadius: 5, topRadius: 5, height: 30, turns: 3 })!;
    expect(curve.start).toMatchObject({ x: 15, y: -4, z: 0 });
    const end = curve.segments.at(-1)!.end;
    expect(end.z).toBeCloseTo(30, 9);
    expect(Math.hypot(end.x - center.x, end.y - center.y)).toBeCloseTo(5, 6);
  });

  it('tapers a conical helix from one radius to the other', () => {
    const curve = helixCurve({ center, baseRadius: 10, topRadius: 2, height: 20, turns: 4 })!;
    const radiusOf = (p: { x: number; y: number }) => Math.hypot(p.x - center.x, p.y - center.y);
    expect(radiusOf(curve.start)).toBeCloseTo(10, 9);
    expect(radiusOf(curve.segments.at(-1)!.end)).toBeCloseTo(2, 6);
    // Halfway up is halfway between the radii, not some average of the ends.
    const middle = curve.segments[curve.segments.length / 2 - 1].end;
    expect(middle.z).toBeCloseTo(10, 6);
    expect(radiusOf(middle)).toBeCloseTo(6, 6);
  });

  it('keeps a cone on its own spiral between the segment ends too', () => {
    // The radius grows as the curve turns, so the direction it sets off in is
    // not the plain circular tangent — leave that out and the ends still land
    // right while everything between them bows off the cone.
    const options = { center, baseRadius: 10, topRadius: 2, height: 20, turns: 4 };
    const curve = helixCurve(options)!;
    const total = Math.PI * 8;
    const ideal = Array.from({ length: 40001 }, (_, i) => {
      const angle = (i / 40000) * total;
      const radius = 10 + (2 - 10) * (angle / total);
      return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius, z: (angle / total) * 20 };
    });
    let worst = 0;
    for (let index = 0; index < curve.segments.length; index++) {
      const point = pointOn(curve, index, 0.5);
      worst = Math.max(worst, ideal.reduce((best, p) => Math.min(best, Math.hypot(p.x - point.x, p.y - point.y, p.z - point.z)), Infinity));
    }
    expect(worst).toBeLessThan(0.005);
  });

  it('turns the other way round when asked', () => {
    const anticlockwise = helixCurve({ center, baseRadius: 5, topRadius: 5, height: 10, turns: 1 })!;
    const clockwise = helixCurve({ center, baseRadius: 5, topRadius: 5, height: 10, turns: 1, clockwise: true })!;
    expect(anticlockwise.segments[0].end.y).toBeGreaterThan(center.y);
    expect(clockwise.segments[0].end.y).toBeLessThan(center.y);
  });

  it('draws a flat spiral when there is no rise but the radius changes', () => {
    const curve = helixCurve({ center, baseRadius: 1, topRadius: 9, height: 0, turns: 2 })!;
    expect(curve).not.toBeNull();
    expect(curve.segments.every((segment) => segment.end.z === 0)).toBe(true);
  });

  it('refuses the degenerate cases rather than making a curve of nothing', () => {
    expect(helixCurve({ center, baseRadius: 5, topRadius: 5, height: 10, turns: 0 })).toBeNull();
    expect(helixCurve({ center, baseRadius: 0, topRadius: 0, height: 10, turns: 2 })).toBeNull();
    // No rise and no taper is a circle drawn over itself, not a helix.
    expect(helixCurve({ center, baseRadius: 5, topRadius: 5, height: 0, turns: 2 })).toBeNull();
  });
});

describe('helixLength', () => {
  it('is the hypotenuse of the unrolled turns and the rise', () => {
    expect(helixLength({ center: { x: 0, y: 0 }, baseRadius: 20, topRadius: 20, height: 100, turns: 1 }))
      .toBeCloseTo(Math.hypot(Math.PI * 40, 100), 9);
  });
});
