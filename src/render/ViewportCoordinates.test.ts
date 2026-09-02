import { describe, expect, it } from 'vitest';
import { cadToThree, standardViewDelta, threeToCad, viewCubeTransform } from './ViewportCoordinates';

describe('viewport coordinate conversion', () => {
  it('round-trips CAD and Three.js axes', () => {
    expect(threeToCad(cadToThree({ x: 2, y: 3, z: 4 }))).toEqual({ x: 2, y: 3, z: 4 });
  });

  it('maps screen motion to the visible axes of standard views', () => {
    expect(standardViewDelta({ x: 5, y: -2 }, 'top')).toEqual({ x: 5, y: -2, z: 0 });
    expect(standardViewDelta({ x: 5, y: -2 }, 'front')).toEqual({ x: 5, y: 0, z: -2 });
    expect(standardViewDelta({ x: 5, y: -2 }, 'left')).toEqual({ x: 0, y: -5, z: -2 });
  });
});

describe('viewCubeTransform', () => {
  it('shows TOP in 2D mode regardless of the (unused) 3D camera angle', () => {
    // A stale isometric-ish camera pose left over from before 3D was ever
    // entered — the very bug being fixed: it must not leak into 2D mode.
    const stale = { azimuth: Math.PI / 4, elevation: Math.PI / 4 };
    expect(viewCubeTransform('2d', stale)).toEqual({ tilt: -90, spin: -90 });
  });

  it('always shows the same TOP pose in 2D mode, no matter what the camera angle is', () => {
    expect(viewCubeTransform('2d', { azimuth: 0, elevation: 0 })).toEqual({ tilt: -90, spin: -90 });
    expect(viewCubeTransform('2d', { azimuth: Math.PI, elevation: -Math.PI / 2 })).toEqual({ tilt: -90, spin: -90 });
  });

  it('follows the camera angle in 3D mode', () => {
    const { tilt, spin } = viewCubeTransform('3d', { azimuth: 0, elevation: Math.PI / 2 });
    expect(tilt).toBeCloseTo(-90, 9);
    expect(spin).toBeCloseTo(-90, 9);
  });

  it('reflects a non-top 3D camera angle', () => {
    const { tilt, spin } = viewCubeTransform('3d', { azimuth: Math.PI / 2, elevation: 0 });
    expect(tilt).toBeCloseTo(0, 9);
    expect(spin).toBeCloseTo(-180, 9);
  });
});
