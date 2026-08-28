import type { Document } from '../core/Document';
import type { Entity } from '../core/entities/types';
import { curvePoints, dimensionGeometry, expandedInsertEntities } from '../core/entities/types';
import { DEFAULT_LINE_TYPE, DEFAULT_LINE_WEIGHT_MM, lineTypeDashArray } from '../core/lineStyles';
import { hatchPatternSegments } from '../io/DxfHatch';
import { DEFAULT_LINE_SPACING, isStrokeFont, strokeText } from '../core/text/strokeFont';
import type { Vec2 } from '../math/geometry';
import { worldToScreen } from '../math/geometry';

export interface PrintWindow { min: Vec2; max: Vec2 }
export interface PrintPage { widthMm: number; heightMm: number }

/** ISO 216 portrait dimensions, matching the named sizes Electron's
    printToPDF accepts so the SVG content and the physical page it is
    printed onto always agree. */
export const PAPER_SIZES_MM: Record<string, { widthMm: number; heightMm: number }> = {
  A0: { widthMm: 841, heightMm: 1189 },
  A1: { widthMm: 594, heightMm: 841 },
  A2: { widthMm: 420, heightMm: 594 },
  A3: { widthMm: 297, heightMm: 420 },
  A4: { widthMm: 210, heightMm: 297 },
};

