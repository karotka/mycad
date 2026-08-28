import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { openCascadeKernel } from '../core/geometry/OpenCascadeRuntime';
import { exportStepSolids } from './StepExport';
import { importStepSolids } from './StepImport';

describe('importStepSolids', () => {
  it('reads a solid back with real exact geometry, not a mesh approximation', async () => {
    const doc = new Document();
    const kernel = await openCascadeKernel();
    const boxShape = kernel.makeBox({ x: 20, y: 30, z: 40 });
    const step = kernel.writeStep([boxShape]);
    boxShape.dispose();

    const result = importStepSolids(doc, kernel, step);
    expect(result).toMatchObject({ skipped: 0 });
    expect(result.solids).toHaveLength(1);
    const [solid] = result.solids;
    expect(solid.name).toBe('STEP import');
    expect(solid.height).toBeCloseTo(40, 6);
    expect(solid.exact?.kernel).toBe('opencascade');

    // Round trip through export again, proving it really is exact B-rep.
    const reExported = await exportStepSolids(kernel, [solid]);
    expect(reExported).toMatchObject({ exported: 1, skipped: 0 });
  });

  it('imports every part of a multi-solid STEP file, numbering them', async () => {
    const doc = new Document();
    const kernel = await openCascadeKernel();
    const box = kernel.makeBox({ x: 2, y: 2, z: 2 });
    const sphere = kernel.makeSphere(3, { x: 20, y: 0, z: 0 });
    const step = kernel.writeStep([box, sphere]);
    box.dispose();
    sphere.dispose();

    const result = importStepSolids(doc, kernel, step);
    expect(result.solids).toHaveLength(2);
    expect(result.solids.map((solid) => solid.name)).toEqual(['STEP import 1', 'STEP import 2']);
  });

  it('refuses a file with no shapes at all', async () => {
    const doc = new Document();
    const kernel = await openCascadeKernel();
    expect(() => importStepSolids(doc, kernel, 'not a step file')).toThrow();
  });
});
