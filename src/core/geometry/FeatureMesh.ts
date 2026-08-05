import type { BooleanFeature, SolidFeature, SolidMesh } from '../entities/types';
import { buildExactFeature, exactResult } from './ExactSolid';
import { openCascadeKernel } from './OpenCascadeRuntime';
import type { OpenCascadeSolid } from './OpenCascadeKernel';

/** Derives a render mesh from a parametric feature through the exact kernel. */
export async function regenerateExactFeatureMesh(feature: SolidFeature): Promise<SolidMesh | null> {
  return (await buildExactFeature(feature))?.mesh ?? null;
}

/**
 * Test/import compatibility for closed triangle fixtures. Production modelling
 * operates on stored B-reps and does not bounce through this mesh boundary.
 */
export async function exactBooleanMeshes(
  operation: BooleanFeature['operation'],
  meshes: readonly SolidMesh[],
): Promise<SolidMesh | null> {
  if (meshes.length === 0 || (operation !== 'union' && meshes.length < 2)) return null;
  const kernel = await openCascadeKernel();
  const operands: OpenCascadeSolid[] = [];
  let combined: OpenCascadeSolid | null = null;
  let healed: OpenCascadeSolid | null = null;
  try {
    for (const mesh of meshes) {
      const faceted = kernel.fromMesh(mesh.positions, mesh.indices);
      try {
        operands.push(kernel.heal(faceted));
      } finally {
        faceted.dispose();
      }
    }
    combined = operation === 'union'
      ? kernel.union(operands)
      : operation === 'subtract'
        ? kernel.subtract(operands[0], operands.slice(1))
        : kernel.intersect(operands);
    healed = kernel.heal(combined);
    return exactResult(kernel, healed, 0).mesh;
  } catch {
    return null;
  } finally {
    healed?.dispose();
    combined?.dispose();
    operands.forEach((operand) => operand.dispose());
  }
}
