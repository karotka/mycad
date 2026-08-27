import type { Vec2 } from '../../../math/geometry';
import type { CommandRun, StepOutcome } from '../types';

/** Two corners in, a print window out — mirrors drawRectangle's two-point
    shape, but hands the window to ctx.exportPdf instead of creating an entity. */
export function selectPrintArea({ ctx, active, data, value }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) {
    data.start = value;
    return 'advance';
  }
  const first = data.start as Vec2;
  const second = value as Vec2;
  if (!ctx.exportPdf) {
    ctx.log('Print to PDF is not available.');
    return 'advance';
  }
  const win = {
    min: { x: Math.min(first.x, second.x), y: Math.min(first.y, second.y) },
    max: { x: Math.max(first.x, second.x), y: Math.max(first.y, second.y) },
  };
  void ctx.exportPdf(win);
  return 'advance';
}
