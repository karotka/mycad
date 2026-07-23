import { describe, expect, it } from 'vitest';
import type { EdgeModificationFeature, ExtrusionFeature, PrimitiveFeature } from '../entities/types';
import { createBoxMesh, createCylinderMesh, createTorusMesh, deletePlanarSolidFace, modifySolidEdge, pressPullFace, pressPullRegion, regenerateSolidFeature, splitSolidByPlane } from './ManifoldEngine';
import { planarFaceRegionAt, solidCircularEdges, solidPlanarFaces } from './SolidTopology';
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

const maxConvexViolation = (mesh: { positions: Float32Array; indices: Uint32Array }): number => {
  let violation = 0;
  for (const face of solidPlanarFaces(mesh)) {
    const offset = face.normal.x * face.plane.origin.x
      + face.normal.y * face.plane.origin.y
      + face.normal.z * face.plane.origin.z;
    for (let index = 0; index < mesh.positions.length; index += 3) {
      violation = Math.max(
        violation,
        face.normal.x * mesh.positions[index]
          + face.normal.y * mesh.positions[index + 1]
          + face.normal.z * mesh.positions[index + 2]
          - offset,
      );
    }
  }
  return violation;
};

type PickedSolidEdge = Parameters<typeof modifySolidEdge>[1];

const pickedSolidEdges = (
  mesh: { positions: Float32Array; indices: Uint32Array },
): PickedSolidEdge[] => {
  type EdgeData = {
    a: number;
    b: number;
    normals: Array<{ x: number; y: number; z: number }>;
  };
  const edges = new Map<string, EdgeData>();
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const ids = [
      mesh.indices[offset],
      mesh.indices[offset + 1],
      mesh.indices[offset + 2],
    ];
    const point = (index: number) => ({
      x: mesh.positions[index * 3],
      y: mesh.positions[index * 3 + 1],
      z: mesh.positions[index * 3 + 2],
    });
    const first = point(ids[0]), second = point(ids[1]), third = point(ids[2]);
    const ux = second.x - first.x, uy = second.y - first.y, uz = second.z - first.z;
    const vx = third.x - first.x, vy = third.y - first.y, vz = third.z - first.z;
    const length = Math.hypot(
      uy * vz - uz * vy,
      uz * vx - ux * vz,
      ux * vy - uy * vx,
    ) || 1;
    const normal = {
      x: (uy * vz - uz * vy) / length,
      y: (uz * vx - ux * vz) / length,
      z: (ux * vy - uy * vx) / length,
    };
    for (let edgeIndex = 0; edgeIndex < 3; edgeIndex++) {
      const from = ids[edgeIndex], to = ids[(edgeIndex + 1) % 3];
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      const edge = edges.get(key) ?? {
        a: Math.min(from, to),
        b: Math.max(from, to),
        normals: [],
      };
      edge.normals.push(normal);
      edges.set(key, edge);
    }
  }
  const point = (index: number) => ({
    x: mesh.positions[index * 3],
    y: mesh.positions[index * 3 + 1],
    z: mesh.positions[index * 3 + 2],
  });
  return Array.from(edges.values())
    .filter((edge) => edge.normals.length === 2)
    .filter((edge) => (
      edge.normals[0].x * edge.normals[1].x
      + edge.normals[0].y * edge.normals[1].y
      + edge.normals[0].z * edge.normals[1].z
    ) <= 0.995)
    .map((edge) => ({
      solidId: 'box',
      start: point(edge.a),
      end: point(edge.b),
      normalA: edge.normals[0],
      normalB: edge.normals[1],
    }));
};

