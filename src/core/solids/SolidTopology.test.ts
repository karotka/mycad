import { describe, expect, it } from 'vitest';
import { Document } from '../Document';
import { booleanSubtract, createBoxMesh, createCylinderMesh } from './ManifoldEngine';
import { planarFaceRegionAt, planarFaceRegions, solidCircularEdgeCenters, solidFeatureEdges, solidPlanarFaces } from './SolidTopology';

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

  it('reconstructs six outward planar faces and four-corner loops on a box', () => {
    const faces = solidPlanarFaces(createBoxMesh(10, 6, 4));
    expect(faces).toHaveLength(6);
    expect(faces.every((face) => face.triangleIndices.length === 2)).toBe(true);
    expect(faces.every((face) => face.loops.length === 1 && face.loops[0].length === 4)).toBe(true);
    expect(faces).toEqual(expect.arrayContaining([
      expect.objectContaining({ normal: expect.objectContaining({ z: expect.closeTo(1, 6) }) }),
      expect.objectContaining({ normal: expect.objectContaining({ z: expect.closeTo(-1, 6) }) }),
    ]));
  });

  it('splits a planar box face into the two regions made by a coplanar line', () => {
    const mesh = createBoxMesh(10, 6, 4);
    const top = solidPlanarFaces(mesh).find((face) => face.normal.z > 0.9)!;
    const doc = new Document();
    doc.activeWorkPlane.origin.z = 4;
    const divider = doc.createLine({ x: -5, y: 0 }, { x: 5, y: 0 });

    const regions = planarFaceRegions(top, [divider]);

    expect(regions).toHaveLength(2);
    const areas = regions.map((region) => Math.abs(region.loops[0].reduce((area, point, index) => {
      const next = region.loops[0][(index + 1) % region.loops[0].length];
      return area + point.x * next.y - next.x * point.y;
    }, 0)) / 2);
    expect(areas).toEqual([expect.closeTo(30, 6), expect.closeTo(30, 6)]);
    expect(planarFaceRegionAt(top, [divider], { x: 0, y: 2, z: 4 })).not.toEqual(
      planarFaceRegionAt(top, [divider], { x: 0, y: -2, z: 4 }),
    );
  });

  it('keeps the inner loop of a planar face around a through-hole', async () => {
    const cutter = createCylinderMesh(2, 8);
    for (let index = 2; index < cutter.positions.length; index += 3) cutter.positions[index] -= 1;
    const cut = (await booleanSubtract(createBoxMesh(12, 12, 6), cutter))!;

    const top = solidPlanarFaces(cut).find((face) => face.normal.z > 0.9 && Math.abs(face.plane.origin.z - 6) < 1e-4);

    expect(top?.loops).toHaveLength(2);
    expect(planarFaceRegionAt(top!, [], { x: 0, y: 0, z: 6 })).toBeNull();
    expect(planarFaceRegionAt(top!, [], { x: 4, y: 0, z: 6 })).not.toBeNull();
  });

  it('turns a closed coplanar sketch into an inner region and a surrounding region with a hole', () => {
    const mesh = createBoxMesh(10, 6, 4);
    const top = solidPlanarFaces(mesh).find((face) => face.normal.z > 0.9)!;
    const doc = new Document();
    doc.activeWorkPlane.origin.z = 4;
    const circle = doc.createCircle({ x: 0, y: 0 }, 1);

    const regions = planarFaceRegions(top, [circle]);

    expect(regions).toHaveLength(2);
    expect(regions.map((region) => region.loops.length).sort()).toEqual([1, 2]);
    expect(planarFaceRegionAt(top, [circle], { x: 0, y: 0, z: 4 })?.loops).toHaveLength(1);
    expect(planarFaceRegionAt(top, [circle], { x: 3, y: 0, z: 4 })?.loops).toHaveLength(2);
  });
});
