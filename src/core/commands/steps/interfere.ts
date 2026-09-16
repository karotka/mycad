/**
 * INTERFERE: do these solids share any space, and how much?
 *
 * The question a boolean answers destructively — INTERSECT hands back the
 * overlap and eats both operands — asked without touching the drawing. What
 * it is for is checking an assembly: a shaft in a bore, a bolt through a
 * flange, two parts that must pass each other. AutoCAD's own command, down to
 * offering to keep a solid of each overlap.
 */
import { booleanExactSolids } from '../../geometry/ExactSolid';
import { openExactShape } from '../../geometry/ExactSolid';
import { openCascadeKernel } from '../../geometry/OpenCascadeRuntime';
import { ReplaceObjectsEdit } from '../../history/edits';
import type { Solid } from '../../entities/types';
import type { CommandRun, StepOutcome } from '../types';

interface Overlap {
  first: Solid;
  second: Solid;
  volume: number;
  result: { mesh: Solid['mesh']; exact: Solid['exact'] };
}

/** Every pair that shares space, with how much. Pairs are tried both-ways-once:
 *  overlapping is symmetric, and a pair reported twice reads as two problems. */
async function overlaps(solids: readonly Solid[]): Promise<Overlap[]> {
  const kernel = await openCascadeKernel();
  const found: Overlap[] = [];
  for (let a = 0; a < solids.length; a++) {
    for (let b = a + 1; b < solids.length; b++) {
      const exact = await booleanExactSolids('intersect', [solids[a], solids[b]]);
      // No shared volume is the ordinary answer here, not a failure, and the
      // boolean is what decides it: measured, two solids that merely touch
      // along a whole face come back null just as two far apart do, because
      // a result with no solid in it is refused before it ever gets here.
      if (!exact) continue;
      const shape = await openExactShape({ mesh: exact.mesh, feature: { kind: 'mesh' }, exact: exact.exact, revision: 0 }, kernel);
      if (!shape) continue;
      try {
        found.push({ first: solids[a], second: solids[b], volume: kernel.inspect(shape).volume, result: exact });
      } finally {
        shape.dispose();
      }
    }
  }
  return found;
}

const format = (value: number): string => Number(value.toFixed(4)).toString();

export async function checkInterference(run: CommandRun): Promise<StepOutcome> {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) {
    if (run.gather(value)) return 'stay';
    const solids = (data.solids as Solid[] | undefined) ?? [];
    if (solids.length < 2) {
      ctx.log('INTERFERE needs at least two solids to compare.');
      return 'stay';
    }
    ctx.log(`Checking ${solids.length} solids…`);
    const found = await overlaps(solids);
    data.found = found;
    if (found.length === 0) {
      ctx.log('No interference: none of the selected solids share any space.');
      // Nothing to keep, so the second question would be about nothing.
      active.steps[1] = { kind: 'done' };
      return 'advance';
    }
    for (const overlap of found) {
      ctx.log(`  ${overlap.first.name} and ${overlap.second.name} overlap by ${format(overlap.volume)}`);
    }
    const total = found.reduce((sum, overlap) => sum + overlap.volume, 0);
    ctx.log(`Interference found: ${found.length} pair(s), ${format(total)} in total.`);
    return 'advance';
  }

  const answer = String(value ?? '').trim().toUpperCase();
  const found = (data.found as Overlap[] | undefined) ?? [];
  if (!answer.startsWith('Y')) {
    ctx.log('The solids are left as they were.');
    return 'advance';
  }
  const created = found.map((overlap) => {
    // Baked: an overlap is a fact about two solids as they stand now, not a
    // recipe — move either one and the answer is a different shape entirely,
    // which is not what a feature that rebuilt itself would do.
    const solid = ctx.doc.createSolid(overlap.result.mesh, `Interference_${overlap.first.name}_${overlap.second.name}`, 0, [], undefined, { kind: 'mesh' });
    solid.exact = overlap.result.exact;
    return solid;
  });
  ctx.history.execute(new ReplaceObjectsEdit('Interference', [], [], [], created));
  ctx.doc.clearSelection();
  for (const solid of created) ctx.doc.selectSolid(solid.id, true);
  ctx.log(`Kept ${created.length} interference solid(s).`);
  return 'advance';
}
