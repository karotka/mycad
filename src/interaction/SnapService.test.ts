import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { measurementCandidates, nearestCandidate2d, nearestCandidateProjected, nearestEdgeWorldPoint, objectSnapCandidates, type ObjectSnapMode, type SnapCandidate } from './SnapService';
import type { Document as CadDocument } from '../core/Document';
import { createBoxMesh, createCylinderMesh } from '../core/geometry/PrimitiveMesh';
import { WORLD_WORK_PLANE, type WorkPlane } from '../math/workplane';

/** Candidates carry the snap that found them; these tests care about the points. */
const points = (doc: CadDocument, mode: ObjectSnapMode, excluded?: string | null, reference?: { x: number; y: number; z: number } | null) =>
  objectSnapCandidates(doc, mode, excluded, reference).map((candidate) => candidate.world);

describe('SnapService', () => {
  it('offers transformed endpoints and centres from inside one INSERT', () => {
    const doc = new Document();
    const definition = {
      name: 'Part', basePoint: { x: 0, y: 0 },
      entities: [doc.createLine({ x: 0, y: 0 }, { x: 4, y: 0 }), doc.createCircle({ x: 2, y: 3 }, 1)],
    };
    const insert = doc.createInsert(definition, { x: 10, y: 20 });
    insert.rotation = Math.PI / 2;
    doc.entities.push(insert);

    expect(points(doc, 'end')).toEqual(expect.arrayContaining([
      { x: 10, y: 20, z: 0 }, { x: 10, y: 24, z: 0 },
    ]));
    expect(points(doc, 'center')).toContainEqual({ x: 7, y: 22, z: 0 });
  });

  it('offers 3D endpoints and centres from a solid owned by one INSERT', () => {
    const doc = new Document();
    const solid = doc.createSolid(createBoxMesh(4, 6, 8), 'Box', 8, []);
    const definition = { name: 'SolidPart', basePoint: { x: 0, y: 0 }, entities: [], solids: [solid] };
    const insert = doc.createInsert(definition, { x: 10, y: 20 });
    insert.scaleZ = 2;
    doc.entities.push(insert);

    expect(points(doc, 'end')).toContainEqual({ x: 8, y: 17, z: 0 });
    expect(points(doc, 'end')).toContainEqual({ x: 12, y: 23, z: 16 });
    expect(points(doc, 'center')).toContainEqual({ x: 10, y: 20, z: 8 });
    expect(points(doc, 'end', insert.id)).not.toContainEqual({ x: 8, y: 17, z: 0 });
  });

  it('offers a POINT only through the Node object snap', () => {
    const doc = new Document();
    const point = doc.createPoint({ x: 3, y: 8 });
    doc.entities.push(point, doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 }));

    expect(points(doc, 'node')).toEqual([{ x: 3, y: 8, z: 0 }]);
    expect(objectSnapCandidates(doc, 'node')[0]?.mode).toBe('node');
    expect(points(doc, 'end')).not.toContainEqual({ x: 3, y: 8, z: 0 });
  });

  it('collects End, Middle and Center candidates while excluding the dragged object', () => {
    const doc = new Document();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    const circle = doc.createCircle({ x: 20, y: 5 }, 3);
    doc.entities.push(line, circle);

    expect(points(doc, 'end')).toEqual(expect.arrayContaining([
      { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 },
    ]));
    expect(points(doc, 'middle')).toContainEqual({ x: 5, y: 0, z: 0 });
    expect(points(doc, 'center')).toContainEqual({ x: 20, y: 5, z: 0 });
    expect(points(doc, 'end', line.id)).not.toContainEqual({ x: 0, y: 0, z: 0 });
  });

  it('does not expose hidden-layer points and picks the nearest candidate in the active plane', () => {
    const doc = new Document();
    const visible = doc.createLine({ x: 2, y: 3 }, { x: 8, y: 3 });
    const hidden = doc.createLine({ x: 2.1, y: 3 }, { x: 9, y: 3 });
    hidden.layer = 'Hidden';
    doc.hiddenLayers.add('Hidden');
    doc.entities.push(visible, hidden);
    const candidates = objectSnapCandidates(doc, 'end');

    expect(candidates.map((candidate) => candidate.world)).not.toContainEqual({ x: 2.1, y: 3, z: 0 });
    expect(nearestCandidate2d(candidates, { x: 2.2, y: 3 }, doc.activeWorkPlane, 1)?.world)
      .toEqual({ x: 2, y: 3, z: 0 });
  });

  it('keeps per-point 3D height for profile centres and line midpoints', () => {
    const doc = new Document();
    const circle = doc.createCircle({ x: 4, y: 5, z: 7 } as { x: number; y: number }, 2);
    const line = doc.createLine(
      { x: 0, y: 0, z: 2 } as { x: number; y: number },
      { x: 10, y: 0, z: 6 } as { x: number; y: number },
    );
    doc.entities.push(circle, line);

    expect(points(doc, 'center')).toContainEqual({ x: 4, y: 5, z: 7 });
    expect(points(doc, 'middle')).toContainEqual({ x: 5, y: 0, z: 4 });
  });

  it('calculates intersections and perpendicular feet', () => {
    const doc = new Document();
    doc.entities.push(
      doc.createLine({ x: 0, y: 0 }, { x: 10, y: 10 }),
      doc.createLine({ x: 0, y: 10 }, { x: 10, y: 0 }),
      doc.createLine({ x: 20, y: 0 }, { x: 30, y: 0 }),
    );

    expect(points(doc, 'intersection')).toContainEqual({ x: 5, y: 5, z: 0 });
    expect(points(doc, 'perpendicular', null, { x: 25, y: 8, z: 0 })).toContainEqual({ x: 25, y: 0, z: 0 });
  });

  it('finds an intersection across two different work planes, past an unrelated entity with a huge bounding box', () => {
    // The bounding-box pre-check that skips most entity pairs projects each
    // entity's box into the *other* one's plane before comparing — get that
    // transform wrong and a real crossing on a rotated plane silently
    // disappears instead of raising an error.
    const diagonal = Math.SQRT1_2;
    const rotated45: WorkPlane = {
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: diagonal, y: diagonal, z: 0 },
      yAxis: { x: -diagonal, y: diagonal, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    };
    const doc = new Document();
    const onWorldPlane = doc.createLine({ x: -10, y: 0 }, { x: 10, y: 0 });
    // A "horizontal" segment in its own 45°-rotated plane, which runs diagonally
    // through the world origin — crossing onWorldPlane's line only there.
    const onRotatedPlane = doc.createLine({ x: -10, y: 0 }, { x: 10, y: 0 });
    onRotatedPlane.workPlane = rotated45;
    // Sits far from the real crossing but bounds a huge area, exactly the
    // shape a decorative block dropped elsewhere in the drawing takes.
    const decoy = doc.createLine({ x: 10_000, y: 10_000 }, { x: -10_000, y: 10_000 });
    doc.entities.push(onWorldPlane, decoy, onRotatedPlane);

    expect(points(doc, 'intersection')).toContainEqual({ x: 0, y: 0, z: 0 });
  });

  it('finds a perpendicular foot on a real 3D solid edge', () => {
    const doc = new Document();
    const box = doc.createSolid(createBoxMesh(10, 6, 4), 'box', 4, []);
    doc.solids.push(box);

    expect(points(doc, 'perpendicular', null, { x: 8, y: 3, z: 2 }))
      .toContainEqual({ x: 5, y: 3, z: 2 });
  });

  it('does not offer a mesh vertex that is only a re-triangulation artifact, not a real corner', () => {
    // A box whose bottom face was re-triangulated around an extra vertex at
    // its centre — exactly what a subdivided or CSG-boolean-result face
    // looks like. That centre point is not a corner of anything: it sits on
    // a flat face, so every edge touching it is smooth, not a feature edge.
    const base = createBoxMesh(4, 6, 8);
    const positions = new Float32Array([...base.positions, 0, 0, 0]); // vertex 8: bottom-face centre
    const indices = new Uint32Array([
      0, 1, 8, 1, 2, 8, 2, 3, 8, 3, 0, 8, // bottom, fanned around the centre
      4, 6, 5, 4, 7, 6, // top
      0, 4, 5, 0, 5, 1, 2, 6, 7, 2, 7, 3, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2, // sides
    ]);
    const doc = new Document();
    doc.solids.push(doc.createSolid({ positions, indices }, 'box', 8, []));

    const endpoints = points(doc, 'end');
    expect(endpoints).not.toContainEqual({ x: 0, y: 0, z: 0 });
    expect(endpoints).toContainEqual({ x: -2, y: -3, z: 0 }); // a real corner is still offered
  });

  it('offers Center at both circular rims of a 3D body', () => {
    const doc = new Document();
    const cylinder = doc.createSolid(createCylinderMesh(3, 10), 'cylinder', 10, []);
    doc.solids.push(cylinder);

    const centres = points(doc, 'center');
    expect(centres).toContainEqual({ x: 0, y: 0, z: 0 });
    expect(centres).toContainEqual({ x: 0, y: 0, z: 10 });
  });

  it('keeps opposite box vertices available as 3D plane points even while the solid is selected', () => {
    const doc = new Document();
    const box = doc.createSolid(createBoxMesh(10, 6, 4), 'box', 4, []);
    doc.solids.push(box);
    doc.selectSolid(box.id);

    const candidates = measurementCandidates(doc);
    expect(candidates).toContainEqual({ x: -5, y: -3, z: 0 });
    expect(candidates).toContainEqual({ x: 5, y: 3, z: 4 });
  });

  it('nearest edge snap returns the point on the edge closest to the cursor ray', () => {
    const doc = new Document();
    doc.addEntity(doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 })); // world (0,0,0)-(10,0,0)
    const ray = { origin: { x: 5, y: 10, z: 0 }, direction: { x: 0, y: -1, z: 0 } };
    const project = (point: { x: number; y: number; z: number }) => ({ x: point.x, y: point.z });
    const world = nearestEdgeWorldPoint(doc, { x: 5, y: 0 }, ray, project, 14);
    expect(world).not.toBeNull();
    expect(world!.x).toBeCloseTo(5, 6);
    expect(world!.y).toBeCloseTo(0, 6);
    expect(world!.z).toBeCloseTo(0, 6);
  });

  it('nearest edge snap rejects an edge that projects outside the aperture', () => {
    const doc = new Document();
    doc.addEntity(doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 }));
    const ray = { origin: { x: 5, y: 10, z: 0 }, direction: { x: 0, y: -1, z: 0 } };
    const project = (point: { x: number; y: number; z: number }) => ({ x: point.x, y: point.z });
    expect(nearestEdgeWorldPoint(doc, { x: 100, y: 100 }, ray, project, 14)).toBeNull();
  });
});

