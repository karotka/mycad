import { describe, expect, it } from 'vitest';
import { booleanSubtract, createBoxMesh, createCylinderMesh } from './ManifoldEngine';
import { solidCircularEdgeCenters, solidFeatureEdges } from './SolidTopology';

describe('solid feature topology', () => {
  it('keeps box creases and discards coplanar triangle diagonals', () => {
    expect(solidFeatureEdges(createBoxMesh(10, 6, 4))).toHaveLength(12);
  });

  it('recognises both circular end loops without exposing cylinder facets', () => {
    const mesh = createCylinderMesh(3, 10);
    const centres = solidCircularEdgeCenters(mesh);
    expect(centres).toHaveLength(2);
    expect(centres).toEqual(expect.arrayContaining([
      expect.objectContaining({ x: 0, y: 0, z: 0 }),
      expect.objectContaining({ x: 0, y: 0, z: 10 }),
    ]));
    expect(solidFeatureEdges(mesh)).toHaveLength(64);
  });

  it('finds both ends of a round through-hole after a boolean cut', async () => {
    const cutter = createCylinderMesh(2, 8);
    for (let index = 2; index < cutter.positions.length; index += 3) cutter.positions[index] -= 1;
    const cut = await booleanSubtract(createBoxMesh(12, 12, 6), cutter);
    expect(cut).not.toBeNull();

    const centres = solidCircularEdgeCenters(cut!);
    expect(centres.some((point) => Math.hypot(point.x, point.y) < 1e-5 && Math.abs(point.z) < 1e-5)).toBe(true);
    expect(centres.some((point) => Math.hypot(point.x, point.y) < 1e-5 && Math.abs(point.z - 6) < 1e-5)).toBe(true);
  });
});
