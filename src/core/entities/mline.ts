/**
 * MLINE's own geometry: turning one stored centerline plus a resolved list of
 * parallel `MlineElement`s into the actual offset lines to draw, pick or
 * export — computed on demand, never cached on the entity, the same way a
 * plain polyline stores no derived geometry either.
 */
import { closePolyline, dist2, type Vec2 } from '../../math/geometry';
import { offsetOpenPolyline, offsetPolygon } from '../commands/steps/edit2d';
import type { MlineElement, MlineEntity } from './types';

/** Drops a closed shape's repeated closing vertex — `offsetPolygon` wraps
 *  around on its own and would otherwise see a degenerate zero-length edge. */
function openVertices(entity: MlineEntity): Vec2[] {
  const { vertices } = entity;
  return entity.closed && vertices.length > 1 && dist2(vertices[0], vertices.at(-1)!) < 1e-9
    ? vertices.slice(0, -1)
    : vertices;
}

function offsetLine(vertices: Vec2[], distance: number, closed: boolean): Vec2[] | null {
  if (Math.abs(distance) < 1e-9) return vertices.map((point) => ({ ...point }));
  return closed ? offsetPolygon(vertices, distance) : offsetOpenPolyline(vertices, distance);
}

/**
 * Shifts the centerline sideways before any element is offset against it —
 * AutoCAD's MLINE justification. `top`/`bottom` line the drawn point sequence
 * up with whichever element sits furthest to that side, `zero` (the default)
 * leaves it alone.
 */
function justifiedCenterline(vertices: Vec2[], elements: MlineElement[], justification: MlineEntity['justification'], closed: boolean): Vec2[] {
  if (justification === 'zero' || elements.length === 0) return vertices;
  const offsets = elements.map((element) => element.offset);
  const shift = justification === 'top' ? -Math.max(...offsets) : -Math.min(...offsets);
  return offsetLine(vertices, shift, closed) ?? vertices;
}

/** One offset polyline per style element, in `entity.elements` order — the
 *  parallel lines an MLINE actually draws. A degenerate element (offset
 *  math fails on a too-short or doubled-back centerline) falls back to the
 *  justified centerline itself rather than vanishing outright. */
export function mlineOffsetLines(entity: MlineEntity): Vec2[][] {
  const base = justifiedCenterline(openVertices(entity), entity.elements, entity.justification, entity.closed);
  return entity.elements.map((element) => {
    const line = offsetLine(base, element.offset, entity.closed) ?? base;
    return entity.closed && line.length > 1 ? closePolyline(line) : line;
  });
}
