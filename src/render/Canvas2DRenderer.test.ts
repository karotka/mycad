import { describe, expect, it, vi } from 'vitest';
import { Canvas2DRenderer } from './Canvas2DRenderer';
import { Document } from '../core/Document';
import type { SolidMesh } from '../core/entities/types';

/** A 2D context that records the strokes drawn through it. */
function recordingCanvas() {
  const moves: Array<{ x: number; y: number }> = [];
  const lines: Array<{ x: number; y: number }> = [];
  const base = {
    moveTo: (x: number, y: number) => { moves.push({ x, y }); },
    lineTo: (x: number, y: number) => { lines.push({ x, y }); },
    canvas: { width: 800, height: 600 },
    getLineDash: () => [] as number[],
    measureText: () => ({ width: 0 }),
  };
  // Everything else the renderer reaches for does nothing and answers nothing;
  // only the strokes are under test.
  const context = new Proxy(base as unknown as CanvasRenderingContext2D, {
    get: (target, key) => Reflect.get(target, key) ?? (() => undefined),
    set: () => true,
  });
  const canvas = { getContext: () => context, width: 800, height: 600, style: {} } as unknown as HTMLCanvasElement;
  return { canvas, moves, lines };
}

/** One triangle standing up in x/y, so its projection has a known outline. */
function triangleMesh(): SolidMesh {
  return {
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

describe('the 2D view', () => {
  /** How many strokes a document draws, over and above an empty one — the grid
   *  and the frame draw their own regardless. */
  function strokesFor(build: (doc: Document) => void): number {
    const measure = (apply: (doc: Document) => void) => {
      const { canvas, moves, lines } = recordingCanvas();
      const doc = new Document();
      doc.gridVisible = false;
      apply(doc);
      new Canvas2DRenderer(canvas).render(doc, 800, 600);
      return moves.length + lines.length;
    };
    return measure(build) - measure(() => undefined);
  }

  it('projects surfaces into it, the same as solids', () => {
    // A drawing with a surface in it and nothing else used to draw nothing at
    // all here — reported directly: "kdyz jsem ve 2d, tak se plochy vubec
    // nezobrazi".
    expect(strokesFor((doc) => {
      doc.addSurface(doc.createSurface(triangleMesh(), 'Surface', [], undefined, { kind: 'mesh' }));
    })).toBeGreaterThan(0);
  });

  it('leaves out one whose layer is hidden, as it does for a solid', () => {
    expect(strokesFor((doc) => {
      const surface = doc.createSurface(triangleMesh(), 'Surface', [], undefined, { kind: 'mesh' });
      doc.addSurface(surface);
      doc.hiddenLayers.add(surface.layer);
    })).toBe(0);
  });
});
