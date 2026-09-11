import { describe, expect, it } from 'vitest';
import { beginGripAxisLock, gripAxisCrossApplies, gripAxisPointUnderRay, workPlaneAxis } from './GripAxisDrag';
import { WORLD_WORK_PLANE, workPlaneFromXYAxes } from '../math/workplane';

describe('gripAxisCrossApplies', () => {
  const hot = { viewMode: '3d' as const, dragging: true, latched: true, curveType: 'bezier' };

  it('gives a curve\'s hot grip its cross in the 3D view', () => {
    expect(gripAxisCrossApplies(hot)).toBe(true);
  });

  it('does not care whether that curve stands alone or is a loft rail inside a Surface', () => {
    // The caller passes whichever curve the hot grip belongs to — shaping a
    // Surface's own embedded rail writes into the same kind of point, so it
    // gets the same cross.
    expect(gripAxisCrossApplies({ ...hot, curveType: 'bezier' })).toBe(true);
    // A rail that is not a curve with per-point elevation still gets none.
    expect(gripAxisCrossApplies({ ...hot, curveType: 'arc' })).toBe(false);
  });

  it('leaves every other drag alone, so those keep following the cursor freely instead of waiting for an axis', () => {
    // The freeze is the cross's own consequence: anything with no cross must
    // stay the plain drag it has always been.
    expect(gripAxisCrossApplies({ ...hot, viewMode: '2d' })).toBe(false);
    expect(gripAxisCrossApplies({ ...hot, curveType: 'line' })).toBe(false);
    expect(gripAxisCrossApplies({ ...hot, curveType: undefined })).toBe(false);
    expect(gripAxisCrossApplies({ ...hot, latched: false })).toBe(false);
    expect(gripAxisCrossApplies({ ...hot, dragging: false })).toBe(false);
  });
});

describe('GripAxisDrag', () => {
  const ray = (origin: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }) => ({ origin, direction });

  it('reads an axis off the entity\'s own plane, not the world axes', () => {
    // A plane standing on its side: its "z" points along world -y.
    const plane = workPlaneFromXYAxes({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    expect(workPlaneAxis(plane, 'x')).toMatchObject({ x: 1, y: 0, z: 0 });
    expect(workPlaneAxis(plane, 'z').y).toBeCloseTo(-1, 9);
    expect(workPlaneAxis(WORLD_WORK_PLANE, 'z')).toMatchObject({ x: 0, y: 0, z: 1 });
  });

  it('keeps the grip exactly where it was at the moment the axis was picked', () => {
    // The cursor is nowhere near the grip when the axis is chosen; without the
    // start offset the point would jump straight to the ray's crossing.
    const origin = { x: 5, y: 5, z: 2 };
    const pick = ray({ x: 5, y: -10, z: 9 }, { x: 0, y: 1, z: 0 });
    const lock = beginGripAxisLock('z', WORLD_WORK_PLANE, origin, pick)!;
    expect(lock).not.toBeNull();
    expect(gripAxisPointUnderRay(lock, pick)).toMatchObject({ x: 5, y: 5, z: 2 });
  });

  it('travels along world Z as the cursor rises, leaving x and y untouched', () => {
    const origin = { x: 5, y: 5, z: 2 };
    const lock = beginGripAxisLock('z', WORLD_WORK_PLANE, origin, ray({ x: 5, y: -10, z: 2 }, { x: 0, y: 1, z: 0 }))!;
    const moved = gripAxisPointUnderRay(lock, ray({ x: 5, y: -10, z: 9 }, { x: 0, y: 1, z: 0 }))!;
    expect(moved.x).toBeCloseTo(5, 9);
    expect(moved.y).toBeCloseTo(5, 9);
    expect(moved.z).toBeCloseTo(9, 9);
  });

  it('pulls the other way for a cursor below the grip, rather than slipping its sign', () => {
    const lock = beginGripAxisLock('z', WORLD_WORK_PLANE, { x: 0, y: 0, z: 0 }, ray({ x: 0, y: -10, z: 0 }, { x: 0, y: 1, z: 0 }))!;
    expect(gripAxisPointUnderRay(lock, ray({ x: 0, y: -10, z: -4 }, { x: 0, y: 1, z: 0 }))!.z).toBeCloseTo(-4, 9);
  });

  it('refuses a lock down the barrel of the axis, where every point is equally close', () => {
    expect(beginGripAxisLock('z', WORLD_WORK_PLANE, { x: 0, y: 0, z: 0 }, ray({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: -1 }))).toBeNull();
  });

  it('holds its last good position when the ray swings parallel to the locked axis', () => {
    const lock = beginGripAxisLock('z', WORLD_WORK_PLANE, { x: 0, y: 0, z: 0 }, ray({ x: 0, y: -10, z: 0 }, { x: 0, y: 1, z: 0 }))!;
    expect(gripAxisPointUnderRay(lock, ray({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: -1 }))).toBeNull();
  });
});
