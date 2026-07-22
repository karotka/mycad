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

export async function subtractSolids(run: CommandRun): Promise<StepOutcome> {
  const { ctx, active, data, value } = run;
  if (active.stepIndex === 0) {
    if (typeof value === 'string') {
      if (!data.baseId) {
        data.baseId = value;
        ctx.log(`Base solid selected: ${value}. Press Enter to select cutting solids.`);
      } else {
        ctx.log('A base solid is already selected. Press Enter to continue.');
      }
      return 'stay';
    }
    if (!data.baseId) {
      ctx.log('Select one base solid first.');
      return 'stay';
    }
    return 'advance';
  }

  const baseSolid = ctx.doc.getSolid(data.baseId as string);
  if (typeof value === 'string') {
    if (value === data.baseId) {
      ctx.log('The base solid cannot subtract itself.');
      return 'stay';
    }
    run.gather(value);
    return 'stay';
  }
  const toolSolids = (data.solids as Solid[]).filter((solid) => solid.id !== data.baseId);
  if (!baseSolid || toolSolids.length === 0) {
    ctx.log('Select a base solid and at least one cutting solid.');
    return 'stay';
  }
  ctx.log(`Subtracting ${toolSolids.length} solid(s)…`);
  let mesh = baseSolid.mesh;
  let feature = copyFeature(baseSolid);
  for (const toolSolid of toolSolids) {
    const next = await booleanSubtract(mesh, toolSolid.mesh);
    if (!next) {
      ctx.log(`Subtract failed on ${toolSolid.name}.`);
      return 'stay';
    }
    mesh = next;
    feature = {
      kind: 'boolean',
      operation: 'subtract',
      operands: [feature, copyFeature(toolSolid)],
    };
  }
  const solid = ctx.doc.createSolid(mesh, 'Subtract', baseSolid.height, [], undefined, feature);
  ctx.history.execute(new ReplaceObjectsEdit('Subtract', [], [baseSolid, ...toolSolids], [], [solid]));
  ctx.log(`Subtract complete: ${toolSolids.length} cutting solid(s).`);
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
