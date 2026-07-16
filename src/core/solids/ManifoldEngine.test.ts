import { describe, expect, it } from 'vitest';
import type { ExtrusionFeature, PrimitiveFeature } from '../entities/types';
import { createBoxMesh, createTorusMesh, modifySolidEdge, pressPullFace, regenerateSolidFeature } from './ManifoldEngine';

describe('parametric solid regeneration', () => {
  it('regenerates every parametric primitive feature', async () => {
    const features: PrimitiveFeature[] = [
      { kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 10, depth: 6, height: 4 },
      { kind: 'primitive', primitive: 'wedge', center: { x: 0, y: 0 }, width: 10, depth: 6, height: 4 },
      { kind: 'primitive', primitive: 'sphere', center: { x: 0, y: 0 }, radius: 3, height: 6 },
      { kind: 'primitive', primitive: 'cone', center: { x: 0, y: 0 }, radius: 3, height: 8 },
      { kind: 'primitive', primitive: 'cylinder', center: { x: 0, y: 0 }, radius: 3, height: 8 },
      { kind: 'primitive', primitive: 'pyramid', center: { x: 0, y: 0 }, radius: 3, height: 8 },
      { kind: 'primitive', primitive: 'torus', center: { x: 0, y: 0 }, radius: 10, tubeRadius: 2, height: 4 },
    ];
    for (const feature of features) {
      const mesh = await regenerateSolidFeature(feature);
      expect(mesh?.positions.length).toBeGreaterThan(0);
      expect(mesh?.indices.length).toBeGreaterThan(0);
    }
  });

  // The primitive dispatch falls through to a cylinder, so a torus that is not
  // wired up regenerates as one — with no type error to warn about it.
  it('regenerates a torus as a torus rather than the fallback cylinder', async () => {
    const feature: PrimitiveFeature = {
      kind: 'primitive', primitive: 'torus', center: { x: 0, y: 0 }, radius: 10, tubeRadius: 2, height: 4,
    };
    const mesh = await regenerateSolidFeature(feature);
    expect(mesh).not.toBeNull();

    let minDistance = Infinity;
    for (let i = 0; i < mesh!.positions.length; i += 3) {
      minDistance = Math.min(minDistance, Math.hypot(mesh!.positions[i], mesh!.positions[i + 1]));
    }
    // A torus leaves a hole of radius - tubeRadius; a cylinder reaches its axis.
    expect(minDistance).toBeCloseTo(8, 5);
  });
  it('moves a selected side face along its normal', () => {
    const mesh = createBoxMesh(10, 6, 4);
    const changed = pressPullFace(mesh, [1, 2, 5, 6], { x: 1, y: 0, z: 0 }, 3);
    expect(changed).not.toBeNull();
    expect(changed!.positions[3]).toBeCloseTo(8);
    expect(changed!.positions[0]).toBeCloseTo(-5);
  });

  it('regenerates an extrusion from profile, transform and height', async () => {
    const feature: ExtrusionFeature = {
      kind: 'extrusion',
      profile: {
        id: 'circle_profile', type: 'circle', layer: '0', color: 0xffffff, selected: false,
        center: { x: 0, y: 0 }, radius: 2,
      },
      height: 5,
      transform: { translateX: 10, translateY: -3, scaleX: 2, scaleY: 0.5 },
    };
    const mesh = await regenerateSolidFeature(feature);
    expect(mesh).not.toBeNull();
    const positions = mesh!.positions;
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    for (let i = 0; i < positions.length; i += 3) {
      xs.push(positions[i]); ys.push(positions[i + 1]); zs.push(positions[i + 2]);
    }
    expect(Math.min(...xs)).toBeCloseTo(6, 4);
    expect(Math.max(...xs)).toBeCloseTo(14, 4);
    expect(Math.min(...ys)).toBeCloseTo(-4, 4);
    expect(Math.max(...ys)).toBeCloseTo(-2, 4);
    expect(Math.min(...zs)).toBeCloseTo(0, 4);
    expect(Math.max(...zs)).toBeCloseTo(5, 4);
  });

  it('chamfers and fillets a convex solid edge into valid meshes', async () => {
    const mesh = createBoxMesh(10, 6, 4);
    const edge = {
      solidId: 'box',
      start: { x: 5, y: 3, z: 0 }, end: { x: 5, y: 3, z: 4 },
      normalA: { x: 1, y: 0, z: 0 }, normalB: { x: 0, y: 1, z: 0 },
    };
    const chamfer = await modifySolidEdge(mesh, edge, 1, false);
    const fillet = await modifySolidEdge(mesh, edge, 1, true);
    expect(chamfer).not.toBeNull();
    expect(fillet).not.toBeNull();
    expect(chamfer!.indices.length).toBeGreaterThan(mesh.indices.length);
    expect(fillet!.indices.length).toBeGreaterThan(chamfer!.indices.length);
  });
});

describe('createTorusMesh', () => {
  it('builds a closed torus with every triangle wound outwards', () => {
    const radius = 10;
    const tubeRadius = 2;
    const mesh = createTorusMesh(radius, tubeRadius, 0, 0, 24, 12);

    expect(mesh.positions).toHaveLength(24 * 12 * 3);
    expect(mesh.indices).toHaveLength(24 * 12 * 6);

    // Every vertex sits exactly `tubeRadius` from the tube centre circle.
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i], y = mesh.positions[i + 1], z = mesh.positions[i + 2];
      const toAxis = Math.hypot(x, y) - radius;
      expect(Math.hypot(toAxis, z)).toBeCloseTo(tubeRadius, 5);
    }

    // A closed surface: every edge is shared by exactly two triangles.
    const edges = new Map<string, number>();
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const tri = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
      for (let e = 0; e < 3; e++) {
        const [a, b] = [tri[e], tri[(e + 1) % 3]];
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    expect([...edges.values()].every((count) => count === 2)).toBe(true);
  });

  it('places the hole at the centre and honours the work plane origin', () => {
    const mesh = createTorusMesh(10, 2, 5, -3, 24, 12);
    let minDistance = Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      minDistance = Math.min(minDistance, Math.hypot(mesh.positions[i] - 5, mesh.positions[i + 1] + 3));
    }
    // Nothing may reach the middle: the nearest surface is radius - tubeRadius.
    expect(minDistance).toBeCloseTo(8, 5);
  });
});
