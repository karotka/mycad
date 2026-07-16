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

/** The name a `TextEntity.font` carries to ask for strokes rather than a system font. */
export const STROKE_FONT = 'Single-stroke';

export function isStrokeFont(font: string | undefined): boolean {
  return font === STROKE_FONT;
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
 * height in millimetres into a scale.
 */
const ORIGIN = 'R'.charCodeAt(0);
const BASELINE = 9;
const CAP_HEIGHT = 21;

const glyphs = new Map<number, Glyph>();

function glyphFor(code: number): Glyph | null {
  const cached = glyphs.get(code);
  if (cached) return cached;
  // The data runs from space (32) to 127, and anything outside it has no
  // drawing — better a gap you can see than a wrong letter.
  const line = HERSHEY_SIMPLEX[code - 32];
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
  glyphs.set(code, glyph);
  return glyph;
}

export interface StrokeTextOptions {
  position: Vec2;
  /** Cap height in millimetres — what `TextEntity.height` means. */
  height: number;
  rotation?: number;
}

/**
 * The polylines that draw `text`, in the entity's own plane coordinates.
 *
 * Empty for text made only of characters the font has no drawing for, which is
 * a thing the caller should say rather than pass over.
 */
export function strokeText(text: string, options: StrokeTextOptions): Vec2[][] {
  const scale = options.height / CAP_HEIGHT;
  const cos = Math.cos(options.rotation ?? 0);
  const sin = Math.sin(options.rotation ?? 0);
  const paths: Vec2[][] = [];
  let pen = 0;

  for (const character of text) {
    const code = character.codePointAt(0) ?? 32;
    const glyph = glyphFor(code);
    if (!glyph) continue;
    for (const stroke of glyph.strokes) {
      paths.push(stroke.map((point) => {
        const x = (point.x + pen) * scale;
        const y = point.y * scale;
        return {
          x: options.position.x + x * cos - y * sin,
          y: options.position.y + x * sin + y * cos,
        };
      }));
    }
    pen += glyph.advance;
  }
  return paths;
}

/** How wide the text will be, without drawing it — for bounds and picking. */
export function strokeTextWidth(text: string, height: number): number {
  let pen = 0;
  for (const character of text) {
    const glyph = glyphFor(character.codePointAt(0) ?? 32);
    if (glyph) pen += glyph.advance;
  }
  return pen * (height / CAP_HEIGHT);
}
