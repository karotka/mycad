import type { Solid } from '../core/entities/types';
import { openExactShape, promoteSolidToExact } from '../core/geometry/ExactSolid';
import type { OpenCascadeKernel } from '../core/geometry/OpenCascadeKernel';

export interface StepExportResult {
  step: string;
  exported: number;
  skipped: number;
}

/**
 * STEP (ISO 10303) hands another CAD program the true B-rep — the same
 * surfaces and edges MyCAD has, not a fixed triangle mesh the way STL does.
 * A solid without current exact geometry (an old project not yet promoted,
 * or one that never got past the faceted-mesh boolean fallback) is skipped
 * rather than failing the whole export.
 */
export async function exportStepSolids(kernel: OpenCascadeKernel, solids: readonly Solid[]): Promise<StepExportResult> {
  const shapes = [];
  let skipped = 0;
  try {
    for (const solid of solids) {
      const shape = await promoteSolidToExact(solid) ? await openExactShape(solid, kernel) : null;
      if (shape) shapes.push(shape); else skipped++;
    }
    if (shapes.length === 0) throw new Error('None of the selected solids could be prepared for STEP export.');
    return { step: kernel.writeStep(shapes), exported: shapes.length, skipped };
  } finally {
    shapes.forEach((shape) => shape.dispose());
  }
}
