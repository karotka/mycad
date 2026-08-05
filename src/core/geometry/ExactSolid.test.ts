import { describe, expect, it } from 'vitest';
import { Document } from '../Document';
import { copySolid, rotateSolidAroundPlane, scaleSolid } from '../commands/steps/transform';
import { WORLD_WORK_PLANE } from '../../math/workplane';
import { buildExactBox, buildExactFeature, hasCurrentExactGeometry, openExactShape } from './ExactSolid';
import { openCascadeKernel } from './OpenCascadeRuntime';
import { mirroredFeature } from '../solids/featureTransform';

describe('exact solid production placement', () => {
  it('keeps one B-rep current through COPY, SCALE and ROTATE', async () => {
    const feature = {
      kind: 'primitive' as const, primitive: 'box' as const,
      center: { x: 0, y: 0 }, width: 2, depth: 4, height: 6,
    };
    const geometry = await buildExactBox(feature);
    const doc = new Document();
    const source = doc.createSolid(geometry.mesh, 'Box', 6, [], undefined, feature);
    source.exact = geometry.exact;

    const copied = copySolid(source, { x: 10, y: 0, z: 0 });
    const scaled = scaleSolid(copied, { x: 10, y: 0, z: 0 }, 2);
    const rotated = rotateSolidAroundPlane(scaled, { x: 10, y: 0, z: 0 }, Math.PI / 2, WORLD_WORK_PLANE);

    expect(hasCurrentExactGeometry(rotated)).toBe(true);
    const kernel = await openCascadeKernel();
    const shape = await openExactShape(rotated, kernel);
    try {
      expect(kernel.inspect(shape!)).toMatchObject({
        bounds: {
          min: { x: expect.closeTo(6, 7), y: expect.closeTo(-2, 7), z: expect.closeTo(0, 7) },
          max: { x: expect.closeTo(14, 7), y: expect.closeTo(2, 7), z: expect.closeTo(12, 7) },
        },
        volume: expect.closeTo(384, 7),
        valid: true,
      });
    } finally {
      shape?.dispose();
    }
  });

  it('regenerates a mirrored left-handed box feature in the same place', async () => {
    const source = {
      kind: 'primitive' as const, primitive: 'box' as const,
      center: { x: 5, y: 2 }, width: 2, depth: 4, height: 6,
    };
    const mirrored = mirroredFeature(source, WORLD_WORK_PLANE, { x: 0, y: 0 }, { x: 0, y: 1 });
    if (!mirrored || mirrored.kind !== 'primitive') throw new Error('expected mirrored box feature');
    const geometry = await buildExactBox(mirrored);
    const doc = new Document();
    const solid = doc.createSolid(geometry.mesh, 'Mirrored box', 6, [], undefined, mirrored);
    solid.exact = geometry.exact;
    const kernel = await openCascadeKernel();
    const shape = await openExactShape(solid, kernel);
    try {
      expect(kernel.inspect(shape!)).toMatchObject({
        bounds: { min: { x: -6, y: 0, z: 0 }, max: { x: -4, y: 4, z: 6 } },
        volume: expect.closeTo(48, 8),
        valid: true,
      });
    } finally {
      shape?.dispose();
    }
  });

  it('places and non-uniformly scales a curved primitive in an arbitrary UCS', async () => {
    const feature = {
      kind: 'primitive' as const, primitive: 'sphere' as const,
      center: { x: 2, y: 3 }, radius: 4, height: 8,
      scale: { x: 2, y: 0.5, z: 1.5 },
      workPlane: {
        origin: { x: 10, y: 20, z: 30 },
        xAxis: { x: 0, y: 1, z: 0 },
        yAxis: { x: 0, y: 0, z: 1 },
        zAxis: { x: 1, y: 0, z: 0 },
      },
    };
    const geometry = await buildExactFeature(feature);
    const doc = new Document();
    const solid = doc.createSolid(geometry!.mesh, 'Ellipsoid', 8, [], undefined, feature);
    solid.exact = geometry!.exact;
    const kernel = await openCascadeKernel();
    const shape = await openExactShape(solid, kernel);
    try {
      expect(kernel.inspect(shape!)).toMatchObject({
        bounds: {
          min: { x: expect.closeTo(4, 5), y: expect.closeTo(16, 5), z: expect.closeTo(29.5, 5) },
          max: { x: expect.closeTo(16, 5), y: expect.closeTo(32, 5), z: expect.closeTo(33.5, 5) },
        },
        volume: expect.closeTo(128 * Math.PI, 6),
        valid: true,
      });
    } finally {
      shape?.dispose();
    }
  });
});
