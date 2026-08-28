import { expandedInsertSolids, type Entity, type Solid } from '../../entities/types';
import type { CommandRun, StepOutcome } from '../types';

/** Gather 3D solids first, then hand exactly that set to the file-save flow. */
export function exportStlSelection({ ctx, step, value, data, gather }: CommandRun): StepOutcome | Promise<StepOutcome> {
  if (step.kind !== 'solid' && step.kind !== 'entity') return 'advance';
  if (gather(value)) return 'stay';

  const solids = [
    ...((data.solids as Solid[] | undefined) ?? []),
    ...((data.entities as Entity[] | undefined) ?? [])
      .filter((entity) => entity.type === 'insert')
      .flatMap((entity) => expandedInsertSolids(entity)),
  ];
  if (solids.length === 0) {
    ctx.log('STL export: select at least one 3D solid or block containing 3D solids.');
    return 'stay';
  }
  if (!ctx.exportStl) {
    ctx.log('STL export is not available.');
    return 'stay';
  }

  const saving = ctx.exportStl(solids);
  return saving instanceof Promise ? saving.then(() => 'advance') : 'advance';
}

/** Gather 3D solids first, then hand exactly that set to the STEP save flow —
 *  the same shape as exportStlSelection, for the format that keeps their
 *  exact B-rep instead of a fixed triangle mesh. */
export function exportStepSelection({ ctx, step, value, data, gather }: CommandRun): StepOutcome | Promise<StepOutcome> {
  if (step.kind !== 'solid' && step.kind !== 'entity') return 'advance';
  if (gather(value)) return 'stay';

  const solids = [
    ...((data.solids as Solid[] | undefined) ?? []),
    ...((data.entities as Entity[] | undefined) ?? [])
      .filter((entity) => entity.type === 'insert')
      .flatMap((entity) => expandedInsertSolids(entity)),
  ];
  if (solids.length === 0) {
    ctx.log('STEP export: select at least one 3D solid or block containing 3D solids.');
    return 'stay';
  }
  if (!ctx.exportStep) {
    ctx.log('STEP export is not available.');
    return 'stay';
  }

  const saving = ctx.exportStep(solids);
  return saving instanceof Promise ? saving.then(() => 'advance') : 'advance';
}
