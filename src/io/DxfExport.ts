import type { Document } from '../core/Document';
import { dimensionGeometry, type DimensionEntity, type EllipseEntity, type Entity } from '../core/entities/types';
import type { Vec2 } from '../math/geometry';
import { ACI_BYLAYER } from './DxfAci';
import { DEFAULT_LINE_TYPE, DEFAULT_LINE_WEIGHT_MM, LINE_TYPES } from '../core/lineStyles';

export interface DxfExportResult {
  dxf: string;
  /** Objects written, dimensions counted once even though they explode to many. */
  entityCount: number;
  /** Dimensions turned into plain lines and text, since a DXF dimension needs a block. */
  dimensionsDecomposed: number;
}

/**
 * Writes the drawing as an ASCII DXF (R2000 flavour): a HEADER naming the units,
 * a TABLES section defining the line types and layers, and an ENTITIES section
 * with one record per object. Nine of the ten entity kinds map to a native DXF
 * entity; a dimension has no self-contained form, so it is exploded into the
 * lines, arrowheads and text it draws.
 *
 * The file round-trips through this project's own importer, and reads in the
 * common CAD tools (LibreCAD, plotters) that a 2D export is for.
 */
export function exportAsciiDxf(doc: Document): DxfExportResult {
  const out: string[] = [];
  const pair = (code: number, value: string | number): void => { out.push(String(code), String(value)); };

  const layers = doc.layers.length > 0 ? doc.layers : ['0'];
  // Every line type any layer names, plus Continuous — the TABLES section must
  // define one before a layer may refer to it.
  const usedLinetypes = new Set<string>([DEFAULT_LINE_TYPE]);
  for (const layer of layers) usedLinetypes.add(doc.layerLinetype[layer] ?? DEFAULT_LINE_TYPE);

  writeHeader(pair);
  writeTables(pair, doc, layers, [...usedLinetypes]);

  pair(0, 'SECTION');
  pair(2, 'ENTITIES');
  let entityCount = 0;
  let dimensionsDecomposed = 0;
  for (const entity of doc.entities) {
    if (entity.type === 'dimension') dimensionsDecomposed++;
    writeEntity(pair, entity);
    entityCount++;
  }
  pair(0, 'ENDSEC');
  pair(0, 'EOF');

  return { dxf: out.join('\n') + '\n', entityCount, dimensionsDecomposed };
}

type Pair = (code: number, value: string | number) => void;

function writeHeader(pair: Pair): void {
  pair(0, 'SECTION');
  pair(2, 'HEADER');
  pair(9, '$ACADVER');
  pair(1, 'AC1015');
  // 4 is millimetres; the importer keys its unit scale off this variable.
  pair(9, '$INSUNITS');
  pair(70, 4);
  pair(0, 'ENDSEC');
}

function writeTables(pair: Pair, doc: Document, layers: string[], linetypes: string[]): void {
  pair(0, 'SECTION');
  pair(2, 'TABLES');

  // Line types. ByBlock and ByLayer are expected first; then a real definition
  // for each pattern, its dashes written as signed lengths (positive drawn,
  // negative gap) exactly as DXF wants them.
  pair(0, 'TABLE');
  pair(2, 'LTYPE');
  pair(70, linetypes.length + 2);
  writeLinetype(pair, 'ByBlock', []);
  writeLinetype(pair, 'ByLayer', []);
  for (const name of linetypes) writeLinetype(pair, name, LINE_TYPES[name] ?? []);
  pair(0, 'ENDTAB');

  pair(0, 'TABLE');
  pair(2, 'LAYER');
  pair(70, layers.length);
  for (const name of layers) {
    const aci = doc.layerAci[name] ?? 7;
    pair(0, 'LAYER');
    pair(2, name);
    pair(70, 0);
    // A layer that is off is written with a negative colour, the DXF convention
    // the importer already reads back.
    pair(62, doc.hiddenLayers.has(name) ? -Math.abs(aci) : aci);
    pair(6, doc.layerLinetype[name] ?? DEFAULT_LINE_TYPE);
    // Lineweight is an integer count of 1/100 mm — 0.25 mm is 25.
    pair(370, Math.round((doc.layerLineweight[name] ?? DEFAULT_LINE_WEIGHT_MM) * 100));
  }
  pair(0, 'ENDTAB');

  pair(0, 'ENDSEC');
}

function writeLinetype(pair: Pair, name: string, pattern: readonly number[]): void {
  pair(0, 'LTYPE');
  pair(2, name);
  pair(70, 0);
  pair(3, describeLinetype(name, pattern));
  pair(72, 65); // 'A', the only alignment DXF defines
  pair(73, pattern.length);
  pair(40, patternLength(pattern));
  // Even elements are drawn, odd are gaps; a gap is a negative length.
  pattern.forEach((element, index) => {
    pair(49, index % 2 === 0 ? element : -element);
    pair(74, 0);
  });
}

function describeLinetype(name: string, pattern: readonly number[]): string {
  if (pattern.length === 0) return name === 'Continuous' ? 'Solid line' : name;
  // A rough ASCII picture, which is what the field is for.
  return pattern.map((element, index) => (index % 2 === 0 ? '_'.repeat(Math.max(1, Math.round(element / 3))) : ' ')).join('');
}

function patternLength(pattern: readonly number[]): number {
  return pattern.reduce((total, element) => total + element, 0);
}

