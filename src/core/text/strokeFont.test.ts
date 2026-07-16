import { describe, expect, it } from 'vitest';
import { isStrokeFont, STROKE_FONT, strokeText, strokeTextWidth } from './strokeFont';

const bounds = (paths: Array<Array<{ x: number; y: number }>>) => {
  const points = paths.flat();
  return {
    minX: Math.min(...points.map((p) => p.x)), maxX: Math.max(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)), maxY: Math.max(...points.map((p) => p.y)),
  };
};

const at = (position = { x: 0, y: 0 }, height = 21, rotation?: number) => ({ position, height, rotation });

describe('strokeText', () => {
  it('draws a letter as strokes, not as an outline', () => {
    // The whole reason this exists. An outline "A" is two *closed* loops — the
    // silhouette and the triangular hole — which engraves as the edges of the
    // letter rather than the letter. Every run here is open: a pen going down,
    // along, and up.
    const paths = strokeText('A', at());
    expect(paths.length).toBeGreaterThan(1);
    for (const path of paths) {
      expect(path.length).toBeGreaterThan(1);
      const [first] = path;
      const last = path[path.length - 1];
      expect(Math.hypot(last.x - first.x, last.y - first.y), 'a closed run is an outline').toBeGreaterThan(1e-6);
    }
  });

  it('sits on the baseline and stands the height it was asked for', () => {
    const box = bounds(strokeText('H', at({ x: 0, y: 0 }, 10)));
    // Cap height is what TextEntity.height means, so an H is exactly that tall
    // and rests on y = 0 rather than straddling it.
    expect(box.minY).toBeCloseTo(0, 6);
    expect(box.maxY).toBeCloseTo(10, 6);
  });

  it('starts where it was put', () => {
    const box = bounds(strokeText('H', at({ x: 100, y: 50 }, 10)));
    // The position is where the pen starts, not where the ink does: a glyph
    // keeps its left bearing, so the H stands just inside its own origin.
    expect(box.minX).toBeGreaterThanOrEqual(100);
    expect(box.minX).toBeLessThan(102);
    expect(box.minY).toBeCloseTo(50, 6);
  });

  it('advances along the line rather than piling letters up', () => {
    const one = bounds(strokeText('I', at()));
    const three = bounds(strokeText('III', at()));
    expect(three.maxX).toBeGreaterThan(one.maxX * 2);
  });

  it('leaves a gap for a space, which has no strokes of its own', () => {
    expect(strokeText(' ', at())).toEqual([]);
    expect(strokeTextWidth('A A', 21)).toBeGreaterThan(strokeTextWidth('AA', 21));
  });

  it('turns with its rotation', () => {
    const upright = bounds(strokeText('H', at({ x: 0, y: 0 }, 10)));
    const turned = bounds(strokeText('H', at({ x: 0, y: 0 }, 10, Math.PI / 2)));
    // A quarter turn takes the height into the width and back again.
    expect(turned.maxY).toBeCloseTo(upright.maxX, 6);
    expect(turned.minX).toBeCloseTo(-upright.maxY, 6);
  });

  it('descends below the baseline where the letter does', () => {
    expect(bounds(strokeText('g', at({ x: 0, y: 0 }, 10))).minY).toBeLessThan(0);
    expect(bounds(strokeText('o', at({ x: 0, y: 0 }, 10))).minY).toBeCloseTo(0, 6);
  });

  it('has a drawing for every printable character', () => {
    for (let code = 33; code < 127; code++) {
      const character = String.fromCharCode(code);
      expect(strokeText(character, at()).length, `no strokes for ${character} (${code})`).toBeGreaterThan(0);
    }
  });

  it('skips a character it has no drawing for rather than inventing one', () => {
    // Outside the font's range: better a visible gap than a wrong letter.
    expect(strokeText('č', at())).toEqual([]);
    expect(strokeText('AčA', at()).length).toBe(strokeText('AA', at()).length);
  });
});

describe('strokeTextWidth', () => {
  it('measures without drawing', () => {
    const box = bounds(strokeText('MyCAD', at({ x: 0, y: 0 }, 10)));
    // Advance includes the bearing past the last stroke, so it is never less
    // than the ink — but it must be close, or bounds and picking will lie.
    const width = strokeTextWidth('MyCAD', 10);
    expect(width).toBeGreaterThanOrEqual(box.maxX - 1e-6);
    expect(width).toBeLessThan((box.maxX - box.minX) * 1.2);
  });

  it('grows with the height', () => {
    expect(strokeTextWidth('AB', 20)).toBeCloseTo(strokeTextWidth('AB', 10) * 2, 6);
  });
});

describe('isStrokeFont', () => {
  it('tells the one font that can be plotted from the ones that cannot', () => {
    expect(isStrokeFont(STROKE_FONT)).toBe(true);
    expect(isStrokeFont('Arial')).toBe(false);
    expect(isStrokeFont(undefined)).toBe(false);
  });
});
