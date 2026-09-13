import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LINE_TYPE,
  DEFAULT_LINE_WEIGHT_MM,
  LINE_TYPES,
  LINE_TYPE_NAMES,
  lineTypeDashArray,
  linetypeScaleFor,
  lineWeightToPixels,
} from './lineStyles';

describe('lineWeightToPixels', () => {
  it('makes the default weight a hairline', () => {
    expect(lineWeightToPixels(DEFAULT_LINE_WEIGHT_MM)).toBe(1);
  });

  it('scales thicker weights up from the hairline', () => {
    expect(lineWeightToPixels(0.5)).toBe(2);
    expect(lineWeightToPixels(1.0)).toBe(4);
  });

  it('never lets a line thin below a pixel', () => {
    // A weight finer than the hairline would otherwise disappear.
    expect(lineWeightToPixels(0.13)).toBe(1);
    expect(lineWeightToPixels(0)).toBe(1);
  });
});

describe('lineTypeDashArray', () => {
  it('is empty for a solid line', () => {
    expect(lineTypeDashArray('Continuous', 1)).toEqual([]);
    expect(lineTypeDashArray(DEFAULT_LINE_TYPE, 5)).toEqual([]);
  });

  it('is empty for a name it does not know, so a bad value draws solid', () => {
    expect(lineTypeDashArray('Nonsense', 1)).toEqual([]);
  });

  it('scales the pattern with the zoom, because a dash is a world length', () => {
    // Dashed is 12 on, 6 off in mm; at 2× zoom that is 24 on, 12 off in pixels.
    expect(lineTypeDashArray('Dashed', 2)).toEqual([24, 12]);
  });

  it('keeps every segment at least visible when zoomed far out', () => {
    // A tiny dot in the pattern must not round to zero and swallow the line.
    for (const segment of lineTypeDashArray('DashDot', 0.01)) {
      expect(segment).toBeGreaterThanOrEqual(0.5);
    }
  });
});

describe('linetype scale', () => {
  it('multiplies the drawing\'s scale by the object\'s, the way AutoCAD does', () => {
    expect(linetypeScaleFor(4, 0.5)).toBe(2);
  });

  it('treats a missing scale as "not scaled" on either side', () => {
    expect(linetypeScaleFor(undefined, undefined)).toBe(1);
    expect(linetypeScaleFor(3, undefined)).toBe(3);
    expect(linetypeScaleFor(undefined, 3)).toBe(3);
  });

  it('ignores a nonsense scale rather than making the line vanish', () => {
    // Zero or negative would collapse every dash to the 0.5px floor, i.e. a
    // dotted line, which is the very thing the setting exists to fix.
    expect(linetypeScaleFor(0, 2)).toBe(2);
    expect(linetypeScaleFor(-5, 2)).toBe(2);
    expect(linetypeScaleFor(2, Number.NaN)).toBe(2);
  });

  it('stretches the pattern in the drawing, not only on the screen', () => {
    // Dashed is 12 on / 6 off in mm. At 1x zoom and 5x scale that is 60/30 —
    // and the same 5x applies at any zoom, since it multiplies world lengths.
    expect(lineTypeDashArray('Dashed', 1, 5)).toEqual([60, 30]);
    expect(lineTypeDashArray('Dashed', 0.5, 5)).toEqual([30, 15]);
  });

  it('is what rescues a big drawing from drawing dashes as dots', () => {
    // The reported case: a drawing large enough that the stock pattern lands
    // under the half-pixel floor at the zoom needed to see it, so every dashed
    // and centre line reads as a row of dots.
    expect(lineTypeDashArray('Center', 0.02)).toEqual([0.5, 0.5, 0.5, 0.5]);
    // With a scale to match the drawing, the pattern is a pattern again.
    expect(lineTypeDashArray('Center', 0.02, 50)).toEqual([24, 6, 6, 6]);
  });

  it('leaves a solid line solid however it is scaled', () => {
    expect(lineTypeDashArray('Continuous', 1, 50)).toEqual([]);
  });
});

describe('the standard set', () => {
  it('lists its names in a stable order for the picker', () => {
    expect(LINE_TYPE_NAMES[0]).toBe('Continuous');
    expect(LINE_TYPE_NAMES).toContain('Hidden');
    expect(LINE_TYPE_NAMES).toContain('Center');
  });

  it('has a real pattern for every non-solid type', () => {
    for (const [name, pattern] of Object.entries(LINE_TYPES)) {
      if (name === 'Continuous') continue;
      expect(pattern.length, name).toBeGreaterThan(0);
      // An odd-length dash array repeats inverted, which is rarely intended.
      expect(pattern.length % 2, `${name} has an odd pattern`).toBe(0);
    }
  });
});
