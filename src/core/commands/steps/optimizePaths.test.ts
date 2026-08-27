import { describe, expect, it, vi } from 'vitest';
import { Document } from '../../Document';
import { CommandHistory } from '../../history/CommandHistory';
import type { CommandContext } from '../types';
import { optimizeDrawingPaths } from './optimizePaths';

function setup(): { doc: Document; history: CommandHistory; ctx: CommandContext; log: ReturnType<typeof vi.fn> } {
  const doc = new Document();
  const history = new CommandHistory(doc);
  const log = vi.fn();
  return {
    doc, history, log,
    ctx: { doc, history, log, redraw: vi.fn(), prompt: vi.fn(), getCursor: () => ({ x: 0, y: 0 }), moveObjects: vi.fn(), copyWorldDelta: () => undefined },
  };
}

describe('optimizeDrawingPaths', () => {
  it('replaces connected drawing entities and can undo the replacement', () => {
    const { doc, history, ctx, log } = setup();
    doc.addEntity(doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 }));
    doc.addEntity(doc.createBezier({ x: 2, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }));

    optimizeDrawingPaths(ctx);

    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0]).toMatchObject({ type: 'bezier' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('2 objects into 1 Bezier curve'));
    expect(history.undo()).toBe(true);
    expect(doc.entities.map((entity) => entity.type).sort()).toEqual(['bezier', 'line']);
  });

  it('optimizes only the selection when supported objects are selected', () => {
    const { doc, ctx } = setup();
    const a = doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 });
    const b = doc.createLine({ x: 1, y: 0 }, { x: 2, y: 0 });
    const untouched = doc.createLine({ x: 10, y: 0 }, { x: 11, y: 0 });
    doc.addEntity(a); doc.addEntity(b); doc.addEntity(untouched);
    doc.selectEntity(a.id, true); doc.selectEntity(b.id, true);

    optimizeDrawingPaths(ctx);

    expect(doc.entities).toHaveLength(2);
    expect(doc.entities.some((entity) => entity.id === untouched.id)).toBe(true);
  });

  it('joins endpoints whose gap is within the entered tolerance', () => {
    const { doc, ctx } = setup();
    doc.addEntity(doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 }));
    doc.addEntity(doc.createLine({ x: 1.08, y: 0 }, { x: 2, y: 0 }));

    optimizeDrawingPaths(ctx, 0.1);

    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0].type).toBe('bezier');
  });
});
