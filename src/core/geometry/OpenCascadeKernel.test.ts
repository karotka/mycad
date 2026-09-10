import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type OpenCascadeKernel,
  type OpenCascadeSolid,
} from './OpenCascadeKernel';
import { createNodeOpenCascadeKernel } from './OpenCascadeNode';
import { solidDesignEdges, solidPlanarFaces } from '../solids/SolidTopology';
import { mirrorAffine, scaleAffine, translationAffine } from './ExactTransform';
import { WORLD_WORK_PLANE } from '../../math/workplane';

describe('OpenCascade exact-kernel spike', () => {
  let kernel: OpenCascadeKernel;
  const owned: OpenCascadeSolid[] = [];
  const keep = (solid: OpenCascadeSolid): OpenCascadeSolid => {
    owned.push(solid);
    return solid;
  };

  beforeAll(async () => {
    kernel = await createNodeOpenCascadeKernel();
  });

  afterAll(() => {
    owned.reverse().forEach((solid) => solid.dispose());
  });

  it('restores a sliced and re-united box to one valid six-face B-rep', () => {
    const box = keep(kernel.makeBox({ x: 20, y: 30, z: 40 }));
    expect(kernel.inspect(box)).toMatchObject({
      faceCount: 6,
      solidCount: 1,
      valid: true,
      volume: expect.closeTo(24_000, 8),
    });

    const pieces = kernel.splitByPlane(box, {
      origin: { x: 7, y: 0, z: 0 },
      normal: { x: 1, y: 0, z: 0 },
    });
    pieces.forEach(keep);
    expect(pieces).toHaveLength(2);
    expect(pieces.map((piece) => kernel.inspect(piece).volume).sort((a, b) => a - b))
      .toEqual([8_400, 15_600]);

    const fused = keep(kernel.union(pieces));
    const healed = keep(kernel.heal(fused));
    const result = kernel.inspect(healed);

    expect(result.valid).toBe(true);
    expect(result.solidCount).toBe(1);
    expect(result.faceCount).toBe(6);
    expect(result.volume).toBeCloseTo(24_000, 8);
    expect(result.bounds.min).toEqual({ x: 0, y: 0, z: 0 });
    expect(result.bounds.max).toEqual({ x: 20, y: 30, z: 40 });
  });

  it('promotes a legacy closed triangle mesh to a valid faceted B-rep', () => {
    const source = keep(kernel.makeBox({ x: 4, y: 5, z: 6 }));
    const mesh = kernel.tessellate(source);
    const faceted = keep(kernel.fromMesh(mesh.positions, mesh.indices));
    const healed = keep(kernel.heal(faceted));
    expect(kernel.inspect(healed)).toMatchObject({
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 5, z: 6 } },
      faceCount: 6,
      solidCount: 1,
      volume: expect.closeTo(120, 7),
      valid: true,
    });
  });

  it('places a box in an arbitrary right-handed UCS', () => {
    const box = keep(kernel.makeOrientedBox(
      { x: 20, y: 30, z: 40 },
      { x: 10, y: 20, z: 30 },
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 0, z: 0 },
    ));
    expect(kernel.inspect(box)).toMatchObject({
      bounds: {
        min: { x: 10, y: 20, z: 30 },
        max: { x: 50, y: 40, z: 60 },
      },
      faceCount: 6,
      volume: expect.closeTo(24_000, 8),
      valid: true,
    });
  });

  it('builds the remaining MyCAD primitives as valid analytic B-reps', () => {
    const cylinder = keep(kernel.makeCylinder(3, 7, { x: 1, y: 2, z: 3 }));
    expect(kernel.inspect(cylinder)).toMatchObject({
      bounds: { min: { x: -2, y: -1, z: 3 }, max: { x: 4, y: 5, z: 10 } },
      faceCount: 3,
      volume: expect.closeTo(63 * Math.PI, 8),
      valid: true,
    });

    const cone = keep(kernel.makeCone(3, 0, 7));
    expect(kernel.inspect(cone)).toMatchObject({
      bounds: { min: { x: -3, y: -3, z: 0 }, max: { x: 3, y: 3, z: expect.closeTo(7, 10) } },
      faceCount: 2,
      volume: expect.closeTo(21 * Math.PI, 8),
      valid: true,
    });

    const sphere = keep(kernel.makeSphere(3));
    expect(kernel.inspect(sphere)).toMatchObject({
      bounds: { min: { x: -3, y: -3, z: -3 }, max: { x: 3, y: 3, z: 3 } },
      faceCount: 1,
      volume: expect.closeTo(36 * Math.PI, 8),
      valid: true,
    });

    const torus = keep(kernel.makeTorus(5, 1));
    expect(kernel.inspect(torus)).toMatchObject({
      bounds: {
        min: { x: expect.closeTo(-6, 5), y: expect.closeTo(-6, 5), z: expect.closeTo(-1, 5) },
        max: { x: expect.closeTo(6, 5), y: expect.closeTo(6, 5), z: expect.closeTo(1, 5) },
      },
      faceCount: 1,
      volume: expect.closeTo(10 * Math.PI ** 2, 8),
      valid: true,
    });

    const wedge = keep(kernel.makeWedge({ x: 4, y: 6, z: 8 }));
    expect(kernel.inspect(wedge)).toMatchObject({
      bounds: {
        min: { x: expect.closeTo(0, 10), y: 0, z: 0 },
        max: { x: 4, y: expect.closeTo(6, 10), z: 8 },
      },
      faceCount: 5,
      volume: expect.closeTo(96, 8),
      valid: true,
    });

    const pyramid = keep(kernel.makePyramid(3, 6));
    expect(kernel.inspect(pyramid)).toMatchObject({
      bounds: {
        min: { x: expect.closeTo(-3 / Math.sqrt(2), 5), y: expect.closeTo(-3 / Math.sqrt(2), 5), z: expect.closeTo(0, 5) },
        max: { x: expect.closeTo(3 / Math.sqrt(2), 5), y: expect.closeTo(3 / Math.sqrt(2), 5), z: expect.closeTo(6, 5) },
      },
      faceCount: 5,
      volume: expect.closeTo(36, 8),
      valid: true,
    });
  });

  it('subtracts and intersects overlapping solids without leaving the B-rep kernel', () => {
    const base = keep(kernel.makeBox({ x: 10, y: 10, z: 10 }));
    const overlap = keep(kernel.makeBox({ x: 10, y: 10, z: 10 }, { x: 5, y: 0, z: 0 }));
    const cut = keep(kernel.subtract(base, [overlap]));
    const common = keep(kernel.intersect([base, overlap]));

    expect(kernel.inspect(cut)).toMatchObject({
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 10, z: 10 } },
      faceCount: 6,
      solidCount: 1,
      volume: expect.closeTo(500, 8),
      valid: true,
    });
    expect(kernel.inspect(common)).toMatchObject({
      bounds: { min: { x: 5, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
      faceCount: 6,
      solidCount: 1,
      volume: expect.closeTo(500, 8),
      valid: true,
    });
  });

  it('extrudes polygon and analytic circle profiles along exact vectors', () => {
    const polygon = keep(kernel.extrudePolygon([
      { x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 },
      { x: 2, y: 2, z: 0 }, { x: 0, y: 2, z: 0 },
    ], { x: 0, y: 0, z: 5 }));
    expect(kernel.inspect(polygon)).toMatchObject({
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 5 } },
      faceCount: 6,
      volume: expect.closeTo(20, 8),
      valid: true,
    });

    const circle = keep(kernel.extrudeCircle(2, { x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 5 }));
    expect(kernel.inspect(circle)).toMatchObject({
      bounds: {
        min: { x: expect.closeTo(-2, 5), y: expect.closeTo(-2, 5), z: 0 },
        max: { x: expect.closeTo(5, 5), y: expect.closeTo(2, 5), z: 5 },
      },
      faceCount: 3,
      volume: expect.closeTo(20 * Math.PI, 8),
      valid: true,
    });
  });

  it('lofts a polygon section into a circle section — not only polygon-to-polygon', () => {
    const rectangleSection = { kind: 'polygon' as const, points: [
      { x: -5, y: -5, z: 0 }, { x: 5, y: -5, z: 0 }, { x: 5, y: 5, z: 0 }, { x: -5, y: 5, z: 0 },
    ] };
    const circleSection = {
      kind: 'circle' as const,
      center: { x: 0, y: 0, z: 20 },
      normal: { x: 0, y: 0, z: 1 },
      xAxis: { x: 1, y: 0, z: 0 },
      radius: 3,
    };
    const loft = keep(kernel.loftProfiles([rectangleSection, circleSection]));
    const inspected = kernel.inspect(loft);
    expect(inspected.valid).toBe(true);
    expect(inspected.solidCount).toBe(1);
    expect(inspected.bounds).toMatchObject({
      min: { x: expect.closeTo(-5, 4), y: expect.closeTo(-5, 4), z: expect.closeTo(0, 4) },
      max: { x: expect.closeTo(5, 4), y: expect.closeTo(5, 4), z: expect.closeTo(20, 4) },
    });
  });

  it('lofts two closed Bezier-wire sections without corrupting the result — regression for a real crash', () => {
    // A section built from two Bezier edges (the same shape LOFT's own Bezier
    // profile support produces) at two different sizes/heights. ThruSections
    // itself used to build this fine, but disposing the section's pole/curve
    // objects right after Build() left the returned shape holding a dangling
    // reference into them — invisible until something evaluates the surface
    // (inspect()'s bounding box), which then crashed the whole OCCT instance
    // (an embind "table index is out of bounds"). A polygon or circle section
    // never exercises this, which is why it went unnoticed until a real
    // closed Bezier profile reached this far.
    const ovalSection = (size: number, z: number) => {
      const start = { x: 0, y: 0, z };
      const c1 = { x: 0, y: size, z };
      const c2 = { x: size, y: size, z };
      const mid = { x: size, y: 0, z };
      const c3 = { x: size * 0.6, y: -size * 0.4, z };
      const c4 = { x: size * 0.2, y: -size * 0.4, z };
      return { kind: 'wire' as const, edges: [
        { kind: 'bezier' as const, poles: [start, c1, c2, mid] },
        { kind: 'bezier' as const, poles: [mid, c3, c4, start] },
      ] };
    };
    const loft = keep(kernel.loftProfiles([ovalSection(10, 0), ovalSection(6, 10)]));
    expect(kernel.inspect(loft)).toMatchObject({ solidCount: 1, valid: true });
  });

  it('lofts along a curved guide path, not just straight-interpolating between sections', () => {
    const rectangleSection = { kind: 'polygon' as const, points: [
      { x: -5, y: -5, z: 0 }, { x: 5, y: -5, z: 0 }, { x: 5, y: 5, z: 0 }, { x: -5, y: 5, z: 0 },
    ] };
    const circleSection = {
      kind: 'circle' as const,
      center: { x: 0, y: 0, z: 20 },
      normal: { x: 0, y: 0, z: 1 },
      xAxis: { x: 1, y: 0, z: 0 },
      radius: 3,
    };
    // A quarter-circle path bulging toward +x, from (0,0,0) up to (0,0,20).
    const arcPath = [{
      kind: 'arc' as const,
      center: { x: 10, y: 0, z: 10 },
      normal: { x: 0, y: 1, z: 0 },
      xAxis: { x: -1, y: 0, z: 0 },
      radius: 10,
      startAngle: Math.PI,
      sweepAngle: Math.PI / 2,
    }];
    const straightPath = [{ kind: 'line' as const, start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 20 } }];

    const guided = keep(kernel.loftAlongPath([rectangleSection, circleSection], arcPath));
    const straight = keep(kernel.loftAlongPath([rectangleSection, circleSection], straightPath));

    expect(kernel.inspect(guided).valid).toBe(true);
    expect(kernel.inspect(straight).valid).toBe(true);
    // The arc path bulges toward +x, so that loft reaches further in x than
    // the same two sections lofted along a plain straight path.
    expect(kernel.inspect(guided).bounds.max.x).toBeGreaterThan(kernel.inspect(straight).bounds.max.x + 1);
  });

  it('lofts a single closed profile bent along a path — AutoCAD\'s single-cross-section LOFT with a guide', () => {
    // A flat, closed Bezier-wire profile (the same shape a hand-drawn,
    // mirrored-and-joined silhouette produces) — no second section at all.
    const flatOutline = {
      kind: 'wire' as const,
      edges: [
        { kind: 'bezier' as const, poles: [
          { x: 4.5, y: 12, z: 0 }, { x: 5.3, y: 12.9, z: 0 }, { x: 20, y: 19, z: 0 }, { x: 51.5, y: 11.5, z: 0 },
        ] },
        { kind: 'bezier' as const, poles: [
          { x: 51.5, y: 11.5, z: 0 }, { x: 20, y: 5, z: 0 }, { x: 5.3, y: 11.1, z: 0 }, { x: 4.5, y: 12, z: 0 },
        ] },
      ],
    };
    const path = [{
      kind: 'arc' as const,
      center: { x: 20, y: 0, z: -20 },
      normal: { x: 0, y: -1, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      radius: 20,
      startAngle: Math.PI * 0.3,
      sweepAngle: Math.PI * 0.4,
    }];
    const bent = keep(kernel.loftAlongPath([flatOutline], path));
    const inspected = kernel.inspect(bent);
    expect(inspected.valid).toBe(true);
    expect(inspected.solidCount).toBe(1);
    // The point of bending a flat (z = 0) profile along the path: it must
    // actually leave its own plane, not come out still flat.
    expect(inspected.bounds.max.z - inspected.bounds.min.z).toBeGreaterThan(1);
  });

  it('keeps a single-profile guided loft close to its own flat size with a fixed orientation, instead of ballooning', () => {
    // The exact same profile and path as the test above — reported directly
    // as the result coming out "noticeably bigger" than the original flat
    // outline. Without a fixed reference, MakePipeShell's default law rotates
    // the section to track the path's own Frenet frame as it moves — right
    // for a pipe, wrong for bending a flat silhouette that should roughly
    // keep its own orientation. Confirmed directly against this exact
    // profile: the default law let it balloon from z ∈ [0,0] out to roughly
    // [-9, 1.3] for a path meant to bend it only gently.
    const flatOutline = {
      kind: 'wire' as const,
      edges: [
        { kind: 'bezier' as const, poles: [
          { x: 4.5, y: 12, z: 0 }, { x: 5.3, y: 12.9, z: 0 }, { x: 20, y: 19, z: 0 }, { x: 51.5, y: 11.5, z: 0 },
        ] },
        { kind: 'bezier' as const, poles: [
          { x: 51.5, y: 11.5, z: 0 }, { x: 20, y: 5, z: 0 }, { x: 5.3, y: 11.1, z: 0 }, { x: 4.5, y: 12, z: 0 },
        ] },
      ],
    };
    const path = [{
      kind: 'arc' as const,
      center: { x: 20, y: 0, z: -20 },
      normal: { x: 0, y: -1, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      radius: 20,
      startAngle: Math.PI * 0.3,
      sweepAngle: Math.PI * 0.4,
    }];
    const unpinned = keep(kernel.loftAlongPath([flatOutline], path));
    const pinned = keep(kernel.loftAlongPath([flatOutline], path, {
      origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xAxis: { x: 1, y: 0, z: 0 },
    }));
    const unpinnedBounds = kernel.inspect(unpinned).bounds;
    const pinnedBounds = kernel.inspect(pinned).bounds;
    const unpinnedZSpan = unpinnedBounds.max.z - unpinnedBounds.min.z;
    const pinnedZSpan = pinnedBounds.max.z - pinnedBounds.min.z;
    // Still genuinely bent (the whole point of the path)…
    expect(pinnedZSpan).toBeGreaterThan(0.1);
    // …but nowhere near as exaggerated as the unpinned default.
    expect(pinnedZSpan).toBeLessThan(unpinnedZSpan / 2);
  });

  it('lofts two open rails through a guide curve, bending the surface to follow it — AutoCAD LOFT\'s "Guides" option', () => {
    // The same flat, z=0 silhouette as the tests above, but as two SEPARATE
    // open rails (never joined into one wire) — exactly the real workflow:
    // draw one Bezier, mirror it into the other half, and loft between the
    // two halves directly rather than a single closed outline.
    const rail1 = [{ kind: 'bezier' as const, poles: [
      { x: 4.5, y: 12, z: 0 }, { x: 5.3, y: 12.9, z: 0 }, { x: 20, y: 19, z: 0 }, { x: 51.5, y: 11.5, z: 0 },
    ] }];
    const rail2 = [{ kind: 'bezier' as const, poles: [
      { x: 4.5, y: 12, z: 0 }, { x: 5.3, y: 11.1, z: 0 }, { x: 20, y: 5, z: 0 }, { x: 51.5, y: 11.5, z: 0 },
    ] }];
    // Touches each rail near its own true endpoints (z=0) but bulges to
    // z=8 in between — the only way a flat pair of rails can end up bent.
    const guide = [{ kind: 'bezier' as const, poles: [
      { x: 28, y: 15, z: 0 }, { x: 28, y: 15, z: 8 }, { x: 28, y: 8, z: 8 }, { x: 28, y: 8, z: 0 },
    ] }];

    const flat = keep(kernel.loftGuidedSurface(rail1, rail2, []));
    const bent = keep(kernel.loftGuidedSurface(rail1, rail2, [guide]));

    const flatBounds = kernel.inspect(flat).bounds;
    const bentBounds = kernel.inspect(bent).bounds;
    // No guide at all: a plain two-rail Coons fill between two z=0 curves
    // stays flat, same as the plain 2-curve case validated separately.
    expect(flatBounds.max.z - flatBounds.min.z).toBeLessThan(1e-6);
    // With the guide: the surface actually leaves the z=0 plane to follow it.
    expect(bentBounds.max.z - bentBounds.min.z).toBeGreaterThan(3);
    // Still roughly the same footprint in x/y as the original flat outline —
    // this bends the existing rails, it does not balloon past them.
    expect(bentBounds.max.x).toBeCloseTo(flatBounds.max.x, 0);
    expect(bentBounds.min.x).toBeCloseTo(flatBounds.min.x, 0);
  });

  it('lofts two open rails through TWO guide curves, bending each interior strip on its own', () => {
    // Same rails as above, but with a second guide further along — exercises
    // the interior (guide-to-guide) patch, the one case with no rail corner
    // on either side to anchor against.
    const rail1 = [{ kind: 'bezier' as const, poles: [
      { x: 4.5, y: 12, z: 0 }, { x: 5.3, y: 12.9, z: 0 }, { x: 20, y: 19, z: 0 }, { x: 51.5, y: 11.5, z: 0 },
    ] }];
    const rail2 = [{ kind: 'bezier' as const, poles: [
      { x: 4.5, y: 12, z: 0 }, { x: 5.3, y: 11.1, z: 0 }, { x: 20, y: 5, z: 0 }, { x: 51.5, y: 11.5, z: 0 },
    ] }];
    const guideA = [{ kind: 'bezier' as const, poles: [
      { x: 18, y: 16, z: 0 }, { x: 18, y: 16, z: 5 }, { x: 18, y: 9, z: 5 }, { x: 18, y: 9, z: 0 },
    ] }];
    const guideB = [{ kind: 'bezier' as const, poles: [
      { x: 38, y: 14, z: 0 }, { x: 38, y: 14, z: 5 }, { x: 38, y: 8, z: 5 }, { x: 38, y: 8, z: 0 },
    ] }];

    // Guide order shouldn't matter — they are sorted by where they actually
    // touch the first rail, not by selection order.
    const bent = keep(kernel.loftGuidedSurface(rail1, rail2, [guideB, guideA]));
    const bounds = kernel.inspect(bent).bounds;
    expect(bounds.max.z - bounds.min.z).toBeGreaterThan(3);
    expect(bounds.max.x).toBeCloseTo(51.5, 0);
    expect(bounds.min.x).toBeCloseTo(4.5, 0);
  });

  it('lofts two straight-edged (multi-segment polyline) rails through an arc guide — GeomFill_CoonsStyle rejected this outright', () => {
    // Real regression: a user's own two-rail pair, both plain 3-segment
    // polylines (no curvature at all), threw "GeomFill_BSplineCurves:
    // invalid filling style" with the original GeomFill_CoonsStyle choice —
    // confirmed directly against their real project file, not just this
    // synthetic shape. The same real file's OTHER pair (curved Bezier
    // rails), which did build, visibly twisted between patches wherever a
    // hand-drawn guide's own tangent didn't closely match the rails' at the
    // touch point — Coons tries to match tangents it has no good data for.
    // GeomFill_StretchStyle has neither failure mode.
    const rail1 = [
      { kind: 'line' as const, start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: -5, z: 0 } },
      { kind: 'line' as const, start: { x: 10, y: -5, z: 0 }, end: { x: 20, y: -8, z: 0 } },
      { kind: 'line' as const, start: { x: 20, y: -8, z: 0 }, end: { x: 30, y: -3, z: 0 } },
    ];
    const rail2 = [
      { kind: 'line' as const, start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 3, z: 0 } },
      { kind: 'line' as const, start: { x: 10, y: 3, z: 0 }, end: { x: 20, y: 5, z: 0 } },
      { kind: 'line' as const, start: { x: 20, y: 5, z: 0 }, end: { x: 30, y: -3, z: 0 } },
    ];
    const guide = [{
      kind: 'arc' as const, center: { x: 15, y: 1, z: -5 }, normal: { x: 0, y: 1, z: 0 }, xAxis: { x: 1, y: 0, z: 0 },
      radius: 5, startAngle: 0, sweepAngle: Math.PI,
    }];

    const bent = keep(kernel.loftGuidedSurface(rail1, rail2, [guide]));
    const inspected = kernel.inspect(bent);
    expect(inspected.valid).toBe(true);
    expect(inspected.faceCount).toBeGreaterThan(0);
  });

  it('rejects a guided loft whose two rails do not share both their own endpoints', () => {
    const rail1 = [{ kind: 'line' as const, start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } }];
    const rail2 = [{ kind: 'line' as const, start: { x: 0, y: 5, z: 0 }, end: { x: 10, y: 5, z: 0 } }];
    expect(() => kernel.loftGuidedSurface(rail1, rail2, [])).toThrow(/share both their own endpoints/);
  });

  it('extrudes a wire profile of mixed line and arc edges into a real curved solid, not a facetted one', () => {
    const wire = keep(kernel.extrudeWire([
      { kind: 'line', start: { x: -2, y: 0, z: 0 }, end: { x: 2, y: 0, z: 0 } },
      {
        kind: 'arc',
        center: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 1, y: 0, z: 0 },
        radius: 2,
        startAngle: 0,
        sweepAngle: Math.PI,
      },
    ], { x: 0, y: 0, z: 5 }));
    expect(kernel.inspect(wire)).toMatchObject({
      bounds: {
        min: { x: expect.closeTo(-2, 6), y: expect.closeTo(0, 6), z: 0 },
        max: { x: expect.closeTo(2, 6), y: expect.closeTo(2, 6), z: 5 },
      },
      // Two flat caps plus one flat and one genuinely curved side wall — a
      // faceted approximation of the arc would instead show up as many.
      faceCount: 4,
      volume: expect.closeTo(10 * Math.PI, 6),
      valid: true,
    });
  });

  it('sweeps exact polygon and circle profiles along analytic paths', () => {
    const straight = keep(kernel.sweep({
      kind: 'polygon',
      points: [
        { x: 0, y: -1, z: -1 }, { x: 0, y: 1, z: -1 },
        { x: 0, y: 1, z: 1 }, { x: 0, y: -1, z: 1 },
      ],
    }, [{ kind: 'line', start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } }]));
    expect(kernel.inspect(straight)).toMatchObject({
      bounds: { min: { x: 0, y: -1, z: -1 }, max: { x: 10, y: 1, z: 1 } },
      volume: expect.closeTo(40, 7),
      valid: true,
    });

    const quarterArc = keep(kernel.sweep({
      kind: 'circle',
      center: { x: 10, y: 0, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      xAxis: { x: 0, y: 0, z: 1 },
      radius: 1,
    }, [{
      kind: 'arc',
      center: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
      xAxis: { x: 1, y: 0, z: 0 },
      radius: 10,
      startAngle: 0,
      sweepAngle: Math.PI / 2,
    }]));
    expect(kernel.inspect(quarterArc)).toMatchObject({
      volume: expect.closeTo(5 * Math.PI ** 2, 6),
      valid: true,
    });

    const bezier = keep(kernel.sweep({
      kind: 'circle',
      center: { x: 0, y: 0, z: 0 },
      normal: { x: 1, y: 0, z: 0 },
      xAxis: { x: 0, y: 1, z: 0 },
      radius: 0.5,
    }, [{
      kind: 'bezier',
      poles: [
        { x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 },
        { x: 7, y: 2, z: 0 }, { x: 10, y: 2, z: 0 },
      ],
    }]));
    expect(kernel.inspect(bezier)).toMatchObject({ solidCount: 1, valid: true });

    // A closed loop of mixed edges — half straight, half curved — as the cross
    // section, the same vocabulary a closed spline profile is built from.
    const wireProfile = keep(kernel.sweep({
      kind: 'wire',
      edges: [
        { kind: 'line', start: { x: 0, y: -2, z: 0 }, end: { x: 0, y: 2, z: 0 } },
        {
          kind: 'arc',
          center: { x: 0, y: 0, z: 0 },
          normal: { x: 1, y: 0, z: 0 },
          xAxis: { x: 0, y: 1, z: 0 },
          radius: 2,
          startAngle: 0,
          sweepAngle: Math.PI,
        },
      ],
    }, [{ kind: 'line', start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } }]));
    expect(kernel.inspect(wireProfile)).toMatchObject({
      volume: expect.closeTo(20 * Math.PI, 6),
      valid: true,
    });
  });

  it('extrudes a bounded region with a real inner hole', () => {
    const region = keep(kernel.extrudeRegion([
      [
        { x: -5, y: -5, z: 0 }, { x: 5, y: -5, z: 0 },
        { x: 5, y: 5, z: 0 }, { x: -5, y: 5, z: 0 },
      ],
      [
        { x: -2, y: -2, z: 0 }, { x: -2, y: 2, z: 0 },
        { x: 2, y: 2, z: 0 }, { x: 2, y: -2, z: 0 },
      ],
    ], { x: 0, y: 0, z: 3 }));
    expect(kernel.inspect(region)).toMatchObject({
      faceCount: 10,
      solidCount: 1,
      volume: expect.closeTo((100 - 16) * 3, 7),
      valid: true,
    });
  });

  it('fillets and asymmetrically chamfers an exact edge selected by its support faces', () => {
    const box = keep(kernel.makeBox({ x: 10, y: 10, z: 10 }));
    const mesh = kernel.tessellate(box);
    const incident = new Map<string, Set<number>>();
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      const ids = [mesh.indices[offset], mesh.indices[offset + 1], mesh.indices[offset + 2]];
      for (let edge = 0; edge < 3; edge++) {
        const a = ids[edge], b = ids[(edge + 1) % 3];
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        const faces = incident.get(key) ?? new Set<number>();
        faces.add(mesh.triangleFaceIds[offset / 3]);
        incident.set(key, faces);
      }
    }
    const faceIds = [...incident.values()].find((faces) => faces.size === 2);
    expect(faceIds).toBeDefined();
    const reference = { faceIds: [...faceIds!] as [number, number] };
    const fillet = keep(kernel.fillet(box, reference, 1));
    const chamfer = keep(kernel.chamfer(box, reference, 1, 2));

    expect(kernel.inspect(fillet)).toMatchObject({ solidCount: 1, valid: true });
    expect(kernel.inspect(chamfer)).toMatchObject({ solidCount: 1, valid: true });
    expect(kernel.inspect(fillet).volume).toBeLessThan(1000);
    expect(kernel.inspect(chamfer).volume).toBeLessThan(1000);

    let restored: OpenCascadeSolid | null = null;
    for (let faceId = 0; faceId < kernel.inspect(fillet).faceCount; faceId++) {
      try {
        const candidate = kernel.deleteFaces(fillet, [faceId]);
        if (Math.abs(kernel.inspect(candidate).volume - 1000) < 1e-6) {
          restored = candidate;
          break;
        }
        candidate.dispose();
      } catch {
        // Only the generated fillet face is a removable local feature.
      }
    }
    expect(restored).not.toBeNull();
    if (restored) {
      keep(restored);
      expect(kernel.inspect(restored)).toMatchObject({ faceCount: 6, volume: expect.closeTo(1000, 6), valid: true });
    }
  });

  it('keeps edge modifications on promoted faceted solids valid after a BREP round trip', () => {
    const analytic = keep(kernel.makeBox({ x: 10, y: 6, z: 4 }));
    const mesh = kernel.tessellate(analytic);
    const faceted = keep(kernel.heal(keep(kernel.fromMesh(mesh.positions, mesh.indices))));
    const facetedMesh = kernel.tessellate(faceted);
    const incident = new Map<string, Set<number>>();
    for (let offset = 0; offset < facetedMesh.indices.length; offset += 3) {
      const ids = [facetedMesh.indices[offset], facetedMesh.indices[offset + 1], facetedMesh.indices[offset + 2]];
      for (let edge = 0; edge < 3; edge++) {
        const a = ids[edge], b = ids[(edge + 1) % 3];
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        const faces = incident.get(key) ?? new Set<number>();
        faces.add(facetedMesh.triangleFaceIds[offset / 3]);
        incident.set(key, faces);
      }
    }
    const faceIds = [...incident.values()].find((faces) => faces.size === 2);
    expect(faceIds).toBeDefined();
    const reference = { faceIds: [...faceIds!] as [number, number] };

    for (const modified of [
      keep(kernel.fillet(faceted, reference, 1)),
      keep(kernel.chamfer(faceted, reference, 1, 1)),
    ]) {
      const restored = keep(kernel.deserialize(kernel.serialize(modified)));
      expect(kernel.inspect(restored)).toMatchObject({ solidCount: 1, valid: true });
    }

    const chamfer = keep(kernel.chamfer(faceted, reference, 1, 1));
    let unchamfered: OpenCascadeSolid | null = null;
    for (let faceId = 0; faceId < kernel.inspect(chamfer).faceCount; faceId++) {
      try {
        const candidate = kernel.deleteFaces(chamfer, [faceId]);
        if (Math.abs(kernel.inspect(candidate).volume - 240) < 1e-6) {
          unchamfered = candidate;
          break;
        }
        candidate.dispose();
      } catch {
        // Only the generated chamfer face is a removable local feature.
      }
    }
    expect(unchamfered).not.toBeNull();
    if (unchamfered) {
      keep(unchamfered);
      expect(kernel.inspect(unchamfered)).toMatchObject({ faceCount: 6, volume: expect.closeTo(240, 6), valid: true });
    }
  });

  it('keeps transformed B-reps valid for both rigid and non-uniform placements', () => {
    const box = keep(kernel.makeBox({ x: 2, y: 3, z: 4 }));
    const moved = keep(kernel.transform(box, translationAffine({ x: 10, y: -5, z: 2 })));
    expect(kernel.inspect(moved)).toMatchObject({
      bounds: { min: { x: 10, y: -5, z: 2 }, max: { x: 12, y: -2, z: 6 } },
      volume: expect.closeTo(24, 9),
      valid: true,
    });

    const mirrored = keep(kernel.transform(box, mirrorAffine(
      WORLD_WORK_PLANE,
      { x: 0, y: 0 },
      { x: 0, y: 1 },
    )));
    expect(kernel.inspect(mirrored)).toMatchObject({
      bounds: { min: { x: -2, y: 0, z: 0 }, max: { x: 0, y: 3, z: 4 } },
      volume: expect.closeTo(24, 9),
      valid: true,
    });

    const stretched = keep(kernel.transform(moved, scaleAffine(
      { x: 10, y: -5, z: 2 },
      { x: 2, y: 3, z: 0.5 },
    )));
    expect(kernel.inspect(stretched)).toMatchObject({
      bounds: {
        min: { x: expect.closeTo(10, 5), y: expect.closeTo(-5, 5), z: expect.closeTo(2, 5) },
        max: { x: expect.closeTo(14, 5), y: expect.closeTo(4, 5), z: expect.closeTo(4, 5) },
      },
      volume: expect.closeTo(72, 8),
      valid: true,
    });
  });

  it('also removes the seam after an oblique slice through the box', () => {
    const box = keep(kernel.makeBox({ x: 20, y: 30, z: 40 }));
    const pieces = kernel.splitByPlane(box, {
      origin: { x: 10, y: 15, z: 20 },
      normal: { x: 1, y: 1, z: 1 },
    });
    pieces.forEach(keep);

    expect(pieces).toHaveLength(2);
    expect(pieces.map((piece) => kernel.inspect(piece).volume))
      .toEqual([expect.closeTo(12_000, 8), expect.closeTo(12_000, 8)]);

    const fused = keep(kernel.union(pieces));
    const healed = keep(kernel.heal(fused));

    expect(kernel.inspect(healed)).toMatchObject({
      faceCount: 6,
      solidCount: 1,
      valid: true,
      volume: expect.closeTo(24_000, 8),
    });

    const tessellation = kernel.tessellate(healed);
    expect(tessellation.indices.length).toBeGreaterThan(0);
    expect(tessellation.triangleFaceIds).toHaveLength(tessellation.indices.length / 3);
    expect(new Set(tessellation.triangleFaceIds)).toHaveLength(6);
    expect(solidPlanarFaces(tessellation)).toHaveLength(6);
    expect(solidDesignEdges(tessellation)).toHaveLength(12);

    const serialized = kernel.serialize(healed);
    expect(serialized).toMatchObject({ format: 'occt-brep-v1' });
    expect(serialized.data).toContain('CASCADE Topology V3');
    const restored = keep(kernel.deserialize(serialized));
    expect(kernel.inspect(restored)).toMatchObject({
      faceCount: 6,
      solidCount: 1,
      valid: true,
      volume: expect.closeTo(24_000, 8),
    });
    expect(solidDesignEdges(kernel.tessellate(restored))).toHaveLength(12);
  });

  it('round-trips one or more solids through a STEP file as real B-rep', () => {
    const box = keep(kernel.makeBox({ x: 20, y: 30, z: 40 }));
    const step = kernel.writeStep([box]);
    expect(step).toContain('ISO-10303-21');
    const [restored] = kernel.readStep(step).map(keep);
    expect(kernel.inspect(restored)).toMatchObject({
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 30, z: 40 } },
      faceCount: 6,
      volume: expect.closeTo(24_000, 6),
      valid: true,
    });

    const sphere = keep(kernel.makeSphere(5, { x: 100, y: 0, z: 0 }));
    const multi = kernel.writeStep([box, sphere]);
    const shapes = kernel.readStep(multi).map(keep);
    expect(shapes).toHaveLength(2);
    const volumes = shapes.map((shape) => kernel.inspect(shape).volume).sort((a, b) => a - b);
    expect(volumes[0]).toBeCloseTo((4 / 3) * Math.PI * 125, 3);
    expect(volumes[1]).toBeCloseTo(24_000, 3);
  });

  it('refuses to export nothing and to read a file with no shapes', () => {
    expect(() => kernel.writeStep([])).toThrow('at least one solid');
    expect(() => kernel.readStep('not a step file')).toThrow();
  });
});
