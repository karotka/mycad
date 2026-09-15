import { describe, expect, it } from 'vitest';
import { pointOnPiece, traceBoundary, type BoundaryPiece } from './boundaryTrace';
import { bulgeArc } from '../entities/polylineArcs';

const line = (x1: number, y1: number, x2: number, y2: number): BoundaryPiece =>
  ({ kind: 'line', start: { x: x1, y: y1 }, end: { x: x2, y: y2 } });

const circle = (cx: number, cy: number, r: number): BoundaryPiece[] => [
  { kind: 'arc', center: { x: cx, y: cy }, radius: r, startAngle: 0, sweepAngle: Math.PI },
  { kind: 'arc', center: { x: cx, y: cy }, radius: r, startAngle: Math.PI, sweepAngle: Math.PI },
];

/** The traced loop drawn out as points — from the result itself, the way
 *  anything reading the polyline it becomes would have to. */
function outline(result: NonNullable<ReturnType<typeof traceBoundary>>): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  result.vertices.forEach((start, index) => {
    const end = result.vertices[(index + 1) % result.vertices.length];
    const arc = bulgeArc(start, end, result.bulges[index]);
    const steps = 32;
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      points.push(arc
        ? pointOnPiece({ kind: 'arc', ...arc }, t)
        : { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t });
    }
  });
  return points;
}

describe('traceBoundary', () => {
  it('traces a square drawn as four separate lines', () => {
    const pieces = [line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 10), line(0, 10, 0, 0)];

    const result = traceBoundary(pieces, { x: 5, y: 5 })!;

    expect(result).not.toBeNull();
    expect(result.vertices).toHaveLength(4);
    expect(result.bulges.every((bulge) => bulge === 0)).toBe(true);
    const corners = result.vertices.map((point) => `${point.x},${point.y}`).sort();
    expect(corners).toEqual(['0,0', '0,10', '10,0', '10,10']);
  });

  it('cuts the lines at their crossings, so overhanging ends are left out', () => {
    // Four lines that cross past each other, the way construction lines do:
    // the enclosed square is the middle, and the tails are not part of it.
    const pieces = [line(-5, 0, 15, 0), line(10, -5, 10, 15), line(15, 10, -5, 10), line(0, 15, 0, -5)];

    const result = traceBoundary(pieces, { x: 5, y: 5 })!;

    expect(result.vertices).toHaveLength(4);
    const corners = result.vertices.map((point) => `${Math.round(point.x)},${Math.round(point.y)}`).sort();
    expect(corners).toEqual(['0,0', '0,10', '10,0', '10,10']);
  });

  it('traces the cell the point is in when two circles overlap, keeping them as arcs', () => {
    // The reported shape, in miniature. Two circles of radius 10, centres 14
    // apart, crossing at (7, +/-7.14). A point between the centres is inside
    // both, so what encloses it is the lens they share — the same answer
    // AutoCAD's own flood from that point gives.
    const pieces = [...circle(0, 0, 10), ...circle(14, 0, 10)];

    const lens = traceBoundary(pieces, { x: 7, y: 0 })!;

    expect(lens).not.toBeNull();
    // Every segment is curved: the outline is made of arcs, not of the chords
    // it was traced with.
    expect(lens.bulges.every((bulge) => Math.abs(bulge) > 1e-6)).toBe(true);
    // And every point of it is on one circle or the other, at the true radius.
    for (const point of outline(lens)) {
      const onFirst = Math.abs(Math.hypot(point.x, point.y) - 10) < 1e-6;
      const onSecond = Math.abs(Math.hypot(point.x - 14, point.y) - 10) < 1e-6;
      expect(onFirst || onSecond, `(${point.x.toFixed(3)}, ${point.y.toFixed(3)}) is off both circles`).toBe(true);
    }
    const xs = outline(lens).map((point) => point.x);
    // Exact: the lens reaches the far side of each circle, and back to where
    // they truly cross — not to where a chord approximation crossed.
    expect(Math.min(...xs)).toBeCloseTo(4, 9);
    expect(Math.max(...xs)).toBeCloseTo(10, 9);
  });

  it('traces the crescent from a point inside only one of them', () => {
    const pieces = [...circle(0, 0, 10), ...circle(14, 0, 10)];

    const crescent = traceBoundary(pieces, { x: -5, y: 0 })!;

    expect(crescent).not.toBeNull();
    const xs = outline(crescent).map((point) => point.x);
    // All the way round the first circle on the left, and cut back to where
    // the second bites into it on the right.
    expect(Math.min(...xs)).toBeCloseTo(-10, 9);
    expect(Math.max(...xs)).toBeCloseTo(7, 9);
  });

  it('finds nothing for a point outside everything', () => {
    const pieces = [line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 10), line(0, 10, 0, 0)];

    expect(traceBoundary(pieces, { x: 50, y: 50 })).toBeNull();
  });

  it('finds nothing when the shape does not close', () => {
    // Three sides of a square: nothing encloses the point.
    const pieces = [line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 10)];

    expect(traceBoundary(pieces, { x: 5, y: 5 })).toBeNull();
  });

  it('finds nothing at all in an empty drawing', () => {
    expect(traceBoundary([], { x: 0, y: 0 })).toBeNull();
  });

  it('takes the cell the point is in, not the whole shape, when a line divides it', () => {
    // A square cut in half by a vertical line through the middle.
    const pieces = [
      line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 10), line(0, 10, 0, 0),
      line(5, -2, 5, 12),
    ];

    const left = traceBoundary(pieces, { x: 2, y: 5 })!;
    const right = traceBoundary(pieces, { x: 8, y: 5 })!;

    for (const [result, range] of [[left, [0, 5]], [right, [5, 10]]] as const) {
      const xs = result.vertices.map((point) => point.x);
      expect(Math.min(...xs)).toBeCloseTo(range[0], 6);
      expect(Math.max(...xs)).toBeCloseTo(range[1], 6);
      expect(result.vertices).toHaveLength(4);
    }
  });

  it('follows an arc that is only part of a circle', () => {
    // A half circle closed by its own diameter — the shape a slot end makes.
    const pieces: BoundaryPiece[] = [
      { kind: 'arc', center: { x: 0, y: 0 }, radius: 10, startAngle: 0, sweepAngle: Math.PI },
      line(-10, 0, 10, 0),
    ];

    const result = traceBoundary(pieces, { x: 0, y: 5 })!;

    expect(result.vertices).toHaveLength(2);
    // One straight side and one half turn.
    const bulges = result.bulges.map((bulge) => Number(bulge.toFixed(6))).sort((a, b) => a - b);
    expect(bulges[0]).toBe(0);
    expect(Math.abs(bulges[1])).toBeCloseTo(1, 6);
  });
});
