import { describe, expect, it } from 'vitest';
import { axisOffsetUnderRay, verticesCentre } from './AxisDrag';

const origin = { x: 0, y: 0, z: 0 };
const up = { x: 0, y: 0, z: 1 };

describe('axisOffsetUnderRay', () => {
  it('reads the height the ray crosses the axis at', () => {
    // Looking horizontally at the Z axis from 10 away, aimed at z = 4.
    const offset = axisOffsetUnderRay(origin, up, { x: 10, y: 0, z: 4 }, { x: -1, y: 0, z: 0 });
    expect(offset).toBeCloseTo(4, 6);
  });

  it('is negative below the origin, which is what pushing a face is', () => {
    const offset = axisOffsetUnderRay(origin, up, { x: 10, y: 0, z: -3 }, { x: -1, y: 0, z: 0 });
    expect(offset).toBeCloseTo(-3, 6);
  });

  it('measures from the axis origin, not from the world', () => {
    // A face at z = 5 dragged to z = 8 has moved 3, not 8.
    const face = { x: 0, y: 0, z: 5 };
    expect(axisOffsetUnderRay(face, up, { x: 10, y: 0, z: 8 }, { x: -1, y: 0, z: 0 })).toBeCloseTo(3, 6);
  });

  it('takes the closest approach when the ray misses the axis', () => {
    // Skew: the ray runs along X, offset in Y, at z = 6. It never touches the
    // Z axis, and the nearest point on it is still z = 6.
    const offset = axisOffsetUnderRay(origin, up, { x: 10, y: 7, z: 6 }, { x: -1, y: 0, z: 0 });
    expect(offset).toBeCloseTo(6, 6);
  });

  it('follows the axis it is given, not the world Z', () => {
    const along = { x: 1, y: 0, z: 0 };
    expect(axisOffsetUnderRay(origin, along, { x: 4, y: 0, z: 10 }, { x: 0, y: 0, z: -1 })).toBeCloseTo(4, 6);
  });

  it('refuses to answer when the ray runs down the axis', () => {
    // Every point is equally close, so any number would be invented.
    expect(axisOffsetUnderRay(origin, up, { x: 0, y: 0, z: 20 }, { x: 0, y: 0, z: -1 })).toBeNull();
    expect(axisOffsetUnderRay(origin, up, { x: 3, y: 3, z: 20 }, { x: 0, y: 0, z: 1 })).toBeNull();
  });
});

describe('verticesCentre', () => {
  it('averages the vertices it is pointed at', () => {
    // Six vertices; only the last two are asked for.
    const positions = new Float32Array([0, 0, 0, 9, 9, 9, 2, 4, 6, 4, 8, 10]);
    expect(verticesCentre(positions, [2, 3])).toEqual({ x: 3, y: 6, z: 8 });
  });

  it('has no answer for no vertices', () => {
    expect(verticesCentre(new Float32Array([1, 2, 3]), [])).toBeNull();
  });
});
