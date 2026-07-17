/**
 * Joining solids and cutting them apart.
 *
 * The mesh comes from the engine's boolean over the *meshes*, not from
 * regenerating the feature tree — deliberately. An imported solid has
 * `{ kind: 'mesh' }` and no history to regenerate from, so building it that way
 * would refuse to union anything that came out of a file. The tree it records
 * is then only as regenerable as its parts, which `editedSolid` already checks
 * before touching anything.
 */
import { ReplaceObjectsEdit } from '../../history/edits';
import type { Solid, SolidFeature } from '../../entities/types';
import { booleanSubtract, booleanUnion } from '../../solids/ManifoldEngine';
import type { CommandRun, StepOutcome } from '../types';

/** Deep, because the operand keeps its own tree and the source may yet be edited. */
const copyFeature = (solid: Solid): SolidFeature => JSON.parse(JSON.stringify(solid.feature)) as SolidFeature;

export async function subtractSolids({ ctx, active, data, value }: CommandRun): Promise<StepOutcome> {
  if (active.stepIndex === 0) {
    data.baseId = value;
    ctx.doc.selectSolid(value as string);
    ctx.log(`Base solid selected: ${value as string}`);
    return 'advance';
  }

  const baseSolid = ctx.doc.getSolid(data.baseId as string);
  const toolSolid = ctx.doc.getSolid(value as string);
  if (!baseSolid || !toolSolid) {
    ctx.log('Solid not found.');
    return 'advance';
  }
  ctx.log('Subtracting…');
  const mesh = await booleanSubtract(baseSolid.mesh, toolSolid.mesh);
  if (!mesh) {
    ctx.log('Subtract failed.');
    return 'advance';
  }
  const solid = ctx.doc.createSolid(mesh, 'Subtract', baseSolid.height, [], undefined, {
    kind: 'boolean',
    operation: 'subtract',
    operands: [copyFeature(baseSolid), copyFeature(toolSolid)],
  });
  ctx.history.execute(new ReplaceObjectsEdit('Subtract', [], [baseSolid, toolSolid], [], [solid]));
  ctx.log('Subtract complete.');
  return 'advance';
}

export async function unionSolids({ ctx, active, data, value }: CommandRun): Promise<StepOutcome> {
  const ids = data.solids as string[];
  ids.push(value as string);
  if (active.stepIndex === 0) return 'advance';

  const sources = ids
    .map((id) => ctx.doc.getSolid(id))
    .filter((solid): solid is Solid => Boolean(solid));
  if (sources.length < 2) {
    ctx.log('Two solids are required.');
    return 'advance';
  }
  ctx.log('Joining solids…');
  const mesh = await booleanUnion(sources.map((source) => source.mesh));
  if (!mesh) {
    ctx.log('Union failed.');
    return 'advance';
  }
  const solid = ctx.doc.createSolid(mesh, 'Union', 0, [], undefined, {
    kind: 'boolean',
    operation: 'union',
    operands: sources.map(copyFeature),
  });
  ctx.history.execute(new ReplaceObjectsEdit('Union', [], sources, [], [solid]));
  ctx.log('Union complete.');
  return 'advance';
}
