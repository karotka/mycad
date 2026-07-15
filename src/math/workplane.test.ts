import { describe, expect, it } from 'vitest';
import { localToWorld, workPlaneFromXAxis, workPlaneFromXYAxes, worldToLocal } from './workplane';

describe('work plane transforms', () => {
  it('builds a UCS from origin and positive X point', () => {
    const plane = workPlaneFromXAxis({ x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }, { x: 0, y: 0, z: 1 });
    expect(plane.xAxis).toEqual({ x: 0, y: 1, z: 0 });
    const world = localToWorld(plane, { x: 2, y: 3 }, 5);
    const local = worldToLocal(plane, world);
    expect(local.x).toBeCloseTo(2);
    expect(local.y).toBeCloseTo(3);
    expect(local.z).toBeCloseTo(5);
  });

  it('builds a right-handed UCS from origin, X and Y points', () => {
    const plane = workPlaneFromXYAxes(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
    );
    expect(plane.xAxis).toEqual({ x: 0, y: 1, z: 0 });
    expect(plane.yAxis).toEqual({ x: 0, y: 0, z: 1 });
    expect(plane.zAxis).toEqual({ x: 1, y: 0, z: 0 });
  });
});
