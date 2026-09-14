import { describe, expect, it } from 'vitest';
import {
  arcInteriorPoints,
  bulgeArc,
  bulgeForArc,
  bulgeMidpoint,
  bulgeThroughPoints,
  hasPolylineArcs,
  normalizedBulges,
  polylineArcPieces,
  polylineOutline,
  polylineSegments,
} from './polylineArcs';
import type { PolylineEntity } from './types';

const polyline = (vertices: Array<{ x: number; y: number }>, closed: boolean, bulges?: number[]): PolylineEntity => ({
  id: 'p', type: 'polyline', layer: '0', aci: 256, color: 0xffffff, selected: false, vertices, closed, bulges,
});

describe('bulgeArc', () => {
  it('reads a half circle back as one, radius and all — a slot end', () => {
    // The reported case: a 3.5 mm slot, so a 1.75 mm radius cap.
    const arc = bulgeArc({ x: 0, y: 0 }, { x: 3.5, y: 0 }, 1)!;
    expect(arc.radius).toBeCloseTo(1.75, 9);
    expect(arc.center.x).toBeCloseTo(1.75, 9);
    expect(arc.center.y).toBeCloseTo(0, 9);
    expect(arc.sweepAngle).toBeCloseTo(Math.PI, 9);
  });

  it('turns the other way for a negative bulge, around the same centre', () => {
    const positive = bulgeArc({ x: 0, y: 0 }, { x: 3.5, y: 0 }, 1)!;
    const negative = bulgeArc({ x: 0, y: 0 }, { x: 3.5, y: 0 }, -1)!;
    expect(negative.radius).toBeCloseTo(positive.radius, 9);
    expect(negative.sweepAngle).toBeCloseTo(-positive.sweepAngle, 9);
  });

  it('places the centre across its own chord for an arc of more than a half turn', () => {
    // bulge 2 is θ ≈ 253°: the centre is on the far side of the chord from the
    // arc, which is the case a naive "centre is always left" rule gets wrong.
    const arc = bulgeArc({ x: 0, y: 0 }, { x: 10, y: 0 }, 2)!;
    expect(Math.abs(arc.sweepAngle)).toBeGreaterThan(Math.PI);
    expect(arc.center.y).toBeLessThan(0);
    // Both ends really are on the circle.
    for (const point of [{ x: 0, y: 0 }, { x: 10, y: 0 }]) {
      expect(Math.hypot(point.x - arc.center.x, point.y - arc.center.y)).toBeCloseTo(arc.radius, 9);
    }
  });

  it('is nothing for a straight or degenerate segment', () => {
    expect(bulgeArc({ x: 0, y: 0 }, { x: 10, y: 0 }, 0)).toBeNull();
    expect(bulgeArc({ x: 0, y: 0 }, { x: 0, y: 0 }, 1)).toBeNull();
    expect(bulgeArc({ x: 0, y: 0 }, { x: 10, y: 0 }, Number.NaN)).toBeNull();
  });
});

describe('bulgeForArc', () => {
  it('is the exact inverse of bulgeArc, which is what lets JOIN keep a radius', () => {
    for (const sweep of [Math.PI, Math.PI / 2, -Math.PI / 3, 2.4, -2.9]) {
      const bulge = bulgeForArc(sweep);
      const arc = bulgeArc({ x: 0, y: 0 }, { x: 4, y: 1 }, bulge)!;
      expect(arc.sweepAngle).toBeCloseTo(sweep, 9);
    }
  });

  it('flips the turn when the arc is travelled backwards', () => {
    expect(bulgeForArc(Math.PI, true)).toBeCloseTo(-bulgeForArc(Math.PI), 12);
  });
});

describe('polylineSegments', () => {
  it('gives an open polyline one segment fewer than it has vertices', () => {
    const segments = polylineSegments(polyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false));
    expect(segments.map((segment) => segment.index)).toEqual([0, 1]);
  });

  it('gives a closed polyline the segment back to its first vertex', () => {
    const segments = polylineSegments(polyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], true));
    expect(segments).toHaveLength(3);
    expect(segments[2]).toMatchObject({ start: { x: 10, y: 10 }, end: { x: 0, y: 0 } });
  });

  it('reads a missing or short bulge array as straight', () => {
    const segments = polylineSegments(polyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false, [0.5]));
    expect(segments.map((segment) => segment.bulge)).toEqual([0.5, 0]);
  });
});