describe('snap candidates carry the snap that found them', () => {
  // The marker draws a different symbol per mode, so the mode has to survive
  // the trip from the candidate to the snap target.
  it('tags every candidate with its mode', () => {
    const doc = new Document();
    doc.entities.push(doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 }), doc.createCircle({ x: 20, y: 5 }, 3));
    for (const mode of ['end', 'middle', 'center'] as const) {
      const candidates = objectSnapCandidates(doc, mode);
      expect(candidates.length, mode).toBeGreaterThan(0);
      expect(candidates.every((candidate) => candidate.mode === mode), mode).toBe(true);
    }
  });

  it('reports the mode on the resolved snap target', () => {
    const doc = new Document();
    doc.entities.push(
      doc.createLine({ x: 0, y: 0 }, { x: 10, y: 10 }),
      doc.createLine({ x: 0, y: 10 }, { x: 10, y: 0 }),
    );
    const hit = nearestCandidate2d(objectSnapCandidates(doc, 'intersection'), { x: 5, y: 5 }, doc.activeWorkPlane, 1);
    expect(hit?.mode).toBe('intersection');
  });

  it('reports perpendicular so the marker can draw the right angle', () => {
    const doc = new Document();
    doc.entities.push(doc.createLine({ x: 20, y: 0 }, { x: 30, y: 0 }));
    const candidates = objectSnapCandidates(doc, 'perpendicular', null, { x: 25, y: 8, z: 0 });
    const hit = nearestCandidate2d(candidates, { x: 25, y: 0 }, doc.activeWorkPlane, 1);
    expect(hit?.mode).toBe('perpendicular');
    expect(hit?.point).toMatchObject({ x: 25, y: 0 });
  });
});