const completeCollinearEdge = (
  picked: PickedSolidEdge,
  edges: PickedSolidEdge[],
): PickedSolidEdge | null => {
  const direction = {
    x: picked.end.x - picked.start.x,
    y: picked.end.y - picked.start.y,
    z: picked.end.z - picked.start.z,
  };
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (length < 1e-8) return null;
  direction.x /= length; direction.y /= length; direction.z /= length;
  const tolerance = 1e-3;
  const pointDistance = (first: { x: number; y: number; z: number }, second: { x: number; y: number; z: number }) =>
    Math.hypot(first.x - second.x, first.y - second.y, first.z - second.z);
  const distanceFromLine = (point: { x: number; y: number; z: number }) => {
    const dx = point.x - picked.start.x, dy = point.y - picked.start.y, dz = point.z - picked.start.z;
    return Math.hypot(
      dy * direction.z - dz * direction.y,
      dz * direction.x - dx * direction.z,
      dx * direction.y - dy * direction.x,
    );
  };
  const candidates = edges.filter((edge) => {
    const dx = edge.end.x - edge.start.x, dy = edge.end.y - edge.start.y, dz = edge.end.z - edge.start.z;
    const candidateLength = Math.hypot(dx, dy, dz);
    if (candidateLength < 1e-8) return false;
    const parallel = Math.abs((dx * direction.x + dy * direction.y + dz * direction.z) / candidateLength);
    return parallel > 0.99999
      && distanceFromLine(edge.start) <= tolerance
      && distanceFromLine(edge.end) <= tolerance;
  });
  const connected = [picked];
  const remaining = candidates.filter((edge) => edge !== picked);
  let added = true;
  while (added) {
    added = false;
    for (let index = remaining.length - 1; index >= 0; index--) {
      const sharesEndpoint = [remaining[index].start, remaining[index].end].some((point) =>
        connected.some((edge) => [edge.start, edge.end].some((endpoint) =>
          pointDistance(point, endpoint) <= tolerance
        ))
      );
      if (!sharesEndpoint) continue;
      connected.push(remaining[index]);
      remaining.splice(index, 1);
      added = true;
    }
  }
  if (connected.length < 2) return null;
  const points = connected.flatMap((edge) => [edge.start, edge.end]);
  const projection = (point: { x: number; y: number; z: number }) =>
    (point.x - picked.start.x) * direction.x
    + (point.y - picked.start.y) * direction.y
    + (point.z - picked.start.z) * direction.z;
  return {
    ...picked,
    start: points.reduce((lowest, point) => projection(point) < projection(lowest) ? point : lowest),
    end: points.reduce((highest, point) => projection(point) > projection(highest) ? point : highest),
  };
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
    expect(Math.abs(signedVolume(chamfer!))).toBeCloseTo(238, 3);
    expect(Math.abs(signedVolume(fillet!))).toBeCloseTo(240 - (1 - Math.PI / 4) * 4, 1);
  });

  it('uses two independent distances for an asymmetric chamfer', async () => {
    const mesh = createBoxMesh(10, 6, 4);
    const edge = {
      solidId: 'box',
      start: { x: 5, y: 3, z: 0 }, end: { x: 5, y: 3, z: 4 },
      // These are deliberately the inward normals emitted by the legacy box
      // winding. The operation must orient them from the actual body.
      normalA: { x: -1, y: 0, z: 0 }, normalB: { x: 0, y: -1, z: 0 },
    };

    const chamfer = await modifySolidEdge(mesh, edge, 1, false, 2);

    expect(chamfer).not.toBeNull();
    expect(Math.abs(signedVolume(chamfer!))).toBeCloseTo(236, 3);
  });

  it.each([
    { label: 'top', height: 8 },
    { label: 'bottom', height: 0 },
  ])('chamfers and fillets the complete $label circular cylinder rim', async ({ height }) => {
    const mesh = createCylinderMesh(5, 8, 0, 0, 64);
    const circle = solidCircularEdges(mesh).find((candidate) =>
      Math.abs(candidate.center.z - height) < 1e-5
    )!;
    const edge = {
      solidId: 'cylinder',
      start: circle.points[0],
      end: circle.points[1],
      normalA: circle.normal,
      normalB: circle.normal,
      circular: {
        center: circle.center,
        normal: circle.normal,
        radius: circle.radius,
        segments: circle.points.length,
      },
    };

    for (const rounded of [false, true]) {
      const result = await modifySolidEdge(mesh, edge, 1, rounded, 1);

      expect(result, rounded ? 'fillet' : 'chamfer').not.toBeNull();
      expect(Math.abs(signedVolume(result!))).toBeLessThan(Math.abs(signedVolume(mesh)));
      const targetCapRadii: number[] = [];
      const oppositeCapRadii: number[] = [];
      for (let index = 0; index < result!.positions.length; index += 3) {
        const z = result!.positions[index + 2];
        const radius = Math.hypot(result!.positions[index], result!.positions[index + 1]);
        if (Math.abs(z - height) < 1e-4) targetCapRadii.push(radius);
        if (Math.abs(z - (height === 0 ? 8 : 0)) < 1e-4) oppositeCapRadii.push(radius);
      }
      // A one-segment operation leaves radius-5 vertices on the selected cap.
      // The analytic circular operation moves the complete rim to radius 4.
      expect(Math.max(...targetCapRadii)).toBeCloseTo(4, 3);
      expect(Math.max(...oppositeCapRadii)).toBeCloseTo(5, 3);
    }
  });

  it('chamfers all twelve box edges exactly as returned by the real picker', async () => {
    const mesh = createBoxMesh(10, 6, 4);
    const edges = pickedSolidEdges(mesh);
    expect(edges).toHaveLength(12);

    for (const edge of edges) {
      const length = Math.hypot(
        edge.end.x - edge.start.x,
        edge.end.y - edge.start.y,
        edge.end.z - edge.start.z,
      );
      const label = `${edge.start.x},${edge.start.y},${edge.start.z} -> ${edge.end.x},${edge.end.y},${edge.end.z}`;
      const chamfer = await modifySolidEdge(mesh, edge, 1, false, 2);

      expect(chamfer, label).not.toBeNull();
      expect(Math.abs(signedVolume(chamfer!)), label).toBeCloseTo(240 - length, 2);
      for (let index = 0; index < chamfer!.positions.length; index += 3) {
        expect(chamfer!.positions[index], label).toBeGreaterThanOrEqual(-5.0001);
        expect(chamfer!.positions[index], label).toBeLessThanOrEqual(5.0001);
        expect(chamfer!.positions[index + 1], label).toBeGreaterThanOrEqual(-3.0001);
        expect(chamfer!.positions[index + 1], label).toBeLessThanOrEqual(3.0001);
        expect(chamfer!.positions[index + 2], label).toBeGreaterThanOrEqual(-0.0001);
        expect(chamfer!.positions[index + 2], label).toBeLessThanOrEqual(4.0001);
      }
    }
  });

  it('orients the picked face normals locally when another body is farther along the same axis', async () => {
    const first = createBoxMesh(10, 6, 4);
    const second = createBoxMesh(10, 6, 4, 20, 0);
    const vertexOffset = first.positions.length / 3;
    const mesh = {
      positions: new Float32Array([...first.positions, ...second.positions]),
      indices: new Uint32Array([...first.indices, ...Array.from(second.indices, (index) => index + vertexOffset)]),
    };
    const edgeFromRealPicker = {
      solidId: 'two-parts',
      start: { x: 5, y: 3, z: 0 }, end: { x: 5, y: 3, z: 4 },
      normalA: { x: -1, y: 0, z: 0 }, normalB: { x: 0, y: -1, z: 0 },
    };

    const chamfer = await modifySolidEdge(mesh, edgeFromRealPicker, 1, false, 1);

    expect(chamfer).not.toBeNull();
    expect(Math.abs(signedVolume(chamfer!))).toBeCloseTo(478, 2);
    const xs = Array.from(chamfer!.positions).filter((_value, index) => index % 3 === 0);
    expect(Math.max(...xs)).toBeCloseTo(25, 5);
  });

  it('fillets only the selected boundary of an existing chamfer', async () => {
    const mesh = createBoxMesh(10, 6, 4);
    const corner = {
      solidId: 'box',
      start: { x: 5, y: 3, z: 0 }, end: { x: 5, y: 3, z: 4 },
      normalA: { x: 1, y: 0, z: 0 }, normalB: { x: 0, y: 1, z: 0 },
    };
    const chamfer = (await modifySolidEdge(mesh, corner, 1, false, 1))!;
    const boundary = {
      solidId: 'box',
      start: { x: 5, y: 2, z: 0 }, end: { x: 5, y: 2, z: 4 },
      normalA: { x: 1, y: 0, z: 0 },
      normalB: { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 },
    };

    const rounded = await modifySolidEdge(chamfer, boundary, 0.25, true);

    expect(rounded).not.toBeNull();
    const bounds = (axis: number): [number, number] => {
      const values = Array.from(rounded!.positions).filter((_value, index) => index % 3 === axis);
      return [Math.min(...values), Math.max(...values)];
    };
    expect(bounds(0)).toEqual([expect.closeTo(-5, 4), expect.closeTo(5, 4)]);
    expect(bounds(1)).toEqual([expect.closeTo(-3, 4), expect.closeTo(3, 4)]);
    expect(bounds(2)).toEqual([expect.closeTo(0, 4), expect.closeTo(4, 4)]);
    expect(Math.abs(signedVolume(rounded!))).toBeLessThan(Math.abs(signedVolume(chamfer)));
    expect(Math.abs(signedVolume(rounded!))).toBeGreaterThan(237);
  });

  it('keeps a chamfer boundary continuous and fillets it through both ends', async () => {
    const box = createBoxMesh(10, 6, 4);
    const corner = pickedSolidEdges(box).find((edge) =>
      edge.start.x === 5 && edge.start.y === 3
      && edge.end.x === 5 && edge.end.y === 3
    )!;
    const chamfer = (await modifySolidEdge(box, corner, 1, false, 1))!;
    const edges = pickedSolidEdges(chamfer);
    const boundarySegments = edges.filter((edge) => [edge.start, edge.end].every((point) =>
      Math.abs(point.x - 5) < 1e-3 && Math.abs(point.y - 2) < 1e-3
    ));
    expect(boundarySegments).toHaveLength(1);
    expect(Math.abs(boundarySegments[0].end.z - boundarySegments[0].start.z)).toBeCloseTo(4, 4);

    const rounded = await modifySolidEdge(chamfer, boundarySegments[0], 0.2, true);

    expect(rounded).not.toBeNull();
    const interiorCaps = solidPlanarFaces(rounded!).filter((face) =>
      Math.abs(face.normal.z) > 0.999
      && face.plane.origin.z > 1e-3
      && face.plane.origin.z < 4 - 1e-3
    );
    expect(interiorCaps).toHaveLength(0);
  });

  it('fillets any remaining asymmetric chamfer split as one complete logical edge', async () => {
    const box = createBoxMesh(10, 6, 4);
    let splitEdgesChecked = 0;
    for (const originalEdge of pickedSolidEdges(box)) {
      const chamfer = await modifySolidEdge(box, originalEdge, 1, false, 2);
      expect(chamfer).not.toBeNull();
      const edges = pickedSolidEdges(chamfer!);
      for (const segment of edges) {
        const complete = completeCollinearEdge(segment, edges);
        if (!complete) continue;
        splitEdgesChecked++;
        const label = [
          `chamfer ${originalEdge.start.x},${originalEdge.start.y},${originalEdge.start.z}`,
          `-> ${originalEdge.end.x},${originalEdge.end.y},${originalEdge.end.z}`,
          `edge ${segment.start.x},${segment.start.y},${segment.start.z}`,
          `-> ${segment.end.x},${segment.end.y},${segment.end.z}`,
        ].join(' ');
        const fromSegment = await modifySolidEdge(chamfer!, segment, 0.15, true);
        const fromComplete = await modifySolidEdge(chamfer!, complete, 0.15, true);
        expect(fromSegment, label).not.toBeNull();
        expect(fromComplete, label).not.toBeNull();
        expect(Math.abs(signedVolume(fromSegment!)), label).toBeCloseTo(
          Math.abs(signedVolume(fromComplete!)),
          3,
        );
      }
    }
    expect(splitEdgesChecked).toBeGreaterThan(0);
  });

  it('fillets the oblique end edge of an asymmetric chamfer without remote deformation', async () => {
    const box = createBoxMesh(10, 6, 4);
    const originalEdge = pickedSolidEdges(box).find((edge) =>
      edge.start.x === -5 && edge.start.y === -3 && edge.start.z === 0
      && edge.end.x === 5 && edge.end.y === -3 && edge.end.z === 0
    )!;
    const chamfer = (await modifySolidEdge(box, originalEdge, 1, false, 2))!;
    const obliqueEdge = pickedSolidEdges(chamfer).find((edge) =>
      Math.abs(edge.start.x + 5) < 1e-3
      && Math.abs(edge.start.y + 2) < 1e-3
      && Math.abs(edge.start.z) < 1e-3
      && Math.abs(edge.end.x + 5) < 1e-3
      && Math.abs(edge.end.y + 3) < 1e-3
      && Math.abs(edge.end.z - 2) < 1e-3
    )!;

    const rounded = await modifySolidEdge(chamfer, obliqueEdge, 0.15, true);

    expect(rounded).not.toBeNull();
    const edgeLength = Math.hypot(
      obliqueEdge.end.x - obliqueEdge.start.x,
      obliqueEdge.end.y - obliqueEdge.start.y,
      obliqueEdge.end.z - obliqueEdge.start.z,
    );
    const along = {
      x: (obliqueEdge.end.x - obliqueEdge.start.x) / edgeLength,
      y: (obliqueEdge.end.y - obliqueEdge.start.y) / edgeLength,
      z: (obliqueEdge.end.z - obliqueEdge.start.z) / edgeLength,
    };
    const internalEndCaps = solidPlanarFaces(rounded!).filter((face) => Math.abs(
      face.normal.x * along.x + face.normal.y * along.y + face.normal.z * along.z,
    ) > 0.999);
    expect(internalEndCaps).toHaveLength(0);
    expect(Math.abs(signedVolume(rounded!))).toBeLessThan(Math.abs(signedVolume(chamfer)));
    expect(Math.abs(signedVolume(rounded!))).toBeGreaterThan(Math.abs(signedVolume(chamfer)) - 0.1);
  });

  it('keeps a 2 by 2 chamfer with radius 1 fillets local on every longitudinal edge', async () => {
    const box = createBoxMesh(10, 6, 4);
    let edgesChecked = 0;
    for (const originalEdge of pickedSolidEdges(box)) {
      const originalVector = {
        x: originalEdge.end.x - originalEdge.start.x,
        y: originalEdge.end.y - originalEdge.start.y,
        z: originalEdge.end.z - originalEdge.start.z,
      };
      const originalLength = Math.hypot(originalVector.x, originalVector.y, originalVector.z);
      const chamfer = await modifySolidEdge(box, originalEdge, 2, false, 2);
      expect(chamfer).not.toBeNull();
      const chamferVolume = Math.abs(signedVolume(chamfer!));
      for (const edge of pickedSolidEdges(chamfer!)) {
        const vector = {
          x: edge.end.x - edge.start.x,
          y: edge.end.y - edge.start.y,
          z: edge.end.z - edge.start.z,
        };
        const length = Math.hypot(vector.x, vector.y, vector.z);
        const parallel = Math.abs(
          (vector.x * originalVector.x + vector.y * originalVector.y + vector.z * originalVector.z)
          / (length * originalLength),
        );
        if (parallel < 0.99999 || length < originalLength - 1e-3) continue;
        edgesChecked++;
        const label = [
          `chamfer ${originalEdge.start.x},${originalEdge.start.y},${originalEdge.start.z}`,
          `-> ${originalEdge.end.x},${originalEdge.end.y},${originalEdge.end.z}`,
          `fillet ${edge.start.x},${edge.start.y},${edge.start.z}`,
          `-> ${edge.end.x},${edge.end.y},${edge.end.z}`,
        ].join(' ');
        const rounded = await modifySolidEdge(chamfer!, edge, 1, true);
        expect(rounded, label).not.toBeNull();
        const roundedVolume = Math.abs(signedVolume(rounded!));
        expect(roundedVolume, label).toBeLessThan(chamferVolume);
        expect(roundedVolume, label).toBeGreaterThan(chamferVolume - originalLength * 3);
        expect(maxConvexViolation(rounded!), label).toBeLessThan(1e-3);
      }
    }
    expect(edgesChecked).toBeGreaterThan(0);
  });

  it('deletes a baked chamfer face by extending the original side planes', async () => {
    const footprint = [[-5, -3], [5, -3], [5, 2], [4, 3], [-5, 3]] as const;
    const positions = new Float32Array([
      ...footprint.flatMap(([x, y]) => [x, y, 0]),
      ...footprint.flatMap(([x, y]) => [x, y, 4]),
    ]);
    const indices: number[] = [];
    for (let index = 1; index < footprint.length - 1; index++) {
      indices.push(0, index + 1, index);
      indices.push(5, 5 + index, 5 + index + 1);
    }
    for (let index = 0; index < footprint.length; index++) {
      const next = (index + 1) % footprint.length;
      indices.push(index, next, 5 + next, index, 5 + next, 5 + index);
    }
    const chamfer = { positions, indices: new Uint32Array(indices) };
    const cutFace = solidPlanarFaces(chamfer).find((face) =>
      face.normal.x > 0.5 && face.normal.y > 0.5
    )!;

    const healed = await deletePlanarSolidFace(chamfer, cutFace.vertexIndices);

    expect(healed).not.toBeNull();
    expect(Math.abs(signedVolume(healed!))).toBeCloseTo(240, 4);
    expect(solidPlanarFaces(healed!)).toHaveLength(6);
  });

  it('refuses a face whose removal would leave the body open and unbounded', async () => {
    const box = createBoxMesh(10, 6, 4);
    const top = solidPlanarFaces(box).find((face) => face.normal.z > 0.9)!;

    expect(await deletePlanarSolidFace(box, top.vertexIndices)).toBeNull();
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
