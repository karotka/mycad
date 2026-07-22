import { describe, expect, it } from 'vitest';
import { WORLD_WORK_PLANE, type WorkPlane } from '../math/workplane';
import { DynamicUcsController } from './DynamicUcsController';

const verticalFace: WorkPlane = {
  origin: { x: 4, y: 2, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 0, z: 1 },
  zAxis: { x: 0, y: -1, z: 0 },
};

describe('DynamicUcsController', () => {
  it('captures the previous UCS and restores it after using a face', () => {
    const controller = new DynamicUcsController();
    const temporary = controller.acquire(WORLD_WORK_PLANE, verticalFace, { x: 7, y: 2, z: 3 }, 'box:front');

    expect(temporary).toEqual({ ...verticalFace, origin: { x: 7, y: 2, z: 3 } });
    expect(controller.isTemporary).toBe(true);
    expect(controller.release()).toEqual(WORLD_WORK_PLANE);
    expect(controller.isTemporary).toBe(false);
  });

  it('keeps one origin while hovering the same face and follows another face before locking', () => {
    const controller = new DynamicUcsController();
    controller.acquire(WORLD_WORK_PLANE, verticalFace, { x: 5, y: 2, z: 2 }, 'box:front');

    expect(controller.acquire(verticalFace, verticalFace, { x: 8, y: 2, z: 4 }, 'box:front')).toBeNull();
    const other = controller.acquire(verticalFace, WORLD_WORK_PLANE, { x: 3, y: 4, z: 0 }, 'box:top');
    expect(other?.origin).toEqual({ x: 3, y: 4, z: 0 });
    expect(controller.release()).toEqual(WORLD_WORK_PLANE);
  });

  it('does not change face after the first point is locked', () => {
    const controller = new DynamicUcsController();
    controller.acquire(WORLD_WORK_PLANE, verticalFace, verticalFace.origin, 'box:front');
    controller.lock();

    expect(controller.acquire(verticalFace, WORLD_WORK_PLANE, WORLD_WORK_PLANE.origin, 'box:top')).toBeNull();
    expect(controller.isLocked).toBe(true);
  });

  it('F6 off releases a temporary plane and blocks acquisition until enabled again', () => {
    const controller = new DynamicUcsController();
    controller.acquire(WORLD_WORK_PLANE, verticalFace, verticalFace.origin, 'box:front');

    expect(controller.toggle()).toEqual(WORLD_WORK_PLANE);
    expect(controller.enabled).toBe(false);
    expect(controller.acquire(WORLD_WORK_PLANE, verticalFace, verticalFace.origin, 'box:front')).toBeNull();
    expect(controller.toggle()).toBeNull();
    expect(controller.enabled).toBe(true);
  });
});
