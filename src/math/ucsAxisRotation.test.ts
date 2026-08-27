import { describe, expect, it } from 'vitest';
import { pointWorkPlaneAxisAt } from './ucsAxisRotation';
import { WORLD_WORK_PLANE } from './workplane';

describe('pointWorkPlaneAxisAt', () => {
  it('points Z at the target and keeps a right-handed orthonormal frame', () => {
    const plane = pointWorkPlaneAxisAt(WORLD_WORK_PLANE, 'z', { x: 0, y: 10, z: 10 })!;
    expect(plane.zAxis.x).toBeCloseTo(0, 10);
    expect(plane.zAxis.y).toBeCloseTo(Math.SQRT1_2, 10);
    expect(plane.zAxis.z).toBeCloseTo(Math.SQRT1_2, 10);
    for (const axis of [plane.xAxis, plane.yAxis, plane.zAxis]) expect(Math.hypot(axis.x, axis.y, axis.z)).toBeCloseTo(1, 10);
    expect(plane.xAxis.x * plane.yAxis.x + plane.xAxis.y * plane.yAxis.y + plane.xAxis.z * plane.yAxis.z).toBeCloseTo(0, 10);
    const cross = { x: plane.xAxis.y * plane.yAxis.z - plane.xAxis.z * plane.yAxis.y, y: plane.xAxis.z * plane.yAxis.x - plane.xAxis.x * plane.yAxis.z, z: plane.xAxis.x * plane.yAxis.y - plane.xAxis.y * plane.yAxis.x };
    expect(cross).toMatchObject(plane.zAxis);
  });

  it('rejects dropping an axis on its own origin', () => {
    expect(pointWorkPlaneAxisAt(WORLD_WORK_PLANE, 'x', WORLD_WORK_PLANE.origin)).toBeNull();
  });
});
