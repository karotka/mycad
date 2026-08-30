/**
 * Vector geometry out of a PDF page — lines, curves and text as real CAD
 * entities, not a rasterised snapshot of one.
 *
 * pdf.js hands back a page's drawing instructions two ways: `getOperatorList`
 * for paths (already decoded past PDF's own compression and content-stream
 * syntax, straight into paint/transform/path-construction calls) and
 * `getTextContent` for text (already decoded past font encoding into plain
 * strings). Everything here is walking those two lists, not parsing PDF
 * itself — that part is exactly the years of edge cases a PDF library exists
 * to have already handled.
 */
import type { Document } from '../core/Document';
import type { BezierSegment, Entity } from '../core/entities/types';
import type { Vec2 } from '../math/geometry';
// A plain asset URL, not the worker module itself — pdf.js refuses to parse
// anything until this is set, since (unlike Node) a real browser Worker is
// available and it insists on using one.
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

/** 1 PDF user-space unit is 1/72 inch. */
const PDF_POINTS_TO_MM = 25.4 / 72;

/** A 2D affine transform in PDF's own [a, b, c, d, e, f] convention:
 *  x' = a·x + c·y + e,  y' = b·x + d·y + f. */
type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** The matrix equivalent to applying `inner` first, then `outer` — how a
 *  nested `q ... cm ... Q` block's local frame composes with the one it sits
 *  inside of. */
function composeMatrix(outer: Matrix, inner: Matrix): Matrix {
  return [
    inner[0] * outer[0] + inner[1] * outer[2],
    inner[0] * outer[1] + inner[1] * outer[3],
    inner[2] * outer[0] + inner[3] * outer[2],
    inner[2] * outer[1] + inner[3] * outer[3],
    inner[4] * outer[0] + inner[5] * outer[2] + outer[4],
    inner[4] * outer[1] + inner[5] * outer[3] + outer[5],
  ];
}

