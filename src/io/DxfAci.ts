/**
 * AutoCAD Color Index → RGB.
 *
 * 1–9 and 250–255 are the fixed palette entries that real drawings overwhelmingly
 * use, and are exact. 10–249 are laid out as 24 hues × 10 shades; those are
 * reconstructed from that layout rather than tabulated, so they land close to
 * AutoCAD's palette without being identical.
 */

const FIXED: Record<number, number> = {
  1: 0xff0000, // red
  2: 0xffff00, // yellow
  3: 0x00ff00, // green
  4: 0x00ffff, // cyan
  5: 0x0000ff, // blue
  6: 0xff00ff, // magenta
  7: 0xffffff, // black on paper, white on a dark viewport
  8: 0x808080,
  9: 0xc0c0c0,
  250: 0x333333,
  251: 0x5b5b5b,
  252: 0x848484,
  253: 0xadadad,
  254: 0xd6d6d6,
  255: 0xffffff,
};

/** Colour 256 means BYLAYER and 0 means BYBLOCK; neither is a colour of its own. */
export const ACI_BYLAYER = 256;
export const ACI_BYBLOCK = 0;

export function aciToRgb(index: number): number | null {
  if (!Number.isInteger(index) || index < 1 || index > 255) return null;
  const fixed = FIXED[index];
  if (fixed !== undefined) return fixed;

  const offset = index - 10;
  const hue = Math.floor(offset / 10) * 15;
  const shade = offset % 10;
  // Even shades are fully saturated, odd ones washed out; each pair steps darker.
  const value = 1 - Math.floor(shade / 2) * 0.19;
  const saturation = shade % 2 === 0 ? 1 : 0.45;
  return hsvToRgb(hue, saturation, value);
}

function hsvToRgb(hue: number, saturation: number, value: number): number {
  const c = value * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = value - c;
  const sector = Math.floor(hue / 60) % 6;
  const [r, g, b] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][sector];
  const byte = (channel: number): number => Math.max(0, Math.min(255, Math.round((channel + m) * 255)));
  return (byte(r) << 16) | (byte(g) << 8) | byte(b);
}