describe('tangent object snap', () => {
  const nearlyContains = (candidates: readonly { x: number; y: number; z: number }[], expected: { x: number; y: number; z: number }) =>
    candidates.some((c) => Math.abs(c.x - expected.x) < 1e-6 && Math.abs(c.y - expected.y) < 1e-6 && Math.abs(c.z - expected.z) < 1e-6);

  it('offers both tangent points from an external point to a circle', () => {
    // A classic 3-4-5 triangle: circle radius 3, reference 5 away from the
    // centre, tangent points 4 along the perpendicular chord either side.
    const doc = new Document();
    doc.entities.push(doc.createCircle({ x: 0, y: 0 }, 3));
    const candidates = points(doc, 'tangent', null, { x: 5, y: 0, z: 0 });
    expect(candidates).toHaveLength(2);
    expect(nearlyContains(candidates, { x: 1.8, y: 2.4, z: 0 })).toBe(true);
    expect(nearlyContains(candidates, { x: 1.8, y: -2.4, z: 0 })).toBe(true);
  });

  it('offers no tangent point from on or inside the circle', () => {
    const doc = new Document();
    doc.entities.push(doc.createCircle({ x: 0, y: 0 }, 3));
    expect(points(doc, 'tangent', null, { x: 1, y: 0, z: 0 })).toEqual([]);
    expect(points(doc, 'tangent', null, { x: 3, y: 0, z: 0 })).toEqual([]);
  });

  it('excludes a tangent point that falls outside an arc\'s own sweep', () => {
    const doc = new Document();
    // A quarter arc spanning 0°–90° (top-right quadrant only): of the two
    // tangent points from (5,0) — at roughly +53° and -53° — only the first
    // actually lies on this arc.
    doc.entities.push(doc.createArc({ x: 0, y: 0 }, 3, 0, Math.PI / 2));
    const candidates = points(doc, 'tangent', null, { x: 5, y: 0, z: 0 });
    expect(candidates).toHaveLength(1);
    expect(nearlyContains(candidates, { x: 1.8, y: 2.4, z: 0 })).toBe(true);
  });

  it('tags tangent candidates with their mode', () => {
    const doc = new Document();
    doc.entities.push(doc.createCircle({ x: 0, y: 0 }, 3));
    const candidates = objectSnapCandidates(doc, 'tangent', null, { x: 5, y: 0, z: 0 });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.mode === 'tangent')).toBe(true);
  });
});

