import { describe, expect, it } from 'vitest';
import { rebasedCommandPoints } from './rebasePoints';
import { localToWorld, WORLD_WORK_PLANE, type WorkPlane } from '../../math/workplane';

/** The plane of a vertical face at y = 10.75, as Dynamic UCS builds one. */
const facePlane: WorkPlane = {
  origin: { x: 40, y: 10.75, z: 12 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 0, z: 1 },
  zAxis: { x: 0, y: -1, z: 0 },
};

/** The plane a first point snapped to that face's top corner freezes: the
 *  WCS, lifted to the corner's own height. */
const frozenPlane: WorkPlane = { ...WORLD_WORK_PLANE, origin: { x: 0, y: 0, z: 18 } };

describe('rebasedCommandPoints', () => {
  it('re-expresses a placed point so it stays exactly where it was drawn', () => {
    // The corner of the face, as LINE stored it in the frozen plane.
    const data = { start: { x: 0, y: 10.75 } };
    const world = localToWorld(frozenPlane, data.start);

    const rebased = rebasedCommandPoints(data, frozenPlane, facePlane);

    expect(rebased).not.toBeNull();
    const moved = rebased!.start as { x: number; y: number };
    expect(localToWorld(facePlane, moved)).toEqual({
      x: expect.closeTo(world.x, 9), y: expect.closeTo(world.y, 9), z: expect.closeTo(world.z, 9),
    });
    // And it is genuinely a different pair of numbers — the point moved frame,
    // which is the whole reason the stored value cannot simply be left alone.
    expect(moved).not.toEqual(data.start);
  });

  it('refuses a plane the shape does not lie in, rather than moving the shape onto it', () => {
    // A face somewhere else entirely: the line was not started on it, so it
    // belongs in the plane it was started in.
    const elsewhere: WorkPlane = { ...facePlane, origin: { x: 40, y: 3, z: 12 } };

    expect(rebasedCommandPoints({ start: { x: 0, y: 10.75 } }, frozenPlane, elsewhere)).toBeNull();
  });

  it('carries a whole polyline, not just single points', () => {
    const data = { vertices: [{ x: 0, y: 10.75 }, { x: 20, y: 10.75 }] };

    const rebased = rebasedCommandPoints(data, frozenPlane, facePlane);

    const moved = rebased!.vertices as { x: number; y: number }[];
    expect(moved).toHaveLength(2);
    moved.forEach((point, index) => {
      const world = localToWorld(facePlane, point);
      const original = localToWorld(frozenPlane, data.vertices[index]);
      expect(world.x).toBeCloseTo(original.x, 9);
      expect(world.y).toBeCloseTo(original.y, 9);
      expect(world.z).toBeCloseTo(original.z, 9);
    });
  });

  it('refuses when any one vertex of a polyline would leave the plane', () => {
    // One vertex on the face, one off it — the shape spans two planes and
    // cannot be described by either.
    const data = { vertices: [{ x: 0, y: 10.75 }, { x: 20, y: 4 }] };

    expect(rebasedCommandPoints(data, frozenPlane, facePlane)).toBeNull();
  });

  it('leaves world-space values alone — they already mean the same in every plane', () => {
    const anchor = { x: 0, y: 10.75, z: 18 };
    const data = { start: { x: 0, y: 10.75 }, drawingPlaneAnchor: anchor, startWorld: anchor };

    const rebased = rebasedCommandPoints(data, frozenPlane, facePlane);

    expect(rebased).not.toBeNull();
    expect(rebased).not.toHaveProperty('drawingPlaneAnchor');
    expect(rebased).not.toHaveProperty('startWorld');
  });

  it('ignores everything that is not a point: planes, flags, entities', () => {
    const data = {
      start: { x: 0, y: 10.75 },
      drawingPlane: frozenPlane,
      closing: true,
      sides: 6,
      entities: [{ id: 'e1', type: 'line' }],
    };

    expect(Object.keys(rebasedCommandPoints(data, frozenPlane, facePlane)!)).toEqual(['start']);
  });

  it('says "nothing to move" for a command that has placed no points yet', () => {
    expect(rebasedCommandPoints({}, frozenPlane, facePlane)).toEqual({});
  });

  it('refuses a point that carries its own elevation, rather than guessing what it should become', () => {
    // The per-point `z` convention a 3D curve uses. Those commands never
    // freeze a plane to begin with, so there is no right answer to invent.
    expect(rebasedCommandPoints({ start: { x: 0, y: 10.75, z: 2 } }, frozenPlane, facePlane)).toBeNull();
  });
});
