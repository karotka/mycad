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

/** White. What an object falls back to when nothing else has an opinion. */
export const ACI_WHITE = 7;

/**
 * What to actually draw an object in: its own colour, or its layer's if it says
 * BYLAYER — which is what almost everything says, and the whole point of a layer.
 *
 * Objects used to carry a *copy* of their layer's colour instead, made when they
 * were drawn, so recolouring a layer meant rewriting every object on it and
 * nothing could say "whatever my layer says" and mean it.
 */
export function resolveAci(objectAci: number, layerAci: number): number {
  const own = objectAci === ACI_BYLAYER || objectAci === ACI_BYBLOCK ? layerAci : objectAci;
  return aciToRgb(own) ?? aciToRgb(ACI_WHITE)!;
}

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

/**
 * The palette index whose colour is nearest to `rgb`.
 *
 * The reverse of `aciToRgb` cannot be exact — 24 bits of colour do not fit in
 * 256 slots — so this measures every slot and keeps the closest, in a space
 * weighted the way the eye is (green counts more than red, red more than blue).
 * A drawing coloured from the picker comes out at the nearest AutoCAD colour,
 * which is what a DXF can hold.
 *
 * Never returns 0 or 256: those are BYBLOCK and BYLAYER, meanings rather than
 * colours, and a concrete RGB is always one of the 255 real ones.
 */
export function rgbToAci(rgb: number): number {
  const r = (rgb >> 16) & 0xff, g = (rgb >> 8) & 0xff, b = rgb & 0xff;
  let best = 7;
  let bestDistance = Infinity;
  for (let index = 1; index <= 255; index++) {
    const candidate = aciToRgb(index);
    if (candidate === null) continue;
    const dr = r - ((candidate >> 16) & 0xff);
    const dg = g - ((candidate >> 8) & 0xff);
    const db = b - (candidate & 0xff);
    // Weighted so that "nearest" matches what looks nearest, not what is nearest
    // in raw bytes — the same weighting a greyscale conversion uses.
    const distance = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
    if (distance < bestDistance) { bestDistance = distance; best = index; }
  }
  return best;
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
