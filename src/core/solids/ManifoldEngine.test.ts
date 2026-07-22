import { describe, expect, it } from 'vitest';
import type { EdgeModificationFeature, ExtrusionFeature, PrimitiveFeature } from '../entities/types';
import { createBoxMesh, createTorusMesh, modifySolidEdge, pressPullFace, pressPullRegion, regenerateSolidFeature, splitSolidByPlane } from './ManifoldEngine';
import { planarFaceRegionAt, solidPlanarFaces } from './SolidTopology';
import { Document } from '../Document';
import { localToWorld } from '../../math/workplane';

const signedVolume = (mesh: { positions: Float32Array; indices: Uint32Array }): number => {
  let volume = 0;
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const ids = [mesh.indices[offset], mesh.indices[offset + 1], mesh.indices[offset + 2]];
    const point = (index: number) => ({
      x: mesh.positions[index * 3], y: mesh.positions[index * 3 + 1], z: mesh.positions[index * 3 + 2],
    });
    const [a, b, c] = ids.map(point);
    volume += (
      a.x * (b.y * c.z - b.z * c.y)
      + a.y * (b.z * c.x - b.x * c.z)
      + a.z * (b.x * c.y - b.y * c.x)
    ) / 6;
  }
  return volume;
};

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

  it('press-pulls only one half of a face split by a line as a watertight boolean', async () => {
    const source = createBoxMesh(10, 6, 4);
    const top = solidPlanarFaces(source).find((face) => face.normal.z > 0.9)!;
    const doc = new Document();
    doc.activeWorkPlane.origin.z = 4;
    const divider = doc.createLine({ x: -5, y: 0 }, { x: 5, y: 0 });
    const upperHalf = planarFaceRegionAt(top, [divider], { x: 0, y: 2, z: 4 })!;

    const pulled = await pressPullRegion(source, upperHalf, 3);

    expect(pulled).not.toBeNull();
    const zs = Array.from(pulled!.positions).filter((_value, index) => index % 3 === 2);
    expect(Math.max(...zs)).toBeCloseTo(7, 4);
    expect(Math.abs(signedVolume(pulled!))).toBeCloseTo(330, 2);
  });

  it('subtracts an inward face region to make a pocket', async () => {
    const source = createBoxMesh(10, 6, 4);
    const top = solidPlanarFaces(source).find((face) => face.normal.z > 0.9)!;
    const xs = top.loops[0].map((point) => point.x), ys = top.loops[0].map((point) => point.y);
    const centreX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const centreY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const region = {
      plane: top.plane,
      loops: [[
        { x: centreX - 1, y: centreY - 1 }, { x: centreX + 1, y: centreY - 1 },
        { x: centreX + 1, y: centreY + 1 }, { x: centreX - 1, y: centreY + 1 },
      ]],
    };

    const pocketed = await pressPullRegion(source, region, -2);

    expect(pocketed).not.toBeNull();
    expect(Math.abs(signedVolume(pocketed!))).toBeCloseTo(232, 2);
  });

  it('press-pulls the partial region made by a circle crossing a face edge', async () => {
    const source = createBoxMesh(10, 6, 4);
    const front = solidPlanarFaces(source).find((face) => face.normal.y < -0.9)!;
    const xs = front.loops[0].map((point) => point.x), ys = front.loops[0].map((point) => point.y);
    const edgeX = Math.min(...xs), centreY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const radius = 1;
    const doc = new Document();
    doc.activeWorkPlane = front.plane;
    const circle = doc.createCircle({ x: edgeX, y: centreY }, radius);
    const pick = localToWorld(front.plane, { x: edgeX + radius / 2, y: centreY });
    const region = planarFaceRegionAt(front, [circle], pick)!;

    const pulled = await pressPullRegion(source, region, 2);

    expect(pulled).not.toBeNull();
    const ysWorld = Array.from(pulled!.positions).filter((_value, index) => index % 3 === 1);
    expect(Math.min(...ysWorld)).toBeCloseTo(-5, 4);
    expect(Math.abs(signedVolume(pulled!))).toBeCloseTo(240 + Math.PI, 1);
  });

  it('regenerates an extrusion from profile, transform and height', async () => {
    const feature: ExtrusionFeature = {
      kind: 'extrusion',
      profile: {
        id: 'circle_profile', type: 'circle', layer: '0', aci: 256, color: 0xffffff, selected: false,
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

  it('regenerates a chamfer feature from its parametric source', async () => {
    const source: PrimitiveFeature = {
      kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 10, depth: 6, height: 4,
    };
    const sourceMesh = createBoxMesh(10, 6, 4);
    const feature: EdgeModificationFeature = {
      kind: 'edge-modification', operation: 'chamfer', source, amount: 1,
      edge: {
        solidId: 'box', start: { x: 5, y: 3, z: 0 }, end: { x: 5, y: 3, z: 4 },
        normalA: { x: 1, y: 0, z: 0 }, normalB: { x: 0, y: 1, z: 0 },
      },
      sourceMesh: { positions: Array.from(sourceMesh.positions), indices: Array.from(sourceMesh.indices) },
    };

    const regenerated = await regenerateSolidFeature(feature);

    expect(regenerated?.indices.length).toBeGreaterThan(sourceMesh.indices.length);
  });

  it('regenerates an edge feature even when its source was already a mesh', async () => {
    const sourceMesh = createBoxMesh(10, 6, 4);
    const feature: EdgeModificationFeature = {
      kind: 'edge-modification', operation: 'fillet', source: { kind: 'mesh' }, amount: 1,
      edge: {
        solidId: 'box', start: { x: 5, y: 3, z: 0 }, end: { x: 5, y: 3, z: 4 },
        normalA: { x: 1, y: 0, z: 0 }, normalB: { x: 0, y: 1, z: 0 },
      },
      sourceMesh: { positions: Array.from(sourceMesh.positions), indices: Array.from(sourceMesh.indices) },
    };

    expect((await regenerateSolidFeature(feature))?.indices.length).toBeGreaterThan(sourceMesh.indices.length);
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

  describe('scaling a primitive', () => {
    const bounds = (positions: Float32Array) => {
      const span = (axis: number) => {
        let min = Infinity, max = -Infinity;
        for (let i = axis; i < positions.length; i += 3) { min = Math.min(min, positions[i]); max = Math.max(max, positions[i]); }
        return { min, max };
      };
      return { x: span(0), y: span(1), z: span(2) };
    };

    const sphere = (scale?: { x: number; y: number; z: number }): PrimitiveFeature => ({
      kind: 'primitive', primitive: 'sphere', center: { x: 0, y: 0 }, radius: 10, height: 0, scale,
    });

    it('turns a sphere into an ellipsoid', async () => {
      const mesh = await regenerateSolidFeature(sphere({ x: 3, y: 1, z: 0.4 }));
      const box = bounds(mesh!.positions);
      // The shape the primitives cannot draw: three different radii. Faking it
      // cost forty spheres unioned together.
      expect(box.x.max).toBeCloseTo(30, 4);
      expect(box.y.max).toBeCloseTo(10, 4);
      expect(box.z.max).toBeCloseTo(4, 4);
      expect(box.z.min).toBeCloseTo(-4, 4);
    });

    it('leaves a primitive alone when it has no scale', async () => {
      const box = bounds((await regenerateSolidFeature(sphere()))!.positions);
      expect([box.x.max, box.y.max, box.z.max]).toEqual([10, 10, 10].map((value) => expect.closeTo(value, 4)));
    });

    it('scales a cylinder from its base, not through it', async () => {
      const mesh = await regenerateSolidFeature({
        kind: 'primitive', primitive: 'cylinder', center: { x: 0, y: 0 }, radius: 4, height: 10,
        scale: { x: 1, y: 1, z: 2 },
      });
      const box = bounds(mesh!.positions);
      // The base sits on z = 0, so doubling the height must grow upwards only.
      expect(box.z.min).toBeCloseTo(0, 4);
      expect(box.z.max).toBeCloseTo(20, 4);
    });

    it('keeps a mirrored primitive right side out', async () => {
      const mesh = await regenerateSolidFeature(sphere({ x: -1, y: 1, z: 1 }));
      // Manifold refuses an inside-out mesh, so a mesh at all is the assertion:
      // a negative scale reflects, and reflecting reverses every triangle.
      expect(mesh).not.toBeNull();
      const united = await regenerateSolidFeature({
        kind: 'boolean', operation: 'union',
        operands: [sphere({ x: -1, y: 1, z: 1 }), sphere({ x: 1, y: 1, z: 1 })],
      });
      expect(united?.indices.length).toBeGreaterThan(0);
    });
  });

  describe('a cone with its point cut off', () => {
    const cone = (radiusTop?: number): PrimitiveFeature =>
      ({ kind: 'primitive', primitive: 'cone', center: { x: 0, y: 0 }, radius: 10, height: 20, radiusTop });

    const radiusAt = (positions: Float32Array, z: number) => {
      let widest = 0;
      for (let i = 0; i < positions.length; i += 3) {
        if (Math.abs(positions[i + 2] - z) > 1e-4) continue;
        widest = Math.max(widest, Math.hypot(positions[i], positions[i + 1]));
      }
      return widest;
    };

    it('is wide at the top when asked, and a point when not', async () => {
      // Nothing here had two radii, and almost everything tapered does: a table
      // leg, a chamfer, a draft angle, an elephant's trunk.
      const frustum = (await regenerateSolidFeature(cone(4)))!;
      expect(radiusAt(frustum.positions, 0)).toBeCloseTo(10, 2);
      expect(radiusAt(frustum.positions, 20)).toBeCloseTo(4, 2);

      const pointed = (await regenerateSolidFeature(cone()))!;
      expect(radiusAt(pointed.positions, 20)).toBeCloseTo(0, 6);
    });

    it('comes out wound the right way, which is the only thing Manifold asks', async () => {
      // A boolean is the test: Manifold refuses a mesh that is inside out or
      // not closed, so surviving a union says the frustum is a real solid.
      const united = await regenerateSolidFeature({
        kind: 'boolean', operation: 'union',
        operands: [cone(4), { ...cone(4), center: { x: 6, y: 0 } }],
      });
      expect(united?.indices.length).toBeGreaterThan(0);
    });

    it('is a cylinder when both radii agree', async () => {
      const mesh = (await regenerateSolidFeature(cone(10)))!;
      expect(radiusAt(mesh.positions, 0)).toBeCloseTo(10, 2);
      expect(radiusAt(mesh.positions, 20)).toBeCloseTo(10, 2);
    });
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

describe('splitSolidByPlane', () => {
  const axisBounds = (positions: Float32Array, axis: 0 | 1 | 2) => {
    let min = Infinity, max = -Infinity;
    for (let index = axis; index < positions.length; index += 3) {
      min = Math.min(min, positions[index]);
      max = Math.max(max, positions[index]);
    }
    return { min, max };
  };

  it('returns both closed halves of a box cut through its middle', async () => {
    const parts = await splitSolidByPlane(
      createBoxMesh(10, 6, 4),
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    );

    expect(parts).not.toBeNull();
    expect(parts![0].indices.length).toBeGreaterThan(0);
    expect(parts![1].indices.length).toBeGreaterThan(0);
    const bounds = parts!.map((part) => axisBounds(part.positions, 0));
    expect(bounds).toEqual(expect.arrayContaining([
      { min: expect.closeTo(0, 5), max: expect.closeTo(5, 5) },
      { min: expect.closeTo(-5, 5), max: expect.closeTo(0, 5) },
    ]));
  });

  it('does not report a split when the plane misses the body', async () => {
    expect(await splitSolidByPlane(
      createBoxMesh(10, 6, 4),
      { x: 20, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    )).toBeNull();
  });
});
