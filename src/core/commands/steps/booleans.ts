/**
 * Joining solids and cutting them apart.
 *
 * Every operand is promoted to an OpenCascade B-rep first. Imported and old
 * project meshes therefore remain usable, but the boolean result has one exact
 * source of truth instead of a second mesh-only modelling path.
 */
import { ReplaceObjectsEdit } from '../../history/edits';
import type { Solid, SolidFeature } from '../../entities/types';
import { booleanExactSolids } from '../../geometry/ExactSolid';
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
  let feature = copyFeature(baseSolid);
  for (const toolSolid of toolSolids) {
    feature = {
      kind: 'boolean',
      operation: 'subtract',
      operands: [feature, copyFeature(toolSolid)],
    };
  }
  const exact = await booleanExactSolids('subtract', [baseSolid, ...toolSolids]);
  if (!exact) {
    ctx.log('Subtract failed — a body could not be converted to a closed B-rep, or a sliced mesh remnant is too faceted. Rebuild it as a clean solid first.');
    return 'stay';
  }
  const solid = ctx.doc.createSolid(exact.mesh, 'Subtract', baseSolid.height, [], undefined, feature);
  solid.exact = exact.exact;
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
  const exact = await booleanExactSolids('union', sources);
  if (!exact) {
    ctx.log('Union failed — a body is too faceted to join (a sliced mesh remnant). Rebuild it as a clean solid first, then union.');
    return 'advance';
  }
  const solid = ctx.doc.createSolid(exact.mesh, 'Union', 0, [], undefined, {
    kind: 'boolean',
    operation: 'union',
    operands: sources.map(copyFeature),
  });
  solid.exact = exact.exact;
  ctx.history.execute(new ReplaceObjectsEdit('Union', [], sources, [], [solid]));
  ctx.log('Union complete.');
  return 'advance';
}

export async function intersectSolids(run: CommandRun): Promise<StepOutcome> {
  const { ctx, data, value } = run;
  if (typeof value === 'string') {
    run.gather(value);
    return 'stay';
  }
  const sources = data.solids as Solid[];
  if (sources.length < 2) {
    ctx.log('Intersect requires at least two solids.');
    return 'stay';
  }
  ctx.log(`Intersecting ${sources.length} solids…`);
  const feature: SolidFeature = {
    kind: 'boolean', operation: 'intersect', operands: sources.map(copyFeature),
  };
  const exact = await booleanExactSolids('intersect', sources);
  if (!exact) {
    ctx.log('The selected solids do not share a solid volume.');
    return 'stay';
  }
  const solid = ctx.doc.createSolid(exact.mesh, 'Intersect', 0, [], undefined, feature);
  solid.exact = exact.exact;
  ctx.history.execute(new ReplaceObjectsEdit('Intersect', [], sources, [], [solid]));
  ctx.log('Intersect complete.');
  return 'advance';
}
