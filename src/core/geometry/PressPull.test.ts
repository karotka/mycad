import { describe, expect, it } from 'vitest';
import { Document } from '../Document';
import { booleanExactSolids, buildExactBox, buildExactFeature, pressPullExactSolid } from './ExactSolid';
import { runBooleanJob } from './booleanJob';
import { exactBooleanMeshes } from './FeatureMesh';
import type { SolidFaceRegion } from '../entities/types';

// Reproduce the reported "can't finish PRESSPULL" on a boolean-derived solid:
// a base plate with a hole subtracted, then push/pull one of its side faces.
describe('pressPull on a boolean-derived solid', () => {
  it('pushes a side face of a plate-with-hole without throwing', async () => {
    const doc = new Document();
    const plate = await buildExactBox({
      kind: 'primitive', primitive: 'box',
      center: { x: 0, y: 0 }, width: 40, depth: 20, height: 10,
    });
    const holeFeature = {
      kind: 'primitive' as const, primitive: 'cylinder' as const,
      center: { x: 0, y: 0 }, radius: 3, height: 30,
    };
    const hole = await buildExactFeature(holeFeature);
    // Boolean subtract → a faceted B-rep, exactly what the app produces for a
    // solid built by cutting holes.
    const boolean = await exactBooleanMeshes('subtract', [plate.mesh, hole!.mesh]);
    const solid = doc.createSolid(boolean!, 'Plate', 10, [], undefined, { kind: 'mesh' });

    // The +X side face at x=20, its outward normal +X.
    const region: SolidFaceRegion = {
      plane: {
        origin: { x: 20, y: 0, z: 5 },
        xAxis: { x: 0, y: 1, z: 0 },
        yAxis: { x: 0, y: 0, z: 1 },
        zAxis: { x: 1, y: 0, z: 0 },
      },
      loops: [[
        { x: -10, y: -5 }, { x: 10, y: -5 }, { x: 10, y: 5 }, { x: -10, y: 5 },
      ]],
    };

    const result = await pressPullExactSolid(solid, region, 5, solid.revision + 1);
    expect(result).not.toBeNull();
  });

  it('returns null instead of throwing when the region is degenerate', async () => {
    const doc = new Document();
    const plate = await buildExactBox({
      kind: 'primitive', primitive: 'box',
      center: { x: 0, y: 0 }, width: 40, depth: 20, height: 10,
    });
    const solid = doc.createSolid(plate.mesh, 'Plate', 10, [], undefined, {
      kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 40, depth: 20, height: 10,
    });
    solid.exact = plate.exact;

    // A collapsed loop cannot be extruded into a tool: the kernel throws, and the
    // command step must see a clean null rather than a rejection that wedges it.
    const degenerate: SolidFaceRegion = {
      plane: {
        origin: { x: 20, y: 0, z: 5 },
        xAxis: { x: 0, y: 1, z: 0 },
        yAxis: { x: 0, y: 0, z: 1 },
        zAxis: { x: 1, y: 0, z: 0 },
      },
      loops: [[{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]],
    };

    // A throw here would fail the test outright — which is the regression we guard.
    const result = await pressPullExactSolid(solid, degenerate, 5, solid.revision + 1);
    expect(result).toBeNull();
  });
});

// A slice leaves faceted `mesh` solids; cutting a chunk off one with a boolean is
// the standard move, so it must run on mesh-featured solids, not just exact ones.
describe('boolean on a mesh-featured solid (slice remnant)', () => {
  it('subtracts a cutter box from a faceted mesh solid without throwing', async () => {
    const doc = new Document();
    const plate = await buildExactBox({
      kind: 'primitive', primitive: 'box',
      center: { x: 0, y: 0 }, width: 40, depth: 20, height: 10,
    });
    // A raw mesh solid, exactly what SLICE produces — no feature tree.
    const remnant = doc.createSolid(plate.mesh, 'Slice remnant', 10, [], undefined, { kind: 'mesh' });
    const cutter = await buildExactBox({
      kind: 'primitive', primitive: 'box',
      center: { x: 15, y: 0 }, width: 20, depth: 30, height: 20,
    });
    const cutterSolid = doc.createSolid(cutter.mesh, 'Cutter', 20, [], undefined, {
      kind: 'primitive', primitive: 'box', center: { x: 15, y: 0 }, width: 20, depth: 30, height: 20,
    });
    cutterSolid.exact = cutter.exact;

    const result = await booleanExactSolids('subtract', [remnant, cutterSolid], 1);
    expect(result).not.toBeNull();
    expect(result!.mesh.indices.length).toBeGreaterThan(0);
    // The cut took: the +X half is gone, so the solid no longer reaches x=20.
    const maxX = Math.max(...Array.from(result!.mesh.positions).filter((_v, i) => i % 3 === 0));
    expect(maxX).toBeLessThan(6);
  });
});

// The boolean runs in a Web Worker in the browser; in Node (here and the headless
// MCP server) runBooleanJob runs the same core inline. This exercises that core,
// and specifically both operand sources: an already-exact B-rep passed straight
// through, and a feature rebuilt from scratch — the rebuild being the step that
// must happen off the main thread because it runs its own booleans.
describe('runBooleanJob core', () => {
  it('unions an exact operand with one rebuilt from its feature, off the main thread', async () => {
    const boxFeature = { kind: 'primitive' as const, primitive: 'box' as const, center: { x: 5, y: 0 }, width: 10, depth: 10, height: 10 };
    const a = await buildExactBox({ kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 10, depth: 10, height: 10 });
    const b = await buildExactBox(boxFeature);

    const result = await runBooleanJob('union', [
      { source: 'exact', shape: a.exact.shape },
      // No exact shape given — the worker must rebuild this operand from its feature.
      { source: 'feature', feature: boxFeature, positions: b.mesh.positions, indices: b.mesh.indices },
    ], 1);

    expect(result).not.toBeNull();
    expect(result!.exact.revision).toBe(1);
    const xs = Array.from(result!.mesh.positions).filter((_v, i) => i % 3 === 0);
    // The two boxes centred at x=0 and x=5 (each 10 wide) fuse into x ∈ [-5, 10].
    expect(Math.min(...xs)).toBeCloseTo(-5, 3);
    expect(Math.max(...xs)).toBeCloseTo(10, 3);
  });
});
