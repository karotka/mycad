import { describe, expect, it } from 'vitest';
import { ACI_BYBLOCK, ACI_BYLAYER, aciToRgb, resolveAci, rgbToAci } from './DxfAci';

describe('aciToRgb', () => {
  it('has the fixed palette exactly', () => {
    expect(aciToRgb(1)).toBe(0xff0000);
    expect(aciToRgb(5)).toBe(0x0000ff);
    expect(aciToRgb(7)).toBe(0xffffff);
  });

  it('has no colour for the meanings or for out of range', () => {
    expect(aciToRgb(0)).toBeNull();
    expect(aciToRgb(256)).toBeNull();
    expect(aciToRgb(-1)).toBeNull();
  });
});

describe('rgbToAci', () => {
  it('finds the exact index for a palette colour', () => {
    for (const index of [1, 2, 3, 4, 5, 6, 7]) {
      expect(rgbToAci(aciToRgb(index)!)).toBe(index);
    }
  });

  it('lands on the nearest slot for a colour the palette does not hold', () => {
    // A colour off the picker is not usually an AutoCAD colour, so it snaps to
    // the closest one — and back again gives something close, not identical.
    const index = rgbToAci(0xfe0201);
    expect(index).toBe(1); // all but red
    expect(rgbToAci(0x010200)).toBe(rgbToAci(0x000100)); // both nearest to green-ish
  });

  it('never answers with a meaning', () => {
    // 0 and 256 are BYBLOCK and BYLAYER; a concrete colour is always a real slot.
    for (const rgb of [0x000000, 0xffffff, 0x123456, 0x7f7f7f]) {
      const index = rgbToAci(rgb);
      expect(index).toBeGreaterThanOrEqual(1);
      expect(index).toBeLessThanOrEqual(255);
    }
  });

  it('round-trips a picked colour to within a shade', () => {
    // The reverse cannot be exact — 24 bits do not fit in 256 — but the nearest
    // slot must be genuinely near, or the drawing changes colour on export.
    const rgb = 0x3366cc;
    const back = aciToRgb(rgbToAci(rgb))!;
    const channel = (value: number, shift: number) => (value >> shift) & 0xff;
    for (const shift of [16, 8, 0]) {
      expect(Math.abs(channel(rgb, shift) - channel(back, shift))).toBeLessThan(90);
    }
  });
});

describe('resolveAci', () => {
  it('takes the layer colour when the object says BYLAYER', () => {
    expect(resolveAci(ACI_BYLAYER, 1)).toBe(0xff0000);
    expect(resolveAci(ACI_BYBLOCK, 3)).toBe(0x00ff00);
  });

  it('takes its own colour when it has one', () => {
    // An override beats the layer, which is the whole reason to have one.
    expect(resolveAci(5, 1)).toBe(0x0000ff);
  });

  it('falls back to white when nothing has a real colour', () => {
    // A layer that is itself BYLAYER resolves to nothing, so white is the floor.
    expect(resolveAci(ACI_BYLAYER, ACI_BYLAYER)).toBe(0xffffff);
  });
});
