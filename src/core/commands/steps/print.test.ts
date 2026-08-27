import { describe, expect, it, vi } from 'vitest';
import { selectPrintArea } from './print';
import type { ActiveCommand, CommandContext, CommandRun } from '../types';

function run(ctx: CommandContext, active: ActiveCommand, value: unknown): CommandRun {
  return {
    ctx,
    active,
    step: { kind: 'point', label: '' },
    value,
    data: active.data,
    gather: () => false,
    cancel: () => {},
  };
}

function context(exportPdf?: CommandContext['exportPdf']): CommandContext {
  return {
    doc: {} as CommandContext['doc'],
    log: vi.fn(),
    prompt: vi.fn(),
    getCursor: () => ({ x: 0, y: 0 }),
    redraw: vi.fn(),
    history: {} as CommandContext['history'],
    moveObjects: vi.fn(),
    copyWorldDelta: () => undefined,
    exportPdf,
  };
}

describe('selectPrintArea', () => {
  it('stores the first corner and advances', () => {
    const ctx = context();
    const active: ActiveCommand = { name: 'PRINTAREA', steps: [], stepIndex: 0, data: {} };
    const outcome = selectPrintArea(run(ctx, active, { x: 1, y: 2 }));
    expect(outcome).toBe('advance');
    expect(active.data.start).toEqual({ x: 1, y: 2 });
  });

  it('normalises the two picked corners into a min/max window regardless of drag direction', () => {
    const exportPdf = vi.fn();
    const ctx = context(exportPdf);
    const active: ActiveCommand = { name: 'PRINTAREA', steps: [], stepIndex: 1, data: { start: { x: 10, y: 10 } } };
    selectPrintArea(run(ctx, active, { x: 2, y: 8 }));
    expect(exportPdf).toHaveBeenCalledWith({ min: { x: 2, y: 8 }, max: { x: 10, y: 10 } });
  });

  it('logs instead of throwing when nothing is wired to export', () => {
    const ctx = context(undefined);
    const active: ActiveCommand = { name: 'PRINTAREA', steps: [], stepIndex: 1, data: { start: { x: 0, y: 0 } } };
    expect(() => selectPrintArea(run(ctx, active, { x: 5, y: 5 }))).not.toThrow();
    expect(ctx.log).toHaveBeenCalled();
  });
});
