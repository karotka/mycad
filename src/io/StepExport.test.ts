import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { buildExactBox } from '../core/geometry/ExactSolid';
import { openCascadeKernel } from '../core/geometry/OpenCascadeRuntime';
import { exportStepSolids } from './StepExport';

describe('exportStepSolids', () => {
  it('exports every solid with current exact geometry into one STEP file', async () => {
    const feature = { kind: 'primitive' as const, primitive: 'box' as const, center: { x: 0, y: 0 }, width: 2, depth: 4, height: 6 };
    const geometry = await buildExactBox(feature);
    const doc = new Document();
    const solid = doc.createSolid(geometry.mesh, 'Box', 6, [], undefined, feature);
    solid.exact = geometry.exact;

    const kernel = await openCascadeKernel();
    const result = await exportStepSolids(kernel, [solid]);
    expect(result).toMatchObject({ exported: 1, skipped: 0 });
    expect(result.step).toContain('ISO-10303-21');
  });

  it('skips a solid with no current exact geometry and still exports the rest', async () => {
    const feature = { kind: 'primitive' as const, primitive: 'box' as const, center: { x: 0, y: 0 }, width: 2, depth: 4, height: 6 };
    const geometry = await buildExactBox(feature);
    const doc = new Document();
    const good = doc.createSolid(geometry.mesh, 'Box', 6, [], undefined, feature);
    good.exact = geometry.exact;
    // No `.exact` to promote from, and a mesh too small for the faceted-mesh
    // fallback either — promotion has no way to succeed for this one.
    const emptyMesh = { positions: new Float32Array(), indices: new Uint32Array(), triangleFaceIds: new Uint32Array() };
    const stale = doc.createSolid(emptyMesh, 'Stale', 6, [], undefined, { kind: 'mesh' });

    const kernel = await openCascadeKernel();
    const result = await exportStepSolids(kernel, [good, stale]);
    expect(result).toMatchObject({ exported: 1, skipped: 1 });
  });

  it('refuses to export when nothing could be prepared', async () => {
    const doc = new Document();
    const stale = doc.createSolid({ positions: new Float32Array(), indices: new Uint32Array(), triangleFaceIds: new Uint32Array() }, 'Stale', 0, [], undefined, { kind: 'mesh' });
    const kernel = await openCascadeKernel();
    await expect(exportStepSolids(kernel, [stale])).rejects.toThrow('could be prepared');
  });
});
