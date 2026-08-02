import { describe, expect, it } from 'vitest';
import { Document } from '../Document';
import { booleanSubtract, createBoxMesh, createConeMesh, createCylinderMesh } from './ManifoldEngine';
import { planarFaceRegionAt, planarFaceRegions, solidCircularEdgeCenters, solidCircularEdges, solidFeatureEdges, solidPlanarFaces } from './SolidTopology';
import { localToWorld, WORLD_WORK_PLANE } from '../../math/workplane';

describe('solid feature topology', () => {
  it('keeps box creases and discards coplanar triangle diagonals', () => {
    expect(solidFeatureEdges(createBoxMesh(10, 6, 4))).toHaveLength(12);
  });

  it('recognises both circular end loops without exposing cylinder facets', () => {
    const mesh = createCylinderMesh(3, 10);
    const circles = solidCircularEdges(mesh);
    const centres = solidCircularEdgeCenters(mesh);
    expect(circles).toHaveLength(2);
    expect(circles.every((circle) => Math.abs(circle.radius - 3) < 1e-5)).toBe(true);
    expect(circles.every((circle) => circle.points.length >= 8)).toBe(true);
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

  it('recognises both concentric base rims after subtracting one cone from another', async () => {
    const cut = await booleanSubtract(
      createConeMesh(6, 10),
      createConeMesh(3, 10),
    );
    expect(cut).not.toBeNull();

    const innerSegments = solidFeatureEdges(cut!).filter((edge) =>
      [edge.start, edge.end].every((point) =>
        Math.abs(point.z) < 1e-4 && Math.abs(Math.hypot(point.x, point.y) - 3) < 1e-3
      )
    );
    expect(innerSegments.length, 'inner feature segments').toBe(64);
    const circles = solidCircularEdges(cut!)
      .filter((circle) => Math.abs(circle.center.z) < 1e-4)
      .sort((first, second) => first.radius - second.radius);
    expect(circles.map((circle) => circle.radius)).toEqual([
      expect.closeTo(3, 3),
      expect.closeTo(6, 3),
    ]);
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

  it('welds a CSG seam so one flat face is not shattered into coplanar fragments', () => {
    // Two coplanar triangles forming a square, but the shared diagonal is two
    // separate, minutely-offset vertex copies — exactly the seam a boolean cut
    // leaves in a float32 mesh. Index-based adjacency would read this as two
    // faces; PRESSPULL then pulls only one triangular sliver of a flat plate.
    const eps = 3e-4;
    const positions = new Float32Array([
      0, 0, 0, 2, 0, 0, 2, 2, 0,
      eps, 0, 0, 2, 2 - eps, 0, 0, 2, 0,
    ]);
    const faces = solidPlanarFaces({ positions, indices: new Uint32Array([0, 1, 2, 3, 4, 5]) });
    expect(faces).toHaveLength(1);
    expect(faces[0].loops[0].length).toBe(4);
  });

  it('still resolves a hit that sits a hair off a large face plane, but not one genuinely off it', () => {
    // A big merged face's plane, fitted from one triangle, leaves far points a
    // little off it — a real hit can be ~1e-4 out, which a fixed tolerance
    // wrongly rejected, making the whole plate unselectable.
    const size = 50;
    const face = {
      triangleIndices: [], vertexIndices: [], normal: { x: 0, y: 0, z: 1 }, plane: WORLD_WORK_PLANE,
      loops: [[{ x: -size, y: -size }, { x: size, y: -size }, { x: size, y: size }, { x: -size, y: size }]],
    };
    expect(planarFaceRegionAt(face, [], { x: size - 1, y: size - 1, z: 2e-4 })).not.toBeNull();
    expect(planarFaceRegionAt(face, [], { x: 0, y: 0, z: 1 })).toBeNull();
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

  it('splits a face by a divider that sits a hair off the plane (float32 drift)', () => {
    const mesh = createBoxMesh(10, 6, 4);
    const top = solidPlanarFaces(mesh).find((face) => face.normal.z > 0.9)!;
    const doc = new Document();
    // The divider's plane is a touch above the face — as a line drawn on a
    // float32 face is. The old exact 1e-5 guard dropped it and PRESSPULL then
    // grabbed the whole face instead of one half.
    doc.activeWorkPlane.origin.z = 4 + 1e-4;
    const divider = doc.createLine({ x: -5, y: 0 }, { x: 5, y: 0 });
    expect(planarFaceRegions(top, [divider])).toHaveLength(2);
  });

  it('splits a face that has a hole and gives the bore to the side it sits on', async () => {
    const cut = (await booleanSubtract(createBoxMesh(20, 20, 10, 0, 0, 0), createCylinderMesh(1.5, 20, 5, 0, 32)))!;
    const top = solidPlanarFaces(cut).find((face) => face.normal.z > 0.9 && Math.abs(face.plane.origin.z - 10) < 1e-2)!;
    const doc = new Document();
    doc.activeWorkPlane.origin.z = 10;
    const divider = doc.createLine({ x: 0, y: -10 }, { x: 0, y: 10 }); // cuts at x = 0; the bore sits at x = +5
    expect(planarFaceRegions(top, [divider])).toHaveLength(2);
    expect(planarFaceRegionAt(top, [divider], { x: -5, y: 0, z: 10 })?.loops.length).toBe(1);
    expect(planarFaceRegionAt(top, [divider], { x: 5, y: 5, z: 10 })?.loops.length).toBe(2);
  });

  it('does not split a face by a divider that runs along its edge', () => {
    const mesh = createBoxMesh(10, 6, 4);
    const top = solidPlanarFaces(mesh).find((face) => face.normal.z > 0.9)!;
    const doc = new Document();
    doc.activeWorkPlane.origin.z = 4;
    const onEdge = doc.createLine({ x: 5, y: -3 }, { x: 5, y: 3 }); // the +X edge of the top face
    expect(planarFaceRegions(top, [onEdge])).toHaveLength(1);
  });

  it('honours endpoint Z when a WCS line visibly crosses a vertical face', () => {
    const mesh = createBoxMesh(10, 6, 4);
    const front = solidPlanarFaces(mesh).find((face) => face.normal.y < -0.9)!;
    const doc = new Document();
    const divider = doc.createLine(
      { x: -5, y: -3, z: 2 } as { x: number; y: number },
      { x: 5, y: -3, z: 2 } as { x: number; y: number },
    );

    const regions = planarFaceRegions(front, [divider]);

    expect(regions).toHaveLength(2);
    expect(planarFaceRegionAt(front, [divider], { x: 0, y: -3, z: 3 })).not.toEqual(
      planarFaceRegionAt(front, [divider], { x: 0, y: -3, z: 1 }),
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

  it('uses the centre Z of a closed WCS profile on a parallel face', () => {
    const top = solidPlanarFaces(createBoxMesh(10, 6, 4)).find((face) => face.normal.z > 0.9)!;
    const doc = new Document();
    const circle = doc.createCircle({ x: 0, y: 0, z: 4 } as { x: number; y: number }, 1);

    expect(planarFaceRegions(top, [circle])).toHaveLength(2);
  });

  it('clips a circle crossing a face edge into a selectable partial region', () => {
    const front = solidPlanarFaces(createBoxMesh(10, 6, 4)).find((face) => face.normal.y < -0.9)!;
    const xs = front.loops[0].map((point) => point.x), ys = front.loops[0].map((point) => point.y);
    const edgeX = Math.min(...xs), centreY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const radius = Math.min(Math.max(...xs) - edgeX, Math.max(...ys) - Math.min(...ys)) / 4;
    const doc = new Document();
    doc.activeWorkPlane = front.plane;
    const circle = doc.createCircle({ x: edgeX, y: centreY }, radius);

    const regions = planarFaceRegions(front, [circle]);

    expect(regions).toHaveLength(2);
    const inside = localToWorld(front.plane, { x: edgeX + radius / 2, y: centreY });
    const outside = localToWorld(front.plane, { x: Math.max(...xs) - radius / 2, y: centreY });
    expect(planarFaceRegionAt(front, [circle], inside)).not.toEqual(planarFaceRegionAt(front, [circle], outside));
    const boundaryPick = localToWorld(front.plane, { x: edgeX, y: centreY });
    const selectedLoop = planarFaceRegionAt(front, [circle], boundaryPick)!.loops[0];
    const selectedArea = Math.abs(selectedLoop.reduce((area, point, index) => {
      const next = selectedLoop[(index + 1) % selectedLoop.length];
      return area + point.x * next.y - next.x * point.y;
    }, 0)) / 2;
    expect(selectedArea).toBeLessThan(10);
  });

  it('accepts rectangles, ellipses, octagons and closed polylines as face regions', () => {
    const top = solidPlanarFaces(createBoxMesh(10, 6, 4)).find((face) => face.normal.z > 0.9)!;
    const doc = new Document();
    doc.activeWorkPlane.origin.z = 4;
    const profiles = [
      doc.createRectangle({ x: -1, y: -1 }, { x: 1, y: 1 }),
      doc.createEllipse({ x: 0, y: 0 }, 1.5, 0.75),
      doc.createOctagon({ x: 0, y: 0 }, 1),
      doc.createPolyline([{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 0, y: 1 }], true),
    ];

    for (const profile of profiles) expect(planarFaceRegions(top, [profile]), profile.type).toHaveLength(2);
  });
});