export function paperPage(paper: string, landscape: boolean): PrintPage {
  const size = PAPER_SIZES_MM[paper] ?? PAPER_SIZES_MM.A4;
  return landscape ? { widthMm: size.heightMm, heightMm: size.widthMm } : { widthMm: size.widthMm, heightMm: size.heightMm };
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (n: number): string => n.toFixed(3);
const colorHex = (c: number): string => `#${(c >>> 0).toString(16).padStart(6, '0')}`;

export type PrintColorMode = 'color' | 'grayscale' | 'black';

export interface PrintStyle {
  colorMode: PrintColorMode;
  /** Off prints every object at the same hairline width, ignoring per-layer
      lineweight — AutoCAD's "plot object lineweights" checkbox. */
  keepLineweights: boolean;
}

export const DEFAULT_PRINT_STYLE: PrintStyle = { colorMode: 'color', keepLineweights: true };

/**
 * A drawing meant for the app's dark canvas routinely uses pure white for
 * what is meant to read as "ink" — on white paper that is invisible, so it
 * always prints as black regardless of colour mode. Grayscale otherwise
 * follows perceptual luminance; black mode ignores colour entirely.
 */
function printColorHex(color: number, mode: PrintColorMode): string {
  const r = (color >>> 16) & 0xff, g = (color >>> 8) & 0xff, b = color & 0xff;
  if (mode === 'black' || (r === 0xff && g === 0xff && b === 0xff)) return '#000000';
  if (mode === 'color') return colorHex(color);
  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  return colorHex((gray << 16) | (gray << 8) | gray);
}

/**
 * A print is a physical plot: line *weight* is a real pen/output width in mm
 * and stays fixed regardless of how far the window is zoomed to fit the page
 * (unlike the on-screen renderer, which pins it to a screen pixel for
 * legibility — see lineWeightToPixels). Only lengths measured in the drawing
 * — geometry, dash patterns — shrink by the fit scale.
 */
export function buildPrintSvg(doc: Document, win: PrintWindow, page: PrintPage, style: PrintStyle = DEFAULT_PRINT_STYLE): string {
  const winW = Math.max(1e-9, win.max.x - win.min.x);
  const winH = Math.max(1e-9, win.max.y - win.min.y);
  const scale = Math.min(page.widthMm / winW, page.heightMm / winH);
  const pan: Vec2 = { x: (win.min.x + win.max.x) / 2, y: (win.min.y + win.max.y) / 2 };
  const toPage = (p: Vec2): Vec2 => worldToScreen(p, page.widthMm, page.heightMm, pan, scale);

  const parts: string[] = [];

  const strokeAttrs = (entity: Entity): string => {
    const weightMm = style.keepLineweights ? (doc.layerLineweight[entity.layer] ?? DEFAULT_LINE_WEIGHT_MM) : DEFAULT_LINE_WEIGHT_MM;
    const dash = lineTypeDashArray(doc.layerLinetype[entity.layer] ?? DEFAULT_LINE_TYPE, scale);
    const dashAttr = dash.length ? ` stroke-dasharray="${dash.map(fmt).join(',')}"` : '';
    return `stroke="${printColorHex(entity.color, style.colorMode)}" stroke-width="${fmt(weightMm)}" fill="none"${dashAttr}`;
  };

  const pathFromPoints = (points: Vec2[], closed: boolean): string => {
    if (points.length < 2) return '';
    const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(toPage(p).x)},${fmt(toPage(p).y)}`).join(' ') + (closed ? ' Z' : '');
    return d;
  };

  const drawPolyline = (entity: Entity, points: Vec2[], closed: boolean): void => {
    const d = pathFromPoints(points, closed);
    if (d) parts.push(`<path d="${d}" ${strokeAttrs(entity)}/>`);
  };

  const drawEntity = (entity: Entity): void => {
    switch (entity.type) {
      case 'point': {
        const p = toPage(entity.position);
        const arm = 1;
        parts.push(`<path d="M${fmt(p.x - arm)},${fmt(p.y)} L${fmt(p.x + arm)},${fmt(p.y)} M${fmt(p.x)},${fmt(p.y - arm)} L${fmt(p.x)},${fmt(p.y + arm)}" ${strokeAttrs(entity)}/>`);
        break;
      }
      case 'line':
        drawPolyline(entity, [entity.start, entity.end], false);
        break;
      case 'hatch': {
        if (entity.pattern === 'solid') {
          const d = entity.loops.map((loop) => pathFromPoints(loop, true)).filter(Boolean).join(' ');
          if (d) parts.push(`<path d="${d}" fill="${printColorHex(entity.color, style.colorMode)}" fill-opacity="0.3" fill-rule="evenodd" stroke="none"/>`);
        } else {
          const segments = hatchPatternSegments(entity.loops, entity.patternLines);
          if (segments.length) {
            const d = segments.map(([a, b]) => `M${fmt(toPage(a).x)},${fmt(toPage(a).y)} L${fmt(toPage(b).x)},${fmt(toPage(b).y)}`).join(' ');
            parts.push(`<path d="${d}" ${strokeAttrs(entity)}/>`);
          }
        }
        break;
      }
      case 'circle': {
        const c = toPage(entity.center);
        parts.push(`<circle cx="${fmt(c.x)}" cy="${fmt(c.y)}" r="${fmt(entity.radius * scale)}" ${strokeAttrs(entity)}/>`);
        break;
      }
      case 'ellipse': {
        const c = toPage(entity.center);
        // Page Y grows downward like screen Y, so the rotation flips with it.
        const deg = (-entity.rotation * 180) / Math.PI;
        parts.push(`<ellipse cx="${fmt(c.x)}" cy="${fmt(c.y)}" rx="${fmt(entity.radiusX * scale)}" ry="${fmt(entity.radiusY * scale)}" transform="rotate(${fmt(deg)} ${fmt(c.x)} ${fmt(c.y)})" ${strokeAttrs(entity)}/>`);
        break;
      }
      case 'rectangle': {
        // first/opposite are page-space already; drawPolyline would re-project
        // them, so build the path directly from these four page corners.
        const a = toPage(entity.first), b = toPage(entity.opposite);
        const d = `M${fmt(a.x)},${fmt(a.y)} L${fmt(b.x)},${fmt(a.y)} L${fmt(b.x)},${fmt(b.y)} L${fmt(a.x)},${fmt(b.y)} Z`;
        parts.push(`<path d="${d}" ${strokeAttrs(entity)}/>`);
        break;
      }
      case 'octagon':
        drawPolyline(entity, entity.vertices, true);
        break;
      case 'polyline':
        drawPolyline(entity, entity.vertices, entity.closed);
        break;
      case 'arc':
        drawPolyline(entity, curvePoints(entity), false);
        break;
      case 'bezier': {
        const start = toPage(entity.start);
        const curves = entity.segments.map((segment) => {
          const c1 = toPage(segment.control1), c2 = toPage(segment.control2), end = toPage(segment.end);
          return `C${fmt(c1.x)},${fmt(c1.y)} ${fmt(c2.x)},${fmt(c2.y)} ${fmt(end.x)},${fmt(end.y)}`;
        });
        parts.push(`<path d="M${fmt(start.x)},${fmt(start.y)} ${curves.join(' ')}" ${strokeAttrs(entity)}/>`);
        break;
      }
      case 'text': {
        if (isStrokeFont(entity.font)) {
          for (const stroke of strokeText(entity.text, { position: entity.position, height: entity.height, rotation: entity.rotation, font: entity.font })) {
            drawPolyline(entity, stroke, false);
          }
          break;
        }
        const p = toPage(entity.position);
        const deg = (-(entity.rotation ?? 0) * 180) / Math.PI;
        const heightMm = Math.max(0.1, entity.height * scale);
        const lineStepMm = heightMm * DEFAULT_LINE_SPACING;
        const fontAttrs = `font-family="${esc(entity.font ?? 'Arial')}" font-size="${fmt(heightMm)}" fill="${printColorHex(entity.color, style.colorMode)}"`;
        // Every line rotates rigidly around the first line's anchor, same as
        // the stroke font and the canvas renderer, rather than each around
        // its own (would tilt each line off the last instead of as a block).
        entity.text.split('\n').forEach((line, index) => {
          const y = p.y + index * lineStepMm;
          parts.push(`<text x="${fmt(p.x)}" y="${fmt(y)}" transform="rotate(${fmt(deg)} ${fmt(p.x)} ${fmt(p.y)})" ${fontAttrs}>${esc(line)}</text>`);
        });
        break;
      }
      case 'dimension': {
        const geometry = dimensionGeometry(entity);
        drawPolyline(entity, geometry.extensionStart, false);
        drawPolyline(entity, geometry.extensionEnd, false);
        drawPolyline(entity, geometry.dimensionLine, false);
        for (const arrow of geometry.arrows) {
          const points = arrow.map(toPage);
          if (entity.arrowType === 'tick') {
            parts.push(`<path d="M${fmt(points[1].x)},${fmt(points[1].y)} L${fmt(points[2].x)},${fmt(points[2].y)}" ${strokeAttrs(entity)}/>`);
          } else if (entity.arrowType === 'closed') {
            const d = `M${fmt(points[0].x)},${fmt(points[0].y)} L${fmt(points[1].x)},${fmt(points[1].y)} L${fmt(points[2].x)},${fmt(points[2].y)} Z`;
            parts.push(`<path d="${d}" fill="${printColorHex(entity.color, style.colorMode)}" stroke="none"/>`);
          } else {
            const d = `M${fmt(points[0].x)},${fmt(points[0].y)} L${fmt(points[1].x)},${fmt(points[1].y)} M${fmt(points[0].x)},${fmt(points[0].y)} L${fmt(points[2].x)},${fmt(points[2].y)}`;
            parts.push(`<path d="${d}" ${strokeAttrs(entity)}/>`);
          }
        }
        const textPoint = toPage(geometry.textPoint);
        const deg = (-geometry.textAngle * 180) / Math.PI;
        const heightMm = Math.max(0.1, entity.textHeight * entity.scale * scale);
        parts.push(`<text x="${fmt(textPoint.x)}" y="${fmt(textPoint.y)}" transform="rotate(${fmt(deg)} ${fmt(textPoint.x)} ${fmt(textPoint.y)})" text-anchor="middle" dominant-baseline="middle" font-family="Arial" font-size="${fmt(heightMm)}" fill="${printColorHex(entity.color, style.colorMode)}">${esc(geometry.text)}</text>`);
        break;
      }
      case 'insert':
        // 3D bodies inside an INSERT (expandedInsertSolids) are not part of
        // this 2D plot — a print is the same flattened view as the 2D canvas.
        expandedInsertEntities(entity).forEach(drawEntity);
        break;
    }
  };

  for (const entity of doc.entities) {
    if (doc.hiddenLayers.has(entity.layer) || doc.hiddenObjects.has(entity.id)) continue;
    drawEntity(entity);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(page.widthMm)}mm" height="${fmt(page.heightMm)}mm" viewBox="0 0 ${fmt(page.widthMm)} ${fmt(page.heightMm)}">`
    + `<rect x="0" y="0" width="${fmt(page.widthMm)}" height="${fmt(page.heightMm)}" fill="#ffffff"/>`
    + parts.join('')
    + `</svg>`;
}
