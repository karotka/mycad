import { describe, expect, it, vi } from 'vitest';
import { Canvas2DRenderer } from './Canvas2DRenderer';
import { Document } from '../core/Document';
import type { SolidMesh } from '../core/entities/types';

/** A 2D context that records the strokes drawn through it. */
function recordingCanvas() {
  const moves: Array<{ x: number; y: number }> = [];
  const lines: Array<{ x: number; y: number }> = [];
  const texts: string[] = [];
  const base = {
    moveTo: (x: number, y: number) => { moves.push({ x, y }); },
    lineTo: (x: number, y: number) => { lines.push({ x, y }); },
    fillText: (text: string) => { texts.push(text); },
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
  return { canvas, moves, lines, texts };
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

describe('zoom extents in the 2D view', () => {
  const view = (build: (doc: Document) => void) => {
    const { canvas } = recordingCanvas();
    const renderer = new Canvas2DRenderer(canvas);
    const doc = new Document();
    build(doc);
    renderer.zoomExtents(doc, 800, 600);
    return { pan: renderer.pan, zoom: renderer.zoom };
  };

  /** A triangle sitting well away from the origin, where the default view is. */
  function distantMesh(): SolidMesh {
    return {
      positions: new Float32Array([20, 10, 0, 30, 10, 0, 20, 25, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
  }

  it('frames a drawing whose only content is a surface', () => {
    // Measured before this: the view went to the origin while the surface sat
    // between x 16 and 27, so the sheet came up empty.
    const { pan } = view((doc) => {
      doc.addSurface(doc.createSurface(distantMesh(), 'Surface', [], undefined, { kind: 'mesh' }));
    });
    expect(pan.x).toBeCloseTo(25, 6);
    expect(pan.y).toBeCloseTo(17.5, 6);
  });

  it('frames one whose only content is a solid', () => {
    const { pan } = view((doc) => {
      doc.addSolid(doc.createSolid(distantMesh(), 'Solid', 0, [], undefined, { kind: 'mesh' }));
    });
    expect(pan.x).toBeCloseTo(25, 6);
  });

  it('takes in entities and bodies together', () => {
    const { pan } = view((doc) => {
      doc.addEntity(doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 }));
      doc.addSurface(doc.createSurface(distantMesh(), 'Surface', [], undefined, { kind: 'mesh' }));
    });
    expect(pan.x).toBeCloseTo(15, 6);
  });

  it('keeps a default view for an empty drawing', () => {
    const { pan, zoom } = view(() => undefined);
    expect(pan).toEqual({ x: 0, y: 0 });
    expect(zoom).toBeGreaterThan(0);
  });
});

describe('what a rubber-band preview writes on the canvas', () => {
  function preview(type: string, data: unknown): string[] {
    const { canvas, texts } = recordingCanvas();
    const renderer = new Canvas2DRenderer(canvas);
    const doc = new Document();
    doc.gridVisible = false;
    renderer.render(doc, 800, 600, { type, data });
    return texts;
  }

  it('says nothing beside a line: the Length and Angle boxes sit on it already', () => {
    // Reported directly — "L = 7300.80 mm" printed next to the cursor while
    // the boxes on the same segment read 7300.80 and its angle.
    expect(preview('line', { start: { x: 0, y: 0 }, end: { x: 30, y: 40 } })).toEqual([]);
  });

  it("says nothing beside a polyline's pending segment either", () => {
    expect(preview('polyline', { vertices: [{ x: 0, y: 0 }], cursor: { x: 30, y: 40 } })).toEqual([]);
  });

  it('still says it beside a multiline, which has no boxes of its own', () => {
    const written = preview('mline', {
      vertices: [{ x: 0, y: 0 }],
      cursor: { x: 30, y: 40 },
      elements: [{ offset: 0.5, aci: 256, linetype: 'Continuous' }],
    });
    expect(written.join(' ')).toContain('50.00');
  });

  it('says nothing beside a rectangle either: its Width and Height boxes do', () => {
    expect(preview('rectangle', { start: { x: 0, y: 0 }, end: { x: 30, y: 40 } })).toEqual([]);
  });

  it("says nothing beside a circle drawn by its diameter, where the D box sits", () => {
    // It used to print right on the cursor placing the point.
    expect(preview('circleDiameter', { center: { x: 0, y: 0 }, cursor: { x: 30, y: 40 } })).toEqual([]);
  });
});
