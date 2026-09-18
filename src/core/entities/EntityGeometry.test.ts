import { describe, expect, it } from 'vitest';
import { canonicalEntityBounds, canonicalEntityPaths, canonicalEntityRegions } from './EntityGeometry';
import type { ArcEntity, BezierEntity, CircleEntity, EllipseEntity, HatchEntity, LineEntity, MlineEntity, OctagonEntity, PolylineEntity, RectangleEntity } from './types';

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

  it('samples a circle at the requested quality and preserves its plane offset', () => {
    const circle: CircleEntity = {
      ...base, id: 'circle', type: 'circle', center: { x: 4, y: 7, z: 3 } as CircleEntity['center'], radius: 2,
    };

    const path = canonicalEntityPaths(circle, 12)[0];
    expect(path.closed).toBe(true);
    expect(path.points).toHaveLength(12);
    expect(path.points.every((point) => (point as typeof point & { z?: number }).z === 3)).toBe(true);
    expect(canonicalEntityBounds(circle)).toEqual({ min: { x: 2, y: 5 }, max: { x: 6, y: 9 } });
  });

  it('keeps rotated ellipse bounds exact rather than deriving them from samples', () => {
    const ellipse: EllipseEntity = {
      ...base, id: 'ellipse', type: 'ellipse', center: { x: 10, y: -2 },
      radiusX: 6, radiusY: 2, rotation: Math.PI / 4,
    };

    const path = canonicalEntityPaths(ellipse, 16)[0];
    const halfExtent = Math.hypot(6 / Math.sqrt(2), 2 / Math.sqrt(2));
    expect(path).toMatchObject({ closed: true });
    expect(path.points).toHaveLength(16);
    const bounds = canonicalEntityBounds(ellipse);
    expect(bounds.min.x).toBeCloseTo(10 - halfExtent, 12);
    expect(bounds.min.y).toBeCloseTo(-2 - halfExtent, 12);
    expect(bounds.max.x).toBeCloseTo(10 + halfExtent, 12);
    expect(bounds.max.y).toBeCloseTo(-2 + halfExtent, 12);
  });

  it('adapts an arc to tolerance while keeping its bounds analytically exact', () => {
    const arc: ArcEntity = {
      ...base, id: 'arc', type: 'arc', center: { x: 3, y: 4 }, radius: 10,
      startAngle: -Math.PI / 4, sweepAngle: Math.PI,
    };

    const coarse = canonicalEntityPaths(arc, { curveTolerance: 1, minimumSegments: 2 })[0];
    const fine = canonicalEntityPaths(arc, { curveTolerance: 0.01, minimumSegments: 2 })[0];
    expect(fine.points.length).toBeGreaterThan(coarse.points.length);
    const bounds = canonicalEntityBounds(arc);
    expect(bounds.max.x).toBeCloseTo(13, 12); // crosses angle 0
    expect(bounds.max.y).toBeCloseTo(14, 12); // crosses angle PI/2
    expect(bounds.min.x).toBeCloseTo(3 - 10 / Math.sqrt(2), 12);
  });

  it('adapts a Bezier chain and computes exact cubic extrema', () => {
    const bezier: BezierEntity = {
      ...base, id: 'bezier', type: 'bezier', start: { x: 0, y: 0, z: 1 } as BezierEntity['start'],
      segments: [{
        control1: { x: 0, y: 10, z: 2 } as BezierEntity['segments'][number]['control1'],
        control2: { x: 10, y: 10, z: 3 } as BezierEntity['segments'][number]['control2'],
        end: { x: 10, y: 0, z: 4 } as BezierEntity['segments'][number]['end'],
      }],
    };

    const coarse = canonicalEntityPaths(bezier, { curveTolerance: 2, minimumSegments: 1 })[0];
    const fine = canonicalEntityPaths(bezier, { curveTolerance: 0.01, minimumSegments: 1 })[0];
    expect(fine.points.length).toBeGreaterThan(coarse.points.length);
    expect((fine.points.at(-1) as typeof fine.points[number] & { z?: number }).z).toBe(4);
    expect(canonicalEntityBounds(bezier)).toEqual({ min: { x: 0, y: 0 }, max: { x: 10, y: 7.5 } });
  });

  it('builds one elevated closed path and bounds for a rectangle', () => {
    const rectangle: RectangleEntity = {
      ...base, id: 'rectangle', type: 'rectangle',
      first: { x: 7, y: -2, z: 5 } as RectangleEntity['first'],
      opposite: { x: 1, y: 4 } as RectangleEntity['opposite'],
    };

    const path = canonicalEntityPaths(rectangle)[0];
    expect(path.closed).toBe(true);
    expect(path.points).toEqual([
      { x: 7, y: -2, z: 5 }, { x: 1, y: -2, z: 5 },
      { x: 1, y: 4, z: 5 }, { x: 7, y: 4, z: 5 },
    ]);
    expect(canonicalEntityBounds(rectangle)).toEqual({ min: { x: 1, y: -2 }, max: { x: 7, y: 4 } });
  });

  it('uses octagon vertices directly and gives an empty one finite bounds', () => {
    const octagon: OctagonEntity = {
      ...base, id: 'octagon', type: 'octagon', center: { x: 2, y: 3 }, radius: 4,
      vertices: [{ x: -2, y: 3 }, { x: 2, y: 7 }, { x: 6, y: 3 }, { x: 2, y: -1 }],
    };
    expect(canonicalEntityPaths(octagon)[0]).toEqual({ points: octagon.vertices, closed: true });
    expect(canonicalEntityBounds(octagon)).toEqual({ min: { x: -2, y: -1 }, max: { x: 6, y: 7 } });

    const empty = { ...octagon, vertices: [] };
    expect(canonicalEntityPaths(empty)).toEqual([]);
    expect(canonicalEntityBounds(empty)).toEqual({ min: { x: 0, y: 0 }, max: { x: 0, y: 0 } });
  });

  it('describes every visible MLINE element and derives exact offset bounds', () => {
    const mline: MlineEntity = {
      ...base, id: 'mline', type: 'mline', vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false,
      styleName: 'TEST', justification: 'zero', startCap: 'none', endCap: 'none',
      elements: [
        { offset: 0.5, aci: 256, linetype: 'Continuous' },
        { offset: -0.5, aci: 256, linetype: 'Continuous' },
      ],
    };
    expect(canonicalEntityPaths(mline)).toEqual([
      { points: [{ x: 0, y: 0.5 }, { x: 10, y: 0.5 }], closed: false },
      { points: [{ x: 0, y: -0.5 }, { x: 10, y: -0.5 }], closed: false },
    ]);
    expect(canonicalEntityBounds(mline)).toEqual({ min: { x: 0, y: -0.5 }, max: { x: 10, y: 0.5 } });
  });

  it('keeps HATCH regions with holes separate from generated pattern strokes', () => {
    const hatch: HatchEntity = {
      ...base, id: 'hatch', type: 'hatch', pattern: 'lines', angle: 0, spacing: 2,
      loops: [
        [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
        [{ x: 4, y: 4 }, { x: 6, y: 4 }, { x: 6, y: 6 }, { x: 4, y: 6 }],
      ],
      patternLines: [{ angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 2 } }],
    };
    const paths = canonicalEntityPaths(hatch);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => !path.closed && path.points.length === 2)).toBe(true);
    expect(canonicalEntityRegions(hatch)[0].loops).toEqual(hatch.loops);
    expect(canonicalEntityBounds(hatch)).toEqual({ min: { x: 0, y: 0 }, max: { x: 10, y: 10 } });
  });
});
