import type { Solid } from '../../entities/types';
import type { CommandRun, StepOutcome } from '../types';

/** Gather 3D solids first, then hand exactly that set to the file-save flow. */
export function exportStlSelection({ ctx, step, value, data, gather }: CommandRun): StepOutcome | Promise<StepOutcome> {
  if (step.kind !== 'solid') return 'advance';
  if (gather(value)) return 'stay';

  const solids = (data.solids as Solid[] | undefined) ?? [];
  if (solids.length === 0) {
    ctx.log('STL export: select at least one 3D solid.');
    return 'stay';
  }
  if (!ctx.exportStl) {
    ctx.log('STL export is not available.');
    return 'stay';
  }

  const saving = ctx.exportStl(solids);
  return saving instanceof Promise ? saving.then(() => 'advance') : 'advance';
}
