/**
 * Line weight and line type — how thick a layer's lines are, and whether they
 * are solid, dashed, and so on.
 *
 * Both live on the layer, like colour: the layer holds the truth and every
 * object on it draws that way. Unlike colour there is no per-object override
 * yet; a layer is the whole story, which is how most CAD drawing is organised
 * and keeps this simple.
 */

/**
 * The standard pen widths, in millimetres — the ISO set AutoCAD uses. A weight
 * is a *paper* property: 0.5 mm is always 0.5 mm on the sheet, whatever the
 * zoom, which is why it maps to a fixed number of screen pixels rather than
 * scaling with the view.
 */
export const LINE_WEIGHTS_MM = [0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1.0, 1.4, 2.0] as const;

export const DEFAULT_LINE_WEIGHT_MM = 0.25;

/**
 * A thin default line is one pixel; the rest scale from there, so 0.25 mm is the
 * hairline and 1 mm is four times it. Never below a pixel, or a thin line would
 * vanish. Constant on screen — the zoom does not enter into it.
 */
export function lineWeightToPixels(weightMm: number): number {
  return Math.max(1, weightMm / DEFAULT_LINE_WEIGHT_MM);
}

/**
 * The dash patterns, in millimetres of drawn length and gap — the classic CAD
 * set. An empty array is a solid line. The pattern is a *world* length, so a
 * dash is a fixed size in the drawing and scales with the zoom, which is what
 * keeps it looking right close up and far out.
 */
export const LINE_TYPES: Record<string, readonly number[]> = {
  Continuous: [],
  Dashed: [12, 6],
  Hidden: [6, 3],
  Center: [24, 6, 6, 6],
  DashDot: [12, 6, 1, 6],
  Phantom: [24, 6, 6, 6, 6, 6],
};

export const DEFAULT_LINE_TYPE = 'Continuous';

/** The names, in display order — for the layer panel's picker. */
export const LINE_TYPE_NAMES = Object.keys(LINE_TYPES);

/**
 * The dash array for the canvas, in pixels, at the given zoom — the world-length
 * pattern scaled to the screen. Empty (a solid line) for Continuous or an
 * unknown name, so a bad value draws a plain line rather than nothing.
 */
export function lineTypeDashArray(name: string, zoom: number): number[] {
  const pattern = LINE_TYPES[name];
  if (!pattern || pattern.length === 0) return [];
  return pattern.map((length) => Math.max(0.5, length * zoom));
}