function applyMatrix(m: Matrix, x: number, y: number): Vec2 {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/**
 * pdf.js's own internal encoding for one path's construction ops, read off
 * its `constructPath` operator's second argument: a flat buffer of
 * `[miniOpcode, ...coordinates]` runs. Not part of its public API — verified
 * against the installed version's source (`src/display/canvas.js`,
 * `makePathFromDrawOPS`) rather than guessed, since pdf.js doesn't export it.
 */
const DRAW_MOVE_TO = 0;
const DRAW_LINE_TO = 1;
const DRAW_CURVE_TO = 2;
const DRAW_QUADRATIC_CURVE_TO = 3;
const DRAW_CLOSE_PATH = 4;

type PdfPathSegment =
  | { kind: 'line'; end: Vec2 }
  | { kind: 'cubic'; control1: Vec2; control2: Vec2; end: Vec2 };

interface PdfSubpath {
  start: Vec2;
  segments: PdfPathSegment[];
  closed: boolean;
}

/** Every subpath drawn by one `constructPath` call, already in the caller's
 *  target coordinate space (`project` folds in both the current transform
 *  and the PDF-points-to-mm conversion). A degenerate `v`/`y` curve — PDF's
 *  shorthand for a cubic with one control point implied — arrives from
 *  pdf.js already collapsed to a quadratic; degree-elevating that quadratic
 *  back to an exactly equivalent cubic keeps the imported curve identical to
 *  what the PDF actually draws, at the cost of not knowing which of the two
 *  shorthand forms it originally was (invisible either way). */
function extractSubpaths(data: readonly number[], project: (x: number, y: number) => Vec2): PdfSubpath[] {
  const subpaths: PdfSubpath[] = [];
  let current: PdfSubpath | null = null;
  let currentPoint: Vec2 = { x: 0, y: 0 };
  let subpathStart: Vec2 = { x: 0, y: 0 };
  let i = 0;
  while (i < data.length) {
    const op = data[i++];
    if (op === DRAW_MOVE_TO) {
      const point = project(data[i], data[i + 1]); i += 2;
      current = { start: point, segments: [], closed: false };
      subpaths.push(current);
      currentPoint = point; subpathStart = point;
    } else if (op === DRAW_LINE_TO) {
      const point = project(data[i], data[i + 1]); i += 2;
      current?.segments.push({ kind: 'line', end: point });
      currentPoint = point;
    } else if (op === DRAW_CURVE_TO) {
      const control1 = project(data[i], data[i + 1]);
      const control2 = project(data[i + 2], data[i + 3]);
      const end = project(data[i + 4], data[i + 5]);
      i += 6;
      current?.segments.push({ kind: 'cubic', control1, control2, end });
      currentPoint = end;
    } else if (op === DRAW_QUADRATIC_CURVE_TO) {
      const q = project(data[i], data[i + 1]);
      const end = project(data[i + 2], data[i + 3]);
      i += 4;
      current?.segments.push({
        kind: 'cubic',
        control1: { x: currentPoint.x + (2 / 3) * (q.x - currentPoint.x), y: currentPoint.y + (2 / 3) * (q.y - currentPoint.y) },
        control2: { x: end.x + (2 / 3) * (q.x - end.x), y: end.y + (2 / 3) * (q.y - end.y) },
        end,
      });
      currentPoint = end;
    } else if (op === DRAW_CLOSE_PATH) {
      if (current) current.closed = true;
      currentPoint = subpathStart;
    } else {
      break; // An opcode outside the five above means this buffer isn't what we think it is.
    }
  }
  return subpaths;
}

/** A subpath as one CAD entity: a straight two-point open one is a LINE, any
 *  other all-straight one a POLYLINE, and anything with a curve in it a
 *  Bezier chain — a straight span inside an otherwise-curved subpath becomes
 *  a degenerate cubic (control points on its own endpoints), the same
 *  convention JOIN already uses for a mixed line-and-curve chain. */
function subpathToEntity(doc: Document, subpath: PdfSubpath): Entity | null {
  if (subpath.segments.length === 0) return null;
  const hasCurve = subpath.segments.some((segment) => segment.kind === 'cubic');
  if (!hasCurve) {
    const vertices = [subpath.start, ...subpath.segments.map((segment) => segment.end)];
    if (vertices.length === 2 && !subpath.closed) return doc.createLine(vertices[0], vertices[1]);
    return doc.createPolyline(vertices, subpath.closed);
  }
  let previous = subpath.start;
  const segments: BezierSegment[] = subpath.segments.map((segment) => {
    const built: BezierSegment = segment.kind === 'cubic'
      ? { control1: segment.control1, control2: segment.control2, end: segment.end }
      : { control1: previous, control2: segment.end, end: segment.end };
    previous = segment.end;
    return built;
  });
  if (subpath.closed && Math.hypot(previous.x - subpath.start.x, previous.y - subpath.start.y) > 1e-9) {
    segments.push({ control1: previous, control2: subpath.start, end: subpath.start });
  }
  return doc.createSpline(subpath.start, segments);
}

export interface PdfImportResult {
  entities: Entity[];
  /** More than 1 if the file had further pages — only the first is imported. */
  pageCount: number;
  skippedImages: number;
  skippedShading: number;
}

/**
 * Imports the first page of a PDF as real vector entities: every stroked or
 * filled path as a line, polyline or Bezier chain, every text run as a TEXT
 * entity at its own position (its exact font isn't matched — this reads the
 * string and its size, not its glyph outlines). Raster images and gradient
 * fills carry no CAD-meaningful geometry and are counted, not imported.
 */
export async function importPdfEntities(doc: Document, bytes: Uint8Array): Promise<PdfImportResult> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // A real browser Worker exists in the renderer, and pdf.js insists on one
  // there — Node (this module's own tests) has none, and the ?url import
  // above resolves to a path only a running app's asset server can serve, so
  // it must stay unset there for pdf.js's same-thread fallback to kick in.
  // Checked via `Worker` itself, not `window` — a test stubbing a bare
  // `window` object for unrelated reasons must not look like a browser here.
  if (typeof Worker !== 'undefined') pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = pdfjsLib.getDocument({ data: bytes, verbosity: 0 });
  const pdf = await loadingTask.promise;
  try {
    const page = await pdf.getPage(1);
    // The page's own box, not always [0,0,...] — an import should land near
    // MyCAD's origin regardless of where the PDF places its page.
    const [originX, originY] = page.view;
    const toMm = (point: Vec2): Vec2 => ({
      x: (point.x - originX) * PDF_POINTS_TO_MM,
      y: (point.y - originY) * PDF_POINTS_TO_MM,
    });

    const entities: Entity[] = [];
    let skippedImages = 0;
    let skippedShading = 0;
    const OPS = pdfjsLib.OPS;
    const opList = await page.getOperatorList();
    const ctmStack: Matrix[] = [];
    let ctm: Matrix = IDENTITY;
    for (let index = 0; index < opList.fnArray.length; index++) {
      const fn = opList.fnArray[index];
      const args = opList.argsArray[index];
      if (fn === OPS.save) {
        ctmStack.push(ctm);
      } else if (fn === OPS.restore) {
        ctm = ctmStack.pop() ?? IDENTITY;
      } else if (fn === OPS.transform) {
        ctm = composeMatrix(ctm, Array.from(args as ArrayLike<number>) as unknown as Matrix);
      } else if (fn === OPS.constructPath) {
        // args is [paintOp, data, minMax], and pdf.js's own constructPath
        // handler destructures the raw coordinate buffer as `[path] = data`
        // — it is wrapped one level deeper than the rest of the operator
        // list's argument arrays.
        const [rawPath] = args[1] as [ArrayLike<number>];
        const data = Array.from(rawPath);
        const project = (x: number, y: number): Vec2 => toMm(applyMatrix(ctm, x, y));
        for (const subpath of extractSubpaths(data, project)) {
          const entity = subpathToEntity(doc, subpath);
          if (entity) entities.push(entity);
        }
      } else if (
        fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject
        || fn === OPS.paintImageMaskXObject || fn === OPS.paintSolidColorImageMask
      ) {
        skippedImages++;
      } else if (fn === OPS.shadingFill) {
        skippedShading++;
      }
    }

    const textContent = await page.getTextContent();
    for (const item of textContent.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const position = toMm({ x: item.transform[4], y: item.transform[5] });
      const height = Math.abs(item.height) * PDF_POINTS_TO_MM;
      entities.push(doc.createText(position, item.str, height > 0.01 ? height : 2.5));
    }

    return { entities, pageCount: pdf.numPages, skippedImages, skippedShading };
  } finally {
    await loadingTask.destroy();
  }
}
