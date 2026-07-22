import { describe, expect, it } from 'vitest';
import type { EdgeModificationFeature, PressPullFeature, PrimitiveFeature, SolidFeature, SolidMesh } from '../entities/types';
import { primitiveMesh, regenerateSolidFeature } from './ManifoldEngine';
import { mirroredFeature, rotatedFeature, scaledFeature, translatedFeature } from './featureTransform';
import { solidPlanarFaces } from './SolidTopology';

const sphere = (over: Partial<PrimitiveFeature> = {}): PrimitiveFeature =>
  ({ kind: 'primitive', primitive: 'sphere', center: { x: 0, y: 0 }, radius: 4, height: 8, ...over });

const edgeFeature = (): EdgeModificationFeature => {
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

const pressPullFeature = (): PressPullFeature => {
  const source: PrimitiveFeature = {
    kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 10, depth: 6, height: 4,
  };
  const mesh = primitiveMesh(source);
  const face = solidPlanarFaces(mesh).find((candidate) => candidate.normal.z > 0.9)!;
  return {
    kind: 'presspull-region', source, region: { plane: face.plane, loops: face.loops }, distance: 2,
    sourceMesh: { positions: Array.from(mesh.positions), indices: Array.from(mesh.indices) },
  };
};

/** What the old code did: drag every vertex, and forget how the solid was made. */
function bakedScale(mesh: SolidMesh, base: { x: number; y: number; z: number }, factor: number): Float32Array {
  const out = mesh.positions.slice();
  for (let i = 0; i < out.length; i += 3) {
    out[i] = base.x + (out[i] - base.x) * factor;
    out[i + 1] = base.y + (out[i + 1] - base.y) * factor;
    out[i + 2] = base.z + (out[i + 2] - base.z) * factor;
  }
  return out;
}

const bounds = (positions: Float32Array) => {
  const span = (axis: number) => {
    let min = Infinity, max = -Infinity;
    for (let i = axis; i < positions.length; i += 3) { min = Math.min(min, positions[i]); max = Math.max(max, positions[i]); }
    return { min, max };
  };
  return { x: span(0), y: span(1), z: span(2) };
};

const closeTo = (actual: ReturnType<typeof bounds>, expected: ReturnType<typeof bounds>, digits = 3) => {
  for (const axis of ['x', 'y', 'z'] as const) {
    expect(actual[axis].min, `${axis} min`).toBeCloseTo(expected[axis].min, digits);
    expect(actual[axis].max, `${axis} max`).toBeCloseTo(expected[axis].max, digits);
  }
};

describe('scaledFeature', () => {
  it('gives the same solid the vertex-dragging did', async () => {
    // The point of the whole exercise: keeping the history must not change the
    // shape. If these disagree, the tree describes something else.
    const feature = sphere();
    const before = (await regenerateSolidFeature(feature))!;
    const base = { x: 10, y: -4, z: 2 };

    const after = (await regenerateSolidFeature(scaledFeature(feature, base, 3)!))!;

    closeTo(bounds(after.positions), bounds(bakedScale(before, base, 3)));
  });

  it('scales about the base, so a solid centred on it does not move', async () => {
    const feature = sphere();
    const scaled = (await regenerateSolidFeature(scaledFeature(feature, { x: 0, y: 0, z: 0 }, 2)!))!;
    closeTo(bounds(scaled.positions), { x: { min: -8, max: 8 }, y: { min: -8, max: 8 }, z: { min: -8, max: 8 } });
  });

  it('keeps a scaled ellipsoid an ellipsoid, and still a primitive', () => {
    const feature = sphere({ scale: { x: 3, y: 1, z: 0.5 } });
    const scaled = scaledFeature(feature, { x: 0, y: 0, z: 0 }, 2) as PrimitiveFeature;
    expect(scaled.kind).toBe('primitive');
    expect(scaled.radius).toBe(4);
    // Multiplied, not replaced: a squashed sphere made twice as big is still
    // squashed the same way.
    expect(scaled.scale).toEqual({ x: 6, y: 2, z: 1 });
  });

  it('scales every part of a boolean, so what it welded still fits', async () => {
    const feature: SolidFeature = {
      kind: 'boolean', operation: 'union',
      operands: [sphere(), { ...sphere({ radius: 2 }), workPlane: plane({ x: 6, y: 0, z: 0 }) }],
    };
    const before = (await regenerateSolidFeature(feature))!;
    const base = { x: 1, y: 2, z: 3 };
    const after = (await regenerateSolidFeature(scaledFeature(feature, base, 2.5)!))!;
    closeTo(bounds(after.positions), bounds(bakedScale(before, base, 2.5)), 1);
  });

  it('has nothing to say about a mesh or a sweep', () => {
    expect(scaledFeature({ kind: 'mesh' }, { x: 0, y: 0, z: 0 }, 2)).toBeNull();
    // One operand it cannot write down makes the whole tree a lie.
    expect(scaledFeature({ kind: 'boolean', operation: 'union', operands: [sphere(), { kind: 'mesh' }] }, { x: 0, y: 0, z: 0 }, 2)).toBeNull();
  });

  it('refuses a factor that is not one', () => {
    expect(scaledFeature(sphere(), { x: 0, y: 0, z: 0 }, 0)).toBeNull();
    expect(scaledFeature(sphere(), { x: 0, y: 0, z: 0 }, Number.NaN)).toBeNull();
  });

  it('keeps a chamfer editable and scales its distance and saved source', async () => {
    const scaled = scaledFeature(edgeFeature(), { x: 0, y: 0, z: 0 }, 2)!;
    expect(scaled).toMatchObject({ kind: 'edge-modification', amount: 2 });
    expect((await regenerateSolidFeature(scaled))?.indices.length).toBeGreaterThan(0);
  });

  it('scales a PressPull region, distance and saved source together', async () => {
    const scaled = scaledFeature(pressPullFeature(), { x: 0, y: 0, z: 0 }, 2)!;
    expect(scaled).toMatchObject({ kind: 'presspull-region', distance: 4 });
    closeTo(bounds((await regenerateSolidFeature(scaled))!.positions), {
      x: { min: -10, max: 10 }, y: { min: -6, max: 6 }, z: { min: 0, max: 12 },
    });
  });
});

function plane(origin: { x: number; y: number; z: number }) {
  return { origin, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 } };
}

