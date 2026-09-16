import { describe, expect, it } from 'vitest';
import { entityAsSpline, isSplineConvertible, type SplineGeometry } from './toSpline';
import { Document } from '../Document';

/** Where the chain actually is at a fraction along one of its spans. */
function pointOn(geometry: SplineGeometry, index: number, t: number) {
  const segment = geometry.segments[index];
  const p0 = index === 0 ? geometry.start : geometry.segments[index - 1].end;
  const u = 1 - t;
  const weights = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  const points = [p0, segment.control1, segment.control2, segment.end];
  return {
    x: points.reduce((sum, point, i) => sum + point.x * weights[i], 0),
    y: points.reduce((sum, point, i) => sum + point.y * weights[i], 0),
    z: points.reduce((sum, point, i) => sum + ((point as { z?: number }).z ?? 0) * weights[i], 0),
  };
}

/** The worst the chain strays from a shape described by its own equation. */
function worstStray(geometry: SplineGeometry, distance: (point: { x: number; y: number }) => number): number {
  let worst = 0;
  for (let index = 0; index < geometry.segments.length; index++) {
    for (const t of [0, 0.13, 0.29, 0.5, 0.71, 0.87, 1]) {
      worst = Math.max(worst, Math.abs(distance(pointOn(geometry, index, t))));
    }
  }
  return worst;
}

describe('a drawn shape as the spline that traces it', () => {
  const doc = new Document();

  it('traces a line exactly, ends and all', () => {
    const geometry = entityAsSpline(doc.createLine({ x: 1, y: 2 }, { x: 11, y: 22 }))!;
    expect(geometry.start).toMatchObject({ x: 1, y: 2 });
    expect(geometry.segments).toHaveLength(1);
    expect(geometry.segments[0].end).toMatchObject({ x: 11, y: 22 });
    // A straight cubic, so every sample sits on the line itself.
    expect(worstStray(geometry, (point) => (point.x - 1) * 20 - (point.y - 2) * 10)).toBeLessThan(1e-9);
  });

  it('keeps a line that climbs on its own slope', () => {
    const geometry = entityAsSpline(doc.createLine(
      { x: 0, y: 0, z: 0 } as never, { x: 10, y: 0, z: 30 } as never,
    ))!;
    expect(pointOn(geometry, 0, 0.5).z).toBeCloseTo(15, 9);
    expect(pointOn(geometry, 0, 1).z).toBeCloseTo(30, 9);
  });

  it('traces an arc to under a thousandth of its radius', () => {
    const arc = doc.createArc({ x: 5, y: -3 }, 20, 0.4, 2.1);
    const geometry = entityAsSpline(arc)!;
    expect(worstStray(geometry, (point) => Math.hypot(point.x - 5, point.y + 3) - 20)).toBeLessThan(0.02);
    // It starts and ends exactly where the arc does, not near it.
    expect(geometry.start.x).toBeCloseTo(5 + Math.cos(0.4) * 20, 9);
    expect(geometry.segments.at(-1)!.end.y).toBeCloseTo(-3 + Math.sin(2.5) * 20, 9);
  });

  it('closes a circle back on its own start, to the last digit', () => {
    const geometry = entityAsSpline(doc.createCircle({ x: 0, y: 0 }, 7))!;
    expect(worstStray(geometry, (point) => Math.hypot(point.x, point.y) - 7)).toBeLessThan(0.01);
    expect(geometry.segments.at(-1)!.end).toEqual(geometry.start);
  });

  it('traces an ellipse, turned as it is drawn', () => {
    const geometry = entityAsSpline(doc.createEllipse({ x: 0, y: 0 }, 10, 4, Math.PI / 6))!;
    const cosine = Math.cos(-Math.PI / 6), sine = Math.sin(-Math.PI / 6);
    expect(worstStray(geometry, (point) => {
      // Back into the ellipse's own frame, where it is x²/a² + y²/b² = 1.
      const x = point.x * cosine - point.y * sine;
      const y = point.x * sine + point.y * cosine;
      return Math.hypot(x / 10, y / 4) - 1;
    })).toBeLessThan(0.01);
  });

  it("walks a rectangle's four corners and shuts it", () => {
    const geometry = entityAsSpline(doc.createRectangle({ x: 0, y: 0 }, { x: 10, y: 5 }))!;
    expect(geometry.segments).toHaveLength(4);
    expect(geometry.segments.at(-1)!.end).toMatchObject({ x: 0, y: 0 });
    const corners = geometry.segments.map((segment) => [segment.end.x, segment.end.y]);
    expect(corners).toEqual([[10, 0], [10, 5], [0, 5], [0, 0]]);
  });

  it('turns a polyline bulge into the arc it stands for, not the chord across it', () => {
    const polyline = doc.createPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], false);
    polyline.bulges = [1];   // a half circle above the chord
    const geometry = entityAsSpline(polyline)!;
    expect(worstStray(geometry, (point) => Math.hypot(point.x - 5, point.y) - 5)).toBeLessThan(0.01);
    expect(geometry.segments.at(-1)!.end).toMatchObject({ x: 10, y: 0 });
  });

  it('hands a spline back as itself rather than refusing', () => {
    const bezier = doc.createBezier({ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 0 });
    expect(entityAsSpline(bezier)).toEqual({ start: bezier.start, segments: bezier.segments });
  });

  it('refuses what a single curve cannot stand for', () => {
    expect(entityAsSpline(doc.createText({ x: 0, y: 0 }, 'hello'))).toBeNull();
    expect(isSplineConvertible(doc.createText({ x: 0, y: 0 }, 'hello'))).toBe(false);
    expect(isSplineConvertible(doc.createArc({ x: 0, y: 0 }, 5, 0, 1))).toBe(true);
  });
});
