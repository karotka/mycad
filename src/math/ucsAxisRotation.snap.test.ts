import { describe, expect, it } from 'vitest';
import { nearestPlaneAxisDirection, rotateWorkPlaneAboutAxis } from './ucsAxisRotation';
import { WORLD_WORK_PLANE } from './workplane';

describe('nearestPlaneAxisDirection', () => {
  it('snaps an aim to the nearest of the plane\'s own six axes, so a drag turns in right angles', () => {
    // Anywhere in the +X half, but well off the axis: still X.
    expect(nearestPlaneAxisDirection(WORLD_WORK_PLANE, { x: 10, y: 4, z: -3 })).toEqual({ x: 1, y: 0, z: 0 });
    // Past 45° in Y: now Y.
    expect(nearestPlaneAxisDirection(WORLD_WORK_PLANE, { x: 4, y: 10, z: 0 })).toEqual({ x: 0, y: 1, z: 0 });
    // Negative directions are their own answers — a 180° flip is a multiple
    // of 90 too, and refusing it would make half the sphere unreachable.
    expect(nearestPlaneAxisDirection(WORLD_WORK_PLANE, { x: -10, y: 1, z: 0 })).toEqual({ x: -1, y: 0, z: 0 });
    expect(nearestPlaneAxisDirection(WORLD_WORK_PLANE, { x: 0, y: 0, z: -7 })).toEqual({ x: 0, y: 0, z: -1 });
  });

  it('answers in the plane\'s own frame, not the world\'s', () => {
    // A UCS already turned 90° about Z: its own X points along world Y.
    const turned = rotateWorkPlaneAboutAxis(WORLD_WORK_PLANE, 'z', Math.PI / 2);
    const nearest = nearestPlaneAxisDirection(turned, { x: 1, y: 9, z: 0 })!;
    expect(nearest.x).toBeCloseTo(0, 9);
    expect(nearest.y).toBeCloseTo(1, 9);
  });

  it('has no answer for an aim with no direction at all', () => {
    expect(nearestPlaneAxisDirection(WORLD_WORK_PLANE, { x: 0, y: 0, z: 0 })).toBeNull();
  });
});
