import { describe, expect, it } from 'vitest';
import { booleanUnion } from './ManifoldEngine';
import { solidPlanarFaces } from './SolidTopology';
import { polygonSignedArea } from '../../math/geometry';
import type { SolidMesh } from '../entities/types';
import fixture from './__fixtures__/flush-union.json';

/**
 * A triangular profile extruded flush against a body — touching it on both its
 * base face and a side face at once. A plain union leaves a zero-thickness
 * membrane where the coincident faces meet; nudging the operand toward the body
 * centroid can only close one such face at a time, so the membrane survives.
 * `fuseTouching` inflates the operand about its own centroid instead, pushing
 * every face outward, and must leave no membrane behind. (Regression for the
 * "leftover flat face after extrude + union" report.)
 */
const load = (m: { positions: number[]; indices: number[] }): SolidMesh => ({
  positions: new Float32Array(m.positions),
  indices: new Uint32Array(m.indices),
});

const internalMembranes = (mesh: SolidMesh): number => {
  const faces = solidPlanarFaces(mesh).map((f) => ({
    n: f.normal,
    off: f.normal.x * f.plane.origin.x + f.normal.y * f.plane.origin.y + f.normal.z * f.plane.origin.z,
    area: Math.abs(polygonSignedArea(f.loops[0])),
  }));
  let count = 0;
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const a = faces[i], b = faces[j];
      const opposite = a.n.x * b.n.x + a.n.y * b.n.y + a.n.z * b.n.z < -0.99;
      if (opposite && Math.abs(a.off + b.off) < 0.05 && Math.abs(a.area - b.area) < 1 && a.area > 3) count++;
    }
  }
  return count;
};

describe('booleanUnion fuseTouching', () => {
  const body = load(fixture.body);
  const prism = load(fixture.prism);

  it('leaves a membrane for a flush profile without fusing', async () => {
    const plain = (await booleanUnion([body, prism]))!;
    expect(internalMembranes(plain)).toBeGreaterThan(0);
  });

  it('dissolves every coincident face when fusing', async () => {
    const fused = (await booleanUnion([body, prism], true))!;
    expect(internalMembranes(fused)).toBe(0);
  });

  it('welds the Float32 sliver at the flush top edge into one clean ridge', async () => {
    // The rib apex and the body top are the same height to within Float32's
    // resolution, so a raw fuse leaves two edges a few microns apart at the
    // ridge — which a later fillet would only half-round. The post-union weld
    // must collapse them onto a single z level.
    const fused = (await booleanUnion([body, prism], true))!;
    const zs: number[] = [];
    const p = fused.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      if (y > 7.9 && y < 8.1 && z > 21.4 && x > 134 && x < 140) zs.push(z);
    }
    expect(zs.length).toBeGreaterThan(0);
    expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(1e-3); // was ~4.6e-3 before welding
  });
});