function writeEntity(pair: Pair, entity: Entity): void {
  switch (entity.type) {
    case 'line':
      start(pair, 'LINE', entity);
      point(pair, 10, 20, entity.start);
      point(pair, 11, 21, entity.end);
      break;
    case 'circle':
      start(pair, 'CIRCLE', entity);
      point(pair, 10, 20, entity.center);
      pair(40, num(entity.radius));
      break;
    case 'arc': {
      start(pair, 'ARC', entity);
      point(pair, 10, 20, entity.center);
      pair(40, num(entity.radius));
      pair(50, num(degrees(entity.startAngle)));
      pair(51, num(degrees(entity.startAngle + entity.sweepAngle)));
      break;
    }
    case 'ellipse':
      writeEllipse(pair, entity);
      break;
    case 'rectangle':
      writePolyline(pair, entity, [
        entity.first,
        { x: entity.opposite.x, y: entity.first.y },
        entity.opposite,
        { x: entity.first.x, y: entity.opposite.y },
      ], true);
      break;
    case 'octagon':
      writePolyline(pair, entity, entity.vertices, true);
      break;
    case 'polyline':
      writePolyline(pair, entity, entity.vertices, entity.closed);
      break;
    case 'bezier':
      writeBezier(pair, entity);
      break;
    case 'text':
      start(pair, 'TEXT', entity);
      point(pair, 10, 20, entity.position);
      pair(40, num(entity.height));
      pair(1, entity.text);
      if (entity.rotation) pair(50, num(degrees(entity.rotation)));
      break;
    case 'dimension':
      writeDimension(pair, entity);
      break;
  }
}

/** Common opening for a native entity: type, layer, and an own colour if it has one. */
function start(pair: Pair, type: string, entity: { layer: string; aci: number }): void {
  pair(0, type);
  pair(8, entity.layer);
  // BYLAYER (256) and BYBLOCK (0) are the defaults, so they are left unwritten.
  if (entity.aci !== ACI_BYLAYER && entity.aci !== 0) pair(62, entity.aci);
}

function point(pair: Pair, xCode: number, yCode: number, p: Vec2): void {
  pair(xCode, num(p.x));
  pair(yCode, num(p.y));
}

function writeEllipse(pair: Pair, entity: EllipseEntity): void {
  start(pair, 'ELLIPSE', entity);
  point(pair, 10, 20, entity.center);
  // DXF wants the major axis endpoint (relative to the centre) and a minor/major
  // ratio no greater than one. Our radii are along the entity's own X and Y, so
  // whichever is longer becomes the major axis and the rotation follows it.
  const major = Math.max(entity.radiusX, entity.radiusY);
  const minor = Math.min(entity.radiusX, entity.radiusY);
  const axisAngle = entity.radiusX >= entity.radiusY ? entity.rotation : entity.rotation + Math.PI / 2;
  pair(11, num(Math.cos(axisAngle) * major));
  pair(21, num(Math.sin(axisAngle) * major));
  pair(40, num(major === 0 ? 1 : minor / major));
  pair(41, num(0));
  pair(42, num(Math.PI * 2));
}

function writePolyline(pair: Pair, entity: { layer: string; aci: number }, vertices: Vec2[], closed: boolean): void {
  start(pair, 'LWPOLYLINE', entity);
  pair(90, vertices.length);
  pair(70, closed ? 1 : 0);
  for (const vertex of vertices) point(pair, 10, 20, vertex);
}

function writeBezier(pair: Pair, entity: Extract<Entity, { type: 'bezier' }>): void {
  start(pair, 'SPLINE', entity);
  // A single clamped cubic: degree 3, four control points, the knot vector that
  // makes it pass through its ends. The importer reads exactly this back into a
  // bezier without loss.
  pair(70, 8); // planar
  pair(71, 3);
  pair(72, 8);
  pair(73, 4);
  pair(74, 0);
  for (const knot of [0, 0, 0, 0, 1, 1, 1, 1]) pair(40, num(knot));
  for (const control of [entity.start, entity.control1, entity.control2, entity.end]) point(pair, 10, 20, control);
}

/**
 * A dimension has no self-contained DXF entity — a real one points at a block of
 * the very lines and text drawn here. Rather than write that block, the drawn
 * geometry is emitted directly: the extension lines, the dimension line, each
 * arrowhead as a closed triangle, and the measurement as centred text. It is no
 * longer a live dimension on re-import, but it looks identical.
 */
function writeDimension(pair: Pair, entity: DimensionEntity): void {
  const geometry = dimensionGeometry(entity);
  const carrier = { layer: entity.layer, aci: entity.aci };
  const line = (a: Vec2, b: Vec2): void => {
    start(pair, 'LINE', carrier);
    point(pair, 10, 20, a);
    point(pair, 11, 21, b);
  };
  const path = (points: Vec2[]): void => {
    for (let index = 1; index < points.length; index++) line(points[index - 1], points[index]);
  };
  line(geometry.extensionStart[0], geometry.extensionStart[1]);
  line(geometry.extensionEnd[0], geometry.extensionEnd[1]);
  path(geometry.dimensionLine);
  for (const triangle of geometry.arrows) writePolyline(pair, carrier, triangle, true);

  start(pair, 'TEXT', carrier);
  point(pair, 10, 20, geometry.textPoint);
  pair(40, num(entity.textHeight * entity.scale));
  pair(1, geometry.text);
  if (geometry.textAngle) pair(50, num(degrees(geometry.textAngle)));
  // Centre the text on its point, horizontally and vertically.
  pair(72, 1);
  pair(73, 2);
  point(pair, 11, 21, geometry.textPoint);
}

function degrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

/** A DXF number: plain decimal, no exponent, trailing zeros trimmed. */
function num(value: number): string {
  if (!Number.isFinite(value)) return '0';
  let text = value.toFixed(8);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text === '-0' ? '0' : text;
}
