import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import type { EdgeModificationFeature, ExtrusionFeature, PrimitiveFeature, SolidFeature } from '../core/entities/types';
import { primitiveMesh, regenerateSolidFeature } from '../core/solids/ManifoldEngine';
import { editedSolid, featureAt, featureLabel, featureRows, removedFeatureSolid } from './modelTree';

const sphere = (radius: number, scale?: { x: number; y: number; z: number }): PrimitiveFeature =>
  ({ kind: 'primitive', primitive: 'sphere', center: { x: 0, y: 0 }, radius, height: radius * 2, scale });

const elephant: SolidFeature = {
  kind: 'boolean', operation: 'subtract',
  operands: [
    { kind: 'boolean', operation: 'union', operands: [sphere(10), sphere(4, { x: 3, y: 1, z: 0.5 })] },
    sphere(2),
  ],
};

const chamfer = (): EdgeModificationFeature => {
  const source: PrimitiveFeature = {
    kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 10, depth: 6, height: 4,
  };
  const mesh = primitiveMesh(source);
  return {
    kind: 'edge-modification', operation: 'chamfer', source, amount: 1,
    edge: {
      solidId: 'box', start: { x: 5, y: 3, z: 0 }, end: { x: 5, y: 3, z: 4 },
      normalA: { x: 1, y: 0, z: 0 }, normalB: { x: 0, y: 1, z: 0 },
    },
    sourceMesh: { positions: Array.from(mesh.positions), indices: Array.from(mesh.indices) },
  };
};

describe('featureRows', () => {
  it('walks the tree parents first, which is the order it is drawn in', () => {
    const rows = featureRows(elephant);
    expect(rows.map((row) => `${'  '.repeat(row.depth)}${row.label}`)).toEqual([
      'Subtract',
      '  Union',
      '    Sphere',
      '    Sphere',
      '  Sphere',
    ]);
  });

  it('gives each row the path back to its feature', () => {
    const rows = featureRows(elephant);
    expect(rows.map((row) => row.path)).toEqual([[], [0], [0, 0], [0, 1], [1]]);
  });

  it('folds a collapsed branch away without losing what follows it', () => {
    const rows = featureRows(elephant, new Set(['0']));
    // The union closes up, but the subtraction's other operand is still there.
    expect(rows.map((row) => row.label)).toEqual(['Subtract', 'Union', 'Sphere']);
    expect(rows[2].path).toEqual([1]);
  });

  it('says a boolean has children and a primitive does not', () => {
    const rows = featureRows(elephant);
    expect(rows.map((row) => row.hasChildren)).toEqual([true, true, false, false, false]);
  });

  it('shows an edge operation above its source and protects the dependent source', () => {
    const rows = featureRows(chamfer());
    expect(rows.map((row) => [row.label, row.path, row.blockedByEdge])).toEqual([
      ['Chamfer', [], false],
      ['Box', [0], true],
    ]);
  });
});

describe('featureLabel', () => {
  it('shows a scale, because two spheres of one radius can be different shapes', () => {
    expect(featureLabel(sphere(4, { x: 3, y: 1, z: 0.5 }))).toEqual({ label: 'Sphere', detail: 'r 4 · 3:1:0.5' });
    expect(featureLabel(sphere(4))).toEqual({ label: 'Sphere', detail: 'r 4' });
    // A scale of one is the shape unstretched, so it says nothing.
    expect(featureLabel(sphere(4, { x: 1, y: 1, z: 1 })).detail).toBe('r 4');
  });

  it('counts what a boolean is made of', () => {
    expect(featureLabel(elephant)).toEqual({ label: 'Subtract', detail: '2 parts' });
  });

  it('names reversible edge operations and their value', () => {
    expect(featureLabel(chamfer())).toEqual({ label: 'Chamfer', detail: '1 mm' });
  });
});

