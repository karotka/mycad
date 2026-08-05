import { describe, expect, it } from 'vitest';
import { candidateRemovals, applyRemoval, featureRemovalForPoint } from './featureRemoval';
import { regenerateExactFeatureMesh as regenerateSolidFeature } from '../geometry/FeatureMesh';
import type { Solid, SolidFeature, SolidMesh } from '../entities/types';

const box = (cx: number, cy: number, w: number, d: number, h: number): SolidFeature =>
  ({ kind: 'primitive', primitive: 'box', center: { x: cx, y: cy }, width: w, depth: d, height: h } as SolidFeature);
const cylinder = (cx: number, cy: number, r: number, h: number): SolidFeature =>
  ({ kind: 'primitive', primitive: 'cylinder', center: { x: cx, y: cy }, radius: r, height: h } as SolidFeature);

const asSolid = async (feature: SolidFeature): Promise<Solid> => {
  const mesh = (await regenerateSolidFeature(feature))!;
  return { id: 's', name: 's', feature, mesh, height: 0, revision: 0, layer: '0', selected: false } as unknown as Solid;
};
const volume = (m: SolidMesh) => { let v=0; const p=m.positions,ix=m.indices; for(let o=0;o+2<ix.length;o+=3){const a=ix[o]*3,b=ix[o+1]*3,c=ix[o+2]*3; v+=(p[a]*(p[b+1]*p[c+2]-p[b+2]*p[c+1])+p[a+1]*(p[b+2]*p[c]-p[b]*p[c+2])+p[a+2]*(p[b]*p[c+1]-p[b+1]*p[c]))/6;} return Math.abs(v); };

describe('candidateRemovals / applyRemoval', () => {
  it('lists each boolean operand and each edge-mod wrapper, and drops them', () => {
    const feature: SolidFeature = {
      kind: 'edge-modification', operation: 'fillet', amount: 1,
      edge: { solidId: 's', start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 } },
      sourceMesh: { positions: [], indices: [] },
      source: { kind: 'boolean', operation: 'union', operands: [box(0, 0, 10, 10, 10), box(20, 0, 10, 10, 10)] },
    } as unknown as SolidFeature;
    const cands = candidateRemovals(feature);
    expect(cands).toContainEqual({ path: [], mode: 'unwrap' });      // the fillet
    expect(cands).toContainEqual({ path: [0, 0], mode: 'splice' });  // union operand 0
    expect(cands).toContainEqual({ path: [0, 1], mode: 'splice' });  // union operand 1
    // Removing a union operand collapses the two-operand union to the survivor.
    const withoutSecond = applyRemoval(feature, { path: [0, 1], mode: 'splice' })!;
    expect(withoutSecond.kind).toBe('edge-modification');
    if (withoutSecond.kind === 'edge-modification') expect(withoutSecond.source.kind).toBe('primitive');
  });
});

describe('featureRemovalForPoint', () => {
  it('a click on a hole wall removes the subtracted cutter, filling the hole', async () => {
    const feature: SolidFeature = { kind: 'boolean', operation: 'subtract', operands: [box(0, 0, 20, 20, 20), cylinder(0, 0, 3, 30)] } as SolidFeature;
    const solid = await asSolid(feature);
    const holeVolume = volume(solid.mesh);
    const result = await featureRemovalForPoint(
      solid,
      { x: 3, y: 0, z: 10 }, // on the cylinder wall
      { x: -1, y: 0, z: 0 }, // outward from the resulting solid, into the bore
    );
    expect(result).not.toBeNull();
    expect(result!.candidate).toEqual({ path: [1], mode: 'splice' });
    // Hole gone → solid gained back the bore's volume.
    expect(volume(result!.mesh)).toBeGreaterThan(holeVolume + 100);
  });

  it('does not cross the hole rim when the click is on the adjacent top face', async () => {
    const feature: SolidFeature = { kind: 'boolean', operation: 'subtract', operands: [box(0, 0, 20, 20, 20), cylinder(0, 0, 3, 30)] } as SolidFeature;
    const solid = await asSolid(feature);

    // The point lies on the box top, just outside the bore. It is deliberately
    // within the numeric weld tolerance of the wall: the face normal, not an
    // arbitrary distance halo, must keep the two sides of the rim separate.
    const result = await featureRemovalForPoint(solid, { x: 3.005, y: 0, z: 20 }, { x: 0, y: 0, z: 1 });

    expect(result).toBeNull();
  });

  it('removes the innermost matching feature instead of its whole boolean ancestor', async () => {
    const holedBase: SolidFeature = {
      kind: 'boolean', operation: 'subtract',
      operands: [box(0, 0, 20, 20, 20), cylinder(0, 0, 3, 30)],
    } as SolidFeature;
    const feature: SolidFeature = {
      kind: 'boolean', operation: 'union',
      operands: [holedBase, box(8, 0, 4, 4, 25)],
    } as SolidFeature;
    const solid = await asSolid(feature);

    const result = await featureRemovalForPoint(
      solid,
      { x: 3, y: 0, z: 10 },
      { x: -1, y: 0, z: 0 },
    );

    expect(result?.candidate).toEqual({ path: [0, 1], mode: 'splice' });
    expect(result?.feature.kind).toBe('boolean');
  });

  it('a click on a bump removes the unioned operand, not the whole body', async () => {
    const feature: SolidFeature = { kind: 'boolean', operation: 'union', operands: [box(0, 0, 20, 20, 10), box(15, 0, 20, 10, 10)] } as SolidFeature;
    const solid = await asSolid(feature);
    const result = await featureRemovalForPoint(solid, { x: 25, y: 0, z: 5 }); // on the +X face of the bump
    expect(result).not.toBeNull();
    expect(result!.candidate).toEqual({ path: [1], mode: 'splice' });
    // The base survives (bump removed, not the body).
    expect(volume(result!.mesh)).toBeGreaterThan(3500); // base 20*20*10 = 4000
  });

  it('does not cross a bump edge when the click belongs to the base face', async () => {
    const feature: SolidFeature = {
      kind: 'boolean', operation: 'union',
      operands: [box(0, 0, 20, 20, 10), box(7, 0, 6, 6, 15)],
    } as SolidFeature;
    const solid = await asSolid(feature);

    // This is still the horizontal base face, within weld tolerance of the
    // bump's vertical wall. Distance alone must not claim the bump was clicked.
    const result = await featureRemovalForPoint(solid, { x: 3.995, y: 0, z: 10 }, { x: 0, y: 0, z: 1 });

    expect(result).toBeNull();
  });

  it('returns null for a bare primitive (no feature to remove)', async () => {
    const solid = await asSolid(box(0, 0, 10, 10, 10));
    expect(await featureRemovalForPoint(solid, { x: 5, y: 0, z: 5 })).toBeNull();
  });
});