describe('translatedFeature', () => {
  const delta = { x: 3, y: -4, z: 5 };

  const extrusion = (workPlane?: ReturnType<typeof plane>): SolidFeature => ({
    kind: 'extrusion',
    profile: { id: 'p', type: 'rectangle', layer: '0', aci: 256, color: 0xffffff, selected: false, first: { x: 0, y: 0 }, opposite: { x: 10, y: 5 } },
    height: 4,
    workPlane,
    transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
  });

  it('moves an extrusion by its plane, not by its transform', async () => {
    // The transform moves the *profile*, in the plane's own coordinates. On a
    // plane turned a quarter turn, adding a world delta to it sends the solid
    // somewhere else entirely — which is what the copy code used to do.
    const turned = { origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 0, y: 1, z: 0 }, yAxis: { x: -1, y: 0, z: 0 }, zAxis: { x: 0, y: 0, z: 1 } };
    const before = (await regenerateSolidFeature(extrusion(turned)))!;
    const after = (await regenerateSolidFeature(translatedFeature(extrusion(turned), delta)!))!;

    const box = bounds(before.positions);
    closeTo(bounds(after.positions), {
      x: { min: box.x.min + delta.x, max: box.x.max + delta.x },
      y: { min: box.y.min + delta.y, max: box.y.max + delta.y },
      z: { min: box.z.min + delta.z, max: box.z.max + delta.z },
    });
  });

  it('moves a primitive and everything a boolean is made of', async () => {
    const feature: SolidFeature = {
      kind: 'boolean', operation: 'union',
      operands: [sphere(), { ...sphere({ radius: 2 }), workPlane: plane({ x: 6, y: 0, z: 0 }) }],
    };
    const before = (await regenerateSolidFeature(feature))!;
    const after = (await regenerateSolidFeature(translatedFeature(feature, delta)!))!;
    const box = bounds(before.positions);
    closeTo(bounds(after.positions), {
      x: { min: box.x.min + delta.x, max: box.x.max + delta.x },
      y: { min: box.y.min + delta.y, max: box.y.max + delta.y },
      z: { min: box.z.min + delta.z, max: box.z.max + delta.z },
    }, 1);
  });

  it('has nothing to move on a bare mesh', () => {
    expect(translatedFeature({ kind: 'mesh' }, delta)).toBeNull();
  });

  it('moves a chamfer without losing the removable feature', async () => {
    const before = (await regenerateSolidFeature(edgeFeature()))!;
    const moved = translatedFeature(edgeFeature(), delta)!;
    const after = (await regenerateSolidFeature(moved))!;
    expect(moved.kind).toBe('edge-modification');
    const box = bounds(before.positions);
    closeTo(bounds(after.positions), {
      x: { min: box.x.min + delta.x, max: box.x.max + delta.x },
      y: { min: box.y.min + delta.y, max: box.y.max + delta.y },
      z: { min: box.z.min + delta.z, max: box.z.max + delta.z },
    });
  });

  it('moves a PressPull without losing the removable feature', async () => {
    const before = (await regenerateSolidFeature(pressPullFeature()))!;
    const moved = translatedFeature(pressPullFeature(), delta)!;
    const after = (await regenerateSolidFeature(moved))!;
    expect(moved.kind).toBe('presspull-region');
    const box = bounds(before.positions);
    closeTo(bounds(after.positions), {
      x: { min: box.x.min + delta.x, max: box.x.max + delta.x },
      y: { min: box.y.min + delta.y, max: box.y.max + delta.y },
      z: { min: box.z.min + delta.z, max: box.z.max + delta.z },
    });
  });
});