describe('nearestCandidateProjected depth tie-break', () => {
  // Perspective foreshortening routinely lands a solid's near and far corner
  // on almost the same pixel even though they are nowhere near each other in
  // the model — picking whichever merely projected fractionally closer used
  // to snap a line onto a hidden vertex sitting right behind the visible one.
  it('prefers the candidate nearer the camera among near-tied screen positions', () => {
    const nearCamera = { x: 0, y: 0, z: 0 };
    const farCamera = { x: 10, y: 10, z: 10 };
    const candidates: SnapCandidate[] = [{ world: nearCamera }, { world: farCamera }];
    // farCamera projects fractionally *closer* to the cursor (50,50) than
    // nearCamera (50,50 exactly vs 51,50) — a 1px screen-space "win" for the
    // wrong one that should lose to nearCamera's much smaller depth.
    const project = (point: { x: number; y: number; z: number }) => (point === nearCamera
      ? { x: 51, y: 50, depth: -0.5 }
      : { x: 50, y: 50, depth: 0.5 });
    const hit = nearestCandidateProjected(candidates, { x: 50, y: 50 }, project, 14, WORLD_WORK_PLANE);
    expect(hit?.world).toEqual(nearCamera);
  });

  it('still picks the genuinely closer candidate once the screen gap is not a near-tie', () => {
    const closer = { x: 0, y: 0, z: 0 };
    const fartherOnScreenButNearerCamera = { x: 10, y: 10, z: 10 };
    const candidates: SnapCandidate[] = [{ world: closer }, { world: fartherOnScreenButNearerCamera }];
    const project = (point: { x: number; y: number; z: number }) => (point === closer
      ? { x: 50, y: 50, depth: 0.5 }
      : { x: 60, y: 50, depth: -0.9 }); // 10px further — well outside the tie margin
    const hit = nearestCandidateProjected(candidates, { x: 50, y: 50 }, project, 14, WORLD_WORK_PLANE);
    expect(hit?.world).toEqual(closer);
  });
});
