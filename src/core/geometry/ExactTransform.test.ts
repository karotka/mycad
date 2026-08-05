import { describe, expect, it } from 'vitest';
import { WORLD_WORK_PLANE } from '../../math/workplane';
import {
  composeAffine,
  mirrorAffine,
  rotationAffine,
  scaleAffine,
  transformPoint,
  translationAffine,
} from './ExactTransform';

describe('exact affine placement', () => {
  it('composes transformations in the same order as mesh edits', () => {
    const moved = translationAffine({ x: 5, y: -2, z: 3 });
    const scaled = scaleAffine({ x: 1, y: 1, z: 1 }, { x: 2, y: 2, z: 2 });
    expect(transformPoint(composeAffine(scaled, moved), { x: 1, y: 2, z: 3 }))
      .toEqual({ x: 11, y: -1, z: 11 });
  });

  it('rotates around an arbitrary world axis', () => {
    const transform = rotationAffine({ x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, Math.PI / 2);
    const result = transformPoint(transform, { x: 12, y: 0, z: 4 });
    expect(result.x).toBeCloseTo(10, 12);
    expect(result.y).toBeCloseTo(2, 12);
    expect(result.z).toBeCloseTo(4, 12);
  });

  it('mirrors across a drawn UCS axis while leaving its Z direction intact', () => {
    const transform = mirrorAffine(WORLD_WORK_PLANE, { x: 2, y: 0 }, { x: 2, y: 5 });
    expect(transformPoint(transform, { x: 5, y: 4, z: 7 }))
      .toEqual({ x: -1, y: 4, z: 7 });
  });
});