describe('editedSolid', () => {
  const bounds = (solid: { mesh: { positions: Float32Array } }) => {
    let maxZ = -Infinity, maxX = -Infinity;
    for (let i = 0; i < solid.mesh.positions.length; i += 3) {
      maxX = Math.max(maxX, solid.mesh.positions[i]);
      maxZ = Math.max(maxZ, solid.mesh.positions[i + 2]);
    }
    return { maxX, maxZ };
  };

  const extruded = () => {
    const doc = new Document();
    const profile = doc.createRectangle({ x: 0, y: 0 }, { x: 10, y: 5 });
    const feature: ExtrusionFeature = {
      kind: 'extrusion', profile, height: 10, workPlane: profile.workPlane,
      transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
    };
    return { doc, feature };
  };

  it('rebuilds an extrusion when its height changes', async () => {
    const { doc, feature } = extruded();
    const solid = doc.createSolid({ positions: new Float32Array(), indices: new Uint32Array() }, 'Extrusion', 10, [], undefined, feature);

    const after = await editedSolid(solid, [], 'height', 25);

    expect(after).not.toBeNull();
    expect(bounds(after!).maxZ).toBeCloseTo(25, 4);
    // The 3D view only rebuilds a solid's geometry when its revision moves, so
    // a new mesh with the old number on it is a change that never appears.
    expect(after!.revision).toBe(solid.revision + 1);
    expect(after!.height).toBe(25);
  });

  it('stretches an extruded profile', async () => {
    const { doc, feature } = extruded();
    const solid = doc.createSolid({ positions: new Float32Array(), indices: new Uint32Array() }, 'Extrusion', 10, [], undefined, feature);
    const after = await editedSolid(solid, [], 'scaleX', 3);
    expect(bounds(after!).maxX).toBeCloseTo(30, 4);
  });

  it('leaves the original alone when the change cannot be built', async () => {
    const { doc, feature } = extruded();
    const solid = doc.createSolid({ positions: new Float32Array(), indices: new Uint32Array() }, 'Extrusion', 10, [], undefined, feature);

    expect(await editedSolid(solid, [], 'height', 0)).toBeNull();
    expect(await editedSolid(solid, [], 'radius', 4)).toBeNull();
    // Working on a copy means a refusal needs no undoing.
    expect((solid.feature as ExtrusionFeature).height).toBe(10);
  });

  it('does not touch the solid it was given', async () => {
    const { doc, feature } = extruded();
    const solid = doc.createSolid({ positions: new Float32Array(), indices: new Uint32Array() }, 'Extrusion', 10, [], undefined, feature);

    await editedSolid(solid, [], 'height', 25);

    // The caller hands the original to the history as the `before`, so an edit
    // that changed it in place would make undo a no-op.
    expect((solid.feature as ExtrusionFeature).height).toBe(10);
    expect(solid.revision).toBe(0);
  });

  it('rebuilds the whole solid from a primitive buried in a boolean', async () => {
    const doc = new Document();
    const feature: SolidFeature = {
      kind: 'boolean', operation: 'union',
      operands: [sphere(10), { ...sphere(6), center: { x: 14, y: 0 } }],
    };
    const solid = doc.createSolid({ positions: new Float32Array(), indices: new Uint32Array() }, 'Two balls', 0, [], undefined, feature);

    const after = await editedSolid(solid, [1], 'radius', 12);

    // The union reaches further than it did, which is the point of the tree
    // being a tree: the part changed, so what it was welded into changed too.
    expect(bounds(after!).maxX).toBeCloseTo(26, 1);
  });

  it('changes a chamfer amount without baking its feature', async () => {
    const doc = new Document();
    const feature = chamfer();
    const mesh = (await regenerateSolidFeature(feature))!;
    const solid = doc.createSolid(mesh, 'Chamfered box', 4, [], undefined, feature);

    const after = await editedSolid(solid, [], 'amount', 1.5);

    expect(after?.feature).toMatchObject({ kind: 'edge-modification', operation: 'chamfer', amount: 1.5 });
    expect(after?.mesh.indices.length).toBeGreaterThan(0);
  });
});

describe('removedFeatureSolid', () => {
  it('removes a chamfer and restores the feature and geometry before it', async () => {
    const doc = new Document();
    const feature = chamfer();
    const changed = (await regenerateSolidFeature(feature))!;
    const solid = doc.createSolid(changed, 'Chamfered box', 4, [], undefined, feature);

    const restored = await removedFeatureSolid(solid, []);

    expect(restored?.feature).toMatchObject({ kind: 'primitive', primitive: 'box' });
    expect(restored?.mesh.indices.length).toBe(feature.sourceMesh.indices.length);
    expect(restored?.revision).toBe(solid.revision + 1);
    expect(solid.feature.kind).toBe('edge-modification');
  });
});

describe('featureAt', () => {
  it('finds the feature a row points at', () => {
    expect(featureAt(elephant, [0, 1])).toMatchObject({ primitive: 'sphere', radius: 4 });
    expect(featureAt(elephant, [])).toBe(elephant);
    expect(featureAt(chamfer(), [0])).toMatchObject({ kind: 'primitive', primitive: 'box' });
  });

  it('returns null rather than guess when the path leads nowhere', () => {
    // The tree can change under a row that is still on screen.
    expect(featureAt(elephant, [0, 9])).toBeNull();
    expect(featureAt(elephant, [1, 0])).toBeNull(); // a primitive has no operands
  });
});
