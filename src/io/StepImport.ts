import type { Document } from '../core/Document';
import type { Solid } from '../core/entities/types';
import { exactResult } from '../core/geometry/ExactSolid';
import type { OpenCascadeKernel } from '../core/geometry/OpenCascadeKernel';

export interface StepImportResult {
  solids: Solid[];
  skipped: number;
}

/**
 * Every top-level solid in a STEP file, kept as real B-rep rather than
 * flattened to a mesh — a STEP file can hold more than one part. A shape
 * that isn't a genuine solid (a bare shell or surface model, which STEP also
 * allows) is skipped rather than failing the whole import.
 */
export function importStepSolids(doc: Document, kernel: OpenCascadeKernel, text: string): StepImportResult {
  const shapes = kernel.readStep(text);
  const solids: Solid[] = [];
  try {
    shapes.forEach((shape, index) => {
      try {
        const inspection = kernel.inspect(shape);
        const { mesh, exact } = exactResult(kernel, shape, 0);
        const height = inspection.bounds.max.z - inspection.bounds.min.z;
        const name = shapes.length > 1 ? `STEP import ${index + 1}` : 'STEP import';
        const solid = doc.createSolid(mesh, name, height, []);
        solid.exact = exact;
        solids.push(solid);
      } catch {
        // Not a solid (a shell/surface-model entry from the STEP file) — the
        // other shapes in the file still import.
      }
    });
  } finally {
    shapes.forEach((shape) => shape.dispose());
  }
  if (solids.length === 0) throw new Error('None of the shapes in this STEP file could be read as a solid.');
  return { solids, skipped: shapes.length - solids.length };
}