describe('rotatedFeature', () => {
  const up = { x: 0, y: 0, z: 1 };

  it('swings a solid about the axis and keeps it a primitive', async () => {
    // A ball 6 along X, turned a quarter turn about Z through the origin,
    // lands 6 along Y.
    const feature = sphere({ radius: 1, height: 2, workPlane: plane({ x: 6, y: 0, z: 0 }) });
    const turned = rotatedFeature(feature, { x: 0, y: 0, z: 0 }, up, Math.PI / 2) as PrimitiveFeature;

    expect(turned.kind).toBe('primitive');
    expect(turned.radius).toBe(1);
    expect(turned.workPlane!.origin.x).toBeCloseTo(0, 6);
    expect(turned.workPlane!.origin.y).toBeCloseTo(6, 6);

    const mesh = (await regenerateSolidFeature(turned))!;
    closeTo(bounds(mesh.positions), { x: { min: -1, max: 1 }, y: { min: 5, max: 7 }, z: { min: -1, max: 1 } });
  });

  it('turns the plane axes, not only its origin', () => {
    const feature = sphere({ workPlane: plane({ x: 0, y: 0, z: 0 }) });
    const turned = rotatedFeature(feature, { x: 0, y: 0, z: 0 }, up, Math.PI / 2) as PrimitiveFeature;
    // Moving only the origin would leave a stretched or extruded shape pointing
    // the way it used to, which is a rotation that does not rotate anything.
    expect(turned.workPlane!.xAxis.x).toBeCloseTo(0, 6);
    expect(turned.workPlane!.xAxis.y).toBeCloseTo(1, 6);
    expect(turned.workPlane!.yAxis.x).toBeCloseTo(-1, 6);
  });

  it('turns an ellipsoid so its long axis follows', async () => {
    const feature = sphere({ radius: 1, scale: { x: 8, y: 1, z: 1 }, workPlane: plane({ x: 0, y: 0, z: 0 }) });
    const turned = rotatedFeature(feature, { x: 0, y: 0, z: 0 }, up, Math.PI / 2)!;
    const mesh = (await regenerateSolidFeature(turned))!;
    // Long in X becomes long in Y. Baking the mesh got this right too — but at
    // the cost of the radii that said so.
    closeTo(bounds(mesh.positions), { x: { min: -1, max: 1 }, y: { min: -8, max: 8 }, z: { min: -1, max: 1 } });
  });

  it('turns about any axis, not only Z', () => {
    const feature = sphere({ workPlane: plane({ x: 0, y: 0, z: 5 }) });
    const turned = rotatedFeature(feature, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, Math.PI / 2) as PrimitiveFeature;
    // 5 up, turned about X, lands 5 out along -Y.
    expect(turned.workPlane!.origin.y).toBeCloseTo(-5, 6);
    expect(turned.workPlane!.origin.z).toBeCloseTo(0, 6);
  });

  it('has nothing to say about a mesh, or about no axis at all', () => {
    expect(rotatedFeature({ kind: 'mesh' }, { x: 0, y: 0, z: 0 }, up, 1)).toBeNull();
    expect(rotatedFeature(sphere(), { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 1)).toBeNull();
  });

  it('rotates a PressPull region and keeps it regenerable', async () => {
    const turned = rotatedFeature(
      pressPullFeature(),
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      Math.PI / 2,
    )!;
    expect(turned.kind).toBe('presspull-region');
    closeTo(bounds((await regenerateSolidFeature(turned))!.positions), {
      x: { min: -5, max: 5 }, y: { min: -6, max: 0 }, z: { min: -3, max: 3 },
    });
  });
});

describe('mirroredFeature', () => {
  it('reflects a primitive and keeps it regenerable', async () => {
    const feature = sphere({ radius: 1, workPlane: plane({ x: 6, y: 0, z: 0 }) });
    const mirrored = mirroredFeature(
      feature,
      plane({ x: 0, y: 0, z: 0 }),
      { x: 0, y: -1 },
      { x: 0, y: 1 },
    ) as PrimitiveFeature;

    expect(mirrored.kind).toBe('primitive');
    expect(mirrored.workPlane?.origin.x).toBeCloseTo(-6, 6);
    const mesh = (await regenerateSolidFeature(mirrored))!;
    closeTo(bounds(mesh.positions), { x: { min: -7, max: -5 }, y: { min: -1, max: 1 }, z: { min: -1, max: 1 } });
  });

  it('bakes only a featureless mesh', () => {
    expect(mirroredFeature(
      { kind: 'mesh' },
      plane({ x: 0, y: 0, z: 0 }),
      { x: 0, y: 0 },
      { x: 0, y: 1 },
    )).toBeNull();
  });

  it('mirrors a PressPull and keeps the feature tree regenerable', async () => {
    const mirrored = mirroredFeature(
      pressPullFeature(),
      plane({ x: 0, y: 0, z: 0 }),
      { x: 0, y: -1 },
      { x: 0, y: 1 },
    )!;
    expect(mirrored.kind).toBe('presspull-region');
    expect((await regenerateSolidFeature(mirrored))?.indices.length).toBeGreaterThan(0);
  });
});