describe('polylineOutline', () => {
  it('hands back the vertices themselves when nothing curves — the ordinary polyline, unchanged', () => {
    const plain = polyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], false);
    expect(polylineOutline(plain)).toBe(plain.vertices);
    expect(polylineOutline(polyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, [0, 0]))).toEqual(plain.vertices);
  });

  it('draws a slot as a slot: two straight sides and two round ends', () => {
    // The shape from the reported drawing, as JOIN would build it: two
    // vertices, both segments bulged into half circles.
    const slot = polyline([{ x: 0, y: 0 }, { x: 0, y: 6 }], true, [1, 1]);
    const points = polylineOutline(slot);

    // Every point is either on one of the two caps or on a straight side.
    const capA = { x: 0, y: 3 };
    for (const point of points) {
      const onCap = Math.abs(Math.hypot(point.x - capA.x, point.y - capA.y) - 3) < 1e-9;
      expect(onCap, `(${point.x}, ${point.y}) is off the shape`).toBe(true);
    }
    // And it really did bow out: a chord-only reading would have no width.
    const width = Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x));
    expect(width).toBeCloseTo(6, 6);
  });

  it('keeps each vertex itself, exactly, among the sampled points', () => {
    const entity = polyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false, [0.4, 0]);
    const points = polylineOutline(entity);
    for (const vertex of entity.vertices) {
      expect(points.some((point) => point.x === vertex.x && point.y === vertex.y), `${JSON.stringify(vertex)} missing`).toBe(true);
    }
  });

  it('does not repeat the first point of a closed polyline, the same as before', () => {
    const entity = polyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], true, [0.4, 0, 0]);
    const points = polylineOutline(entity);
    expect(points[points.length - 1]).not.toEqual(points[0]);
  });
});

describe('hasPolylineArcs and normalizedBulges', () => {
  it('tells a genuinely curved polyline from one carrying only zeroes', () => {
    expect(hasPolylineArcs(polyline([{ x: 0, y: 0 }, { x: 1, y: 0 }], false))).toBe(false);
    expect(hasPolylineArcs(polyline([{ x: 0, y: 0 }, { x: 1, y: 0 }], false, [0]))).toBe(false);
    expect(hasPolylineArcs(polyline([{ x: 0, y: 0 }, { x: 1, y: 0 }], false, [0.2]))).toBe(true);
  });

  it('drops an all-straight array entirely, so a plain polyline stays plain', () => {
    expect(normalizedBulges([0, 0, 0], 3)).toBeUndefined();
    expect(normalizedBulges(undefined, 3)).toBeUndefined();
  });

  it('pads and trims to the segments a polyline actually has', () => {
    expect(normalizedBulges([1], 3)).toEqual([1, 0, 0]);
    expect(normalizedBulges([1, 2, 3, 4], 2)).toEqual([1, 2]);
  });
});

describe('polylineArcPieces', () => {
  it('picks out only the segments that curve, with their own arcs', () => {
    const entity = polyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false, [0, 1]);
    const pieces = polylineArcPieces(entity);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].segment.index).toBe(1);
    expect(pieces[0].arc.radius).toBeCloseTo(5, 9);
  });
});

describe('arcInteriorPoints', () => {
  it('uses more points for a longer turn, not a fixed count', () => {
    const quarter = arcInteriorPoints({ start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, bulge: Math.tan(Math.PI / 8), index: 0 });
    const half = arcInteriorPoints({ start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, bulge: 1, index: 0 });
    expect(half.length).toBeGreaterThan(quarter.length);
  });
});

describe('bulgeThroughPoints', () => {
  it('reads a bulge back from three points on its own arc', () => {
    for (const bulge of [1, 0.5, -0.3, 2, -2.5]) {
      const start = { x: 0, y: 0 }, end = { x: 7, y: 2 };
      const mid = bulgeMidpoint(start, end, bulge)!;
      expect(bulgeThroughPoints(start, mid, end)).toBeCloseTo(bulge, 9);
    }
  });

  it('is zero for three points in a line, which is what a straight segment wants', () => {
    expect(bulgeThroughPoints({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 })).toBe(0);
    expect(bulgeThroughPoints({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(0);
  });

  it('flips sign with the direction of travel, not with anything else', () => {
    const start = { x: 0, y: 0 }, end = { x: 7, y: 2 };
    const mid = bulgeMidpoint(start, end, 0.8)!;
    expect(bulgeThroughPoints(end, mid, start)).toBeCloseTo(-0.8, 9);
  });
});

describe('the clockwise centre, which the DXF importer this replaces got wrong', () => {
  it('puts the centre on the opposite side for a clockwise quarter turn', () => {
    const start = { x: 0, y: 0 }, end = { x: 10, y: 0 };
    const quarter = Math.tan(Math.PI / 8);
    const ccw = bulgeArc(start, end, quarter)!;
    const cw = bulgeArc(start, end, -quarter)!;
    expect(ccw.center.y).toBeGreaterThan(0);
    expect(cw.center.y).toBeCloseTo(-ccw.center.y, 9);
    expect(cw.radius).toBeCloseTo(ccw.radius, 9);
  });

  it('sweeps the short way round, not the long way, for every clockwise arc', () => {
    for (const bulge of [-0.2, -0.5, -Math.tan(Math.PI / 8), -1, -1.5]) {
      const arc = bulgeArc({ x: 0, y: 0 }, { x: 10, y: 0 }, bulge)!;
      expect(Math.abs(arc.sweepAngle), `bulge ${bulge}`).toBeCloseTo(Math.abs(4 * Math.atan(bulge)), 9);
      // The point the sweep actually lands on has to be the segment's own end.
      const endAngle = arc.startAngle + arc.sweepAngle;
      expect(arc.center.x + Math.cos(endAngle) * arc.radius, `bulge ${bulge}`).toBeCloseTo(10, 9);
      expect(arc.center.y + Math.sin(endAngle) * arc.radius, `bulge ${bulge}`).toBeCloseTo(0, 9);
    }
  });
});
