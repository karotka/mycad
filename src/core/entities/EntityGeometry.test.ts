import { describe, expect, it } from 'vitest';
import { canonicalEntityBounds, canonicalEntityPaths } from './EntityGeometry';
import type { LineEntity, PolylineEntity } from './types';

const base = { layer: '0', aci: 256, color: 0xffffff, selected: false } as const;

describe('canonicalEntityPaths', () => {
  it('describes a line once for every display-path consumer', () => {
    const line: LineEntity = {
      ...base, id: 'line', type: 'line', start: { x: -2, y: 3 }, end: { x: 7, y: -5 },
    };

    expect(canonicalEntityPaths(line)).toEqual([{
      points: [line.start, line.end],
      closed: false,
    }]);
    expect(canonicalEntityBounds(line)).toEqual({ min: { x: -2, y: -5 }, max: { x: 7, y: 3 } });
  });

  it('keeps a closed polyline closed without repeating its first point', () => {
    const polyline: PolylineEntity = {
      ...base, id: 'polyline', type: 'polyline', closed: true,
      vertices: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 4 }],
    };

    const path = canonicalEntityPaths(polyline)[0];
    expect(path.closed).toBe(true);
    expect(path.points).toEqual(polyline.vertices);
  });

  it('derives bulged-polyline bounds from the same sampled path it exposes', () => {
    const slot: PolylineEntity = {
      ...base, id: 'slot', type: 'polyline', closed: true,
      vertices: [{ x: 0, y: 0 }, { x: 0, y: 6 }], bulges: [1, 1],
    };

    const path = canonicalEntityPaths(slot)[0];
    const bounds = canonicalEntityBounds(slot);
    expect(path.points.length).toBeGreaterThan(slot.vertices.length);
    expect(bounds.min.x).toBeCloseTo(Math.min(...path.points.map((point) => point.x)), 9);
    expect(bounds.max.x).toBeCloseTo(Math.max(...path.points.map((point) => point.x)), 9);
    expect(bounds.min.y).toBeCloseTo(Math.min(...path.points.map((point) => point.y)), 9);
    expect(bounds.max.y).toBeCloseTo(Math.max(...path.points.map((point) => point.y)), 9);
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(6, 6);
  });

  it('returns no drawable path and finite bounds for an empty polyline', () => {
    const empty: PolylineEntity = {
      ...base, id: 'empty', type: 'polyline', closed: false, vertices: [],
    };

    expect(canonicalEntityPaths(empty)).toEqual([]);
    expect(canonicalEntityBounds(empty)).toEqual({ min: { x: 0, y: 0 }, max: { x: 0, y: 0 } });
  });
});
