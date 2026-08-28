/**
 * Text as the path a pen walks.
 *
 * The one thing a plotter is for, and the one thing the app could not give it:
 * `TextEntity` draws through the canvas with a system outline font, which has no
 * strokes to follow — only edges to fill. Sent to a machine, an outline font
 * engraves the *outline* of each letter rather than the letter.
 *
 * Pure, and separate from both the renderer and the exporter, because they must
 * agree: what is drawn on screen has to be what comes out of the machine, and
 * two implementations of that would eventually differ.
 */
import type { Vec2 } from '../../math/geometry';
import { HERSHEY_SIMPLEX } from './hersheyData';
import { HERSHEY_DUPLEX } from './hersheyDataDuplex';
import { HERSHEY_TRIPLEX } from './hersheyDataTriplex';
import { HERSHEY_SCRIPT } from './hersheyDataScript';
import { HERSHEY_GOTHIC_ENGLISH } from './hersheyDataGothicEnglish';

/** The names a `TextEntity.font` carries to ask for strokes rather than a system font. */
export const STROKE_FONT = 'Single-stroke';
export const STROKE_FONT_DUPLEX = 'Single-stroke Duplex';
export const STROKE_FONT_TRIPLEX = 'Single-stroke Triplex';
export const STROKE_FONT_SCRIPT = 'Single-stroke Script';
export const STROKE_FONT_GOTHIC = 'Single-stroke Gothic';

/** One Hershey glyph table per stroke font — all four are more of the same
 *  public-domain collection the original Simplex table came from, so they
 *  share the exact same .jhf layout and the parser below needs no per-font
 *  special-casing. */
const STROKE_FONT_DATA: Record<string, readonly string[]> = {
  [STROKE_FONT]: HERSHEY_SIMPLEX,
  [STROKE_FONT_DUPLEX]: HERSHEY_DUPLEX,
  [STROKE_FONT_TRIPLEX]: HERSHEY_TRIPLEX,
  [STROKE_FONT_SCRIPT]: HERSHEY_SCRIPT,
  [STROKE_FONT_GOTHIC]: HERSHEY_GOTHIC_ENGLISH,
};

/** Every font name that means "plot as strokes", for the UI's font list. */
export const STROKE_FONTS: readonly string[] = Object.keys(STROKE_FONT_DATA);

export function isStrokeFont(font: string | undefined): boolean {
  return font !== undefined && font in STROKE_FONT_DATA;
}

interface Glyph {
  /** Pen-down runs, in font units, with y already pointing up. */
  strokes: Vec2[][];
  /** How far the pen moves along the line before the next glyph. */
  advance: number;
}

/**
 * Hershey coordinates are offsets from the character 'R', and y grows
 * *downwards* — the font predates the convention. The baseline is not at zero
 * either: it sits at 9, with capitals reaching −12 above it and descenders 16
 * below. So a glyph is flipped and shifted to put the baseline on y = 0, which
 * leaves a capital exactly 21 units tall — the number that turns the entity's
 * height in millimetres into a scale. Every stroke font here shares this
 * layout, since they are all the same .jhf convention.
 */
const ORIGIN = 'R'.charCodeAt(0);
const BASELINE = 9;
const CAP_HEIGHT = 21;

const glyphCaches = new Map<string, Map<number, Glyph>>();

function glyphFor(font: string, code: number): Glyph | null {
  let cache = glyphCaches.get(font);
  if (!cache) { cache = new Map(); glyphCaches.set(font, cache); }
  const cached = cache.get(code);
  if (cached) return cached;

  // The data runs from space (32) to 127, and anything outside it has no
  // drawing — better a gap you can see than a wrong letter.
  const table = STROKE_FONT_DATA[font] ?? HERSHEY_SIMPLEX;
  const line = table[code - 32];
  if (line === undefined) return null;

  const left = line.charCodeAt(8) - ORIGIN;
  const right = line.charCodeAt(9) - ORIGIN;
  const strokes: Vec2[][] = [];
  let current: Vec2[] = [];
  for (let index = 10; index + 1 < line.length; index += 2) {
    if (line[index] === ' ' && line[index + 1] === 'R') {
      // Pen up: the run ends and the next one starts somewhere else.
      if (current.length > 0) strokes.push(current);
      current = [];
      continue;
    }
    current.push({
      x: line.charCodeAt(index) - ORIGIN - left,
      y: BASELINE - (line.charCodeAt(index + 1) - ORIGIN),
    });
  }
  if (current.length > 0) strokes.push(current);

  const glyph: Glyph = { strokes, advance: right - left };
  cache.set(code, glyph);
  return glyph;
}

export interface StrokeTextOptions {
  position: Vec2;
  /** Cap height in millimetres — what `TextEntity.height` means. */
  height: number;
  rotation?: number;
  /** Which stroke font to draw with; defaults to the original Simplex. */
  font?: string;
}

/** Baseline-to-baseline distance as a multiple of cap height — AutoCAD's MTEXT
    default line-spacing factor, close enough for a plotter's stroke font. */
export const DEFAULT_LINE_SPACING = 5 / 3;

/**
 * The polylines that draw `text`, in the entity's own plane coordinates.
 * `\n` starts a new line below the previous one's baseline; everything else
 * about a multi-line MTEXT (paragraph text) is one call, same as a single
 * line of TEXT — a plotter draws both the same way.
 *
 * Empty for text made only of characters the font has no drawing for, which is
 * a thing the caller should say rather than pass over.
 */
export function strokeText(text: string, options: StrokeTextOptions): Vec2[][] {
  const font = options.font ?? STROKE_FONT;
  const scale = options.height / CAP_HEIGHT;
  const cos = Math.cos(options.rotation ?? 0);
  const sin = Math.sin(options.rotation ?? 0);
  const lineHeight = options.height * DEFAULT_LINE_SPACING;
  const paths: Vec2[][] = [];

  text.split('\n').forEach((line, lineIndex) => {
    let pen = 0;
    const lineY = -lineIndex * lineHeight;
    for (const character of line) {
      const code = character.codePointAt(0) ?? 32;
      const glyph = glyphFor(font, code);
      if (!glyph) continue;
      for (const stroke of glyph.strokes) {
        paths.push(stroke.map((point) => {
          const x = (point.x + pen) * scale;
          const y = point.y * scale + lineY;
          return {
            x: options.position.x + x * cos - y * sin,
            y: options.position.y + x * sin + y * cos,
          };
        }));
      }
      pen += glyph.advance;
    }
  });
  return paths;
}

/** How wide the widest line will be, without drawing it — for bounds and picking. */
export function strokeTextWidth(text: string, height: number, font: string = STROKE_FONT): number {
  const scale = height / CAP_HEIGHT;
  let widest = 0;
  for (const line of text.split('\n')) {
    let pen = 0;
    for (const character of line) {
      const glyph = glyphFor(font, character.codePointAt(0) ?? 32);
      if (glyph) pen += glyph.advance;
    }
    widest = Math.max(widest, pen * scale);
  }
  return widest;
}

/** How tall the whole (possibly multi-line) block stands, baseline of the
    first line to the bottom of the last — for bounds and picking. Font-
    independent: every stroke font here shares the same cap-height convention. */
export function strokeTextHeight(text: string, height: number): number {
  const lines = text.split('\n').length;
  return height + (lines - 1) * height * DEFAULT_LINE_SPACING;
}
