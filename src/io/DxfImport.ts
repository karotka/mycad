import type { Document } from '../core/Document';
import type { Entity } from '../core/entities/types';
import { ACI_BYLAYER, ACI_WHITE, aciToRgb } from './DxfAci';
import { expandBulges, type BulgeVertex } from './DxfBulge';
import { isSingleCubic, sampleSpline, type SplineData } from './DxfSpline';

type Pair = { code: number; value: string };

export interface DxfImportResult {
  entities: Entity[];
  layers: string[];
  /** Layer colours read from the TABLES section, so a drawing keeps its look. */
  layerAci: Record<string, number>;
  ignored: number;
  /** What was skipped, by DXF type — so the report can name it instead of only counting. */
  ignoredTypes: Record<string, number>;
  /** Geometry that survived but had to be approximated (arcs expanded, Z dropped). */
  approximated: number;
  unitScale: number;
}

function pairsFromText(text: string): Pair[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const pairs: Pair[] = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number.parseInt(lines[index].trim(), 10);
    if (Number.isFinite(code)) pairs.push({ code, value: lines[index + 1].trim() });
  }
  return pairs;
}

function millimetreScale(pairs: Pair[]): number {
  // $INSUNITS: 1 in, 2 ft, 3 mi, 4 mm, 5 cm, 6 m, 7 km; 0 is unitless.
  const units: Record<number, number> = { 0: 1, 1: 25.4, 2: 304.8, 3: 1_609_344, 4: 1, 5: 10, 6: 1000, 7: 1_000_000 };
  const marker = pairs.findIndex((pair) => pair.code === 9 && pair.value === '$INSUNITS');
  if (marker < 0) return 1;
  const unitPair = pairs.slice(marker + 1, marker + 6).find((pair) => pair.code === 70);
  return units[Number(unitPair?.value)] ?? 1;
}

function sectionStart(pairs: Pair[], name: string): number {
  return pairs.findIndex((pair, index) =>
    pair.code === 2 && pair.value === name && pairs[index - 1]?.code === 0 && pairs[index - 1]?.value === 'SECTION');
}

function number(fields: Pair[], code: number, fallback = 0): number {
  const value = Number(fields.find((pair) => pair.code === code)?.value);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Layer definitions live in TABLES, not with the entities. Without reading them
 * every imported layer fell back to white, however the drawing was authored.
 */
function readLayerTable(pairs: Pair[]): Record<string, number> {
  const colors: Record<string, number> = {};
  const start = sectionStart(pairs, 'TABLES');
  if (start < 0) return colors;
  for (let index = start; index < pairs.length; index++) {
    if (pairs[index].code === 0 && pairs[index].value.toUpperCase() === 'ENDSEC') break;
    if (pairs[index].code !== 0 || pairs[index].value.toUpperCase() !== 'LAYER') continue;
    let end = index + 1;
    while (end < pairs.length && pairs[end].code !== 0) end++;
    const fields = pairs.slice(index + 1, end);
    const name = fields.find((pair) => pair.code === 2)?.value;
    // A negative colour means the layer is off; the index is its absolute value.
    const aci = Math.abs(number(fields, 62, ACI_BYLAYER));
    if (name) colors[name] = aci;
    index = end - 1;
  }
  return colors;
}

/** MTEXT carries inline formatting; our text entity is one plain line. */
function mtextPlainText(fields: Pair[]): string {
  const raw = fields.filter((pair) => pair.code === 3).map((pair) => pair.value).join('')
    + (fields.find((pair) => pair.code === 1)?.value ?? '');
  return raw
    .replace(/\\P/g, ' ')
    .replace(/\\[A-Za-z][^;\\]*;/g, '')
    .replace(/[{}]/g, '')
    .trim();
}

export function importAsciiDxf(doc: Document, text: string): DxfImportResult {
  const pairs = pairsFromText(text);
  if (pairs.length === 0) throw new Error('The DXF file is empty or not an ASCII DXF file.');
  const scale = millimetreScale(pairs);
  const layerAci = readLayerTable(pairs);
  const section = sectionStart(pairs, 'ENTITIES');
  if (section < 0) throw new Error('DXF ENTITIES section was not found. Binary DXF is not supported.');

  const entities: Entity[] = [];
  const layers = new Set<string>();
  const ignoredTypes: Record<string, number> = {};
  let ignored = 0;
  let approximated = 0;

  // `doc` is here for its factories and defaults only — reading a file must not
  // change the document. createDimension registers its style layer as a side
  // effect, which would invent a "dims" layer the file never had.
  const layersBefore = [...doc.layers];
  const layerAciBefore = { ...doc.layerAci };
  const layerColorsBefore = { ...doc.layerColors };

  const layerOf = (fields: Pair[]): string => fields.find((pair) => pair.code === 8)?.value || '0';
  const skip = (type: string): void => { ignored++; ignoredTypes[type] = (ignoredTypes[type] ?? 0) + 1; };

  /** An entity's own colour wins; otherwise it takes its layer's. */
  const colorOf = (fields: Pair[], layer: string): number => {
    const own = aciToRgb(number(fields, 62, ACI_BYLAYER));
    return own ?? aciToRgb(layerAci[layer] ?? ACI_WHITE) ?? doc.layerColorFor(layer);
  };

  const finish = (entity: Entity, fields: Pair[], layer: string): void => {
    entity.layer = layer;
    // The DXF colour is already an index; keep it as one. The RGB is resolved
    // here too, since the importer hands back entities without touching the
    // document, so nothing else will recompute it.
    entity.aci = number(fields, 62, ACI_BYLAYER);
    entity.color = colorOf(fields, layer);
    entities.push(entity);
    layers.add(layer);
  };

  /** Anything off the XY plane is flattened: our entities are 2D within a work plane. */
  const noteFlattened = (fields: Pair[], ...codes: number[]): void => {
    if (codes.some((code) => Math.abs(number(fields, code, 0)) > 1e-9)) approximated++;
  };

  /** Pairs up repeated coordinate codes, e.g. a spline's 10/20 control points. */
  const repeatedPoints = (fields: Pair[], xCode: number, yCode: number): Array<{ x: number; y: number }> => {
    const points: Array<{ x: number; y: number }> = [];
    let current: { x: number; y: number } | null = null;
    for (const pair of fields) {
      if (pair.code === xCode) {
        current = { x: Number(pair.value) * scale, y: 0 };
        points.push(current);
      } else if (pair.code === yCode && current) current.y = Number(pair.value) * scale;
    }
    return points;
  };

  const readLwVertices = (fields: Pair[]): BulgeVertex[] => {
    const vertices: BulgeVertex[] = [];
    let current: BulgeVertex | null = null;
    for (const pair of fields) {
      if (pair.code === 10) {
        current = { x: Number(pair.value) * scale, y: 0, bulge: 0 };
        vertices.push(current);
      } else if (pair.code === 20 && current) current.y = Number(pair.value) * scale;
      else if (pair.code === 42 && current) current.bulge = Number(pair.value);
    }
    return vertices;
  };

  const addPolyline = (vertices: BulgeVertex[], closed: boolean, fields: Pair[], layer: string, type: string): void => {
    if (vertices.length < 2) { skip(type); return; }
    const { points, arcs } = expandBulges(vertices, closed);
    approximated += arcs;
    finish(doc.createPolyline(points, closed), fields, layer);
  };

  const addText = (fields: Pair[], layer: string, value: string, position: { x: number; y: number }, type: string): void => {
    if (!value) { skip(type); return; }
    const entity = doc.createText(position, value, (number(fields, 40, 2.5) || 2.5) * scale);
    entity.rotation = number(fields, 50, 0) * Math.PI / 180;
    finish(entity, fields, layer);
  };

  for (let index = section + 1; index < pairs.length;) {
    if (pairs[index].code !== 0) { index++; continue; }
    const type = pairs[index].value.toUpperCase();
    if (type === 'ENDSEC') break;
    let end = index + 1;
    while (end < pairs.length && pairs[end].code !== 0) end++;
    const fields = pairs.slice(index + 1, end);
    const layer = layerOf(fields);

    if (type === 'LINE') {
      noteFlattened(fields, 30, 31);
      finish(doc.createLine(
        { x: number(fields, 10) * scale, y: number(fields, 20) * scale },
        { x: number(fields, 11) * scale, y: number(fields, 21) * scale },
      ), fields, layer);
    } else if (type === 'CIRCLE') {
      noteFlattened(fields, 30);
      finish(doc.createCircle({ x: number(fields, 10) * scale, y: number(fields, 20) * scale }, number(fields, 40) * scale), fields, layer);
    } else if (type === 'ARC') {
      noteFlattened(fields, 30);
      const start = number(fields, 50) * Math.PI / 180;
      const endAngle = number(fields, 51) * Math.PI / 180;
      let sweep = endAngle - start;
      while (sweep <= 0) sweep += Math.PI * 2;
      finish(doc.createArc({ x: number(fields, 10) * scale, y: number(fields, 20) * scale }, number(fields, 40) * scale, start, sweep), fields, layer);
    } else if (type === 'TEXT') {
      noteFlattened(fields, 30);
      // Codes 72/73 move the insertion point to the alignment point at 11/21.
      const aligned = (number(fields, 72, 0) !== 0 || number(fields, 73, 0) !== 0)
        && fields.some((pair) => pair.code === 11);
      addText(fields, layer, fields.find((pair) => pair.code === 1)?.value ?? '', aligned
        ? { x: number(fields, 11) * scale, y: number(fields, 21) * scale }
        : { x: number(fields, 10) * scale, y: number(fields, 20) * scale }, type);
    } else if (type === 'MTEXT') {
      noteFlattened(fields, 30);
      addText(fields, layer, mtextPlainText(fields), { x: number(fields, 10) * scale, y: number(fields, 20) * scale }, type);
    } else if (type === 'ELLIPSE') {
      noteFlattened(fields, 30);
      // 11/21 is the major axis endpoint *relative to the centre*, and 40 is the
      // minor/major ratio — so both radii and the rotation come from that vector.
      const centre = { x: number(fields, 10) * scale, y: number(fields, 20) * scale };
      const major = { x: number(fields, 11) * scale, y: number(fields, 21) * scale };
      const radiusX = Math.hypot(major.x, major.y);
      const radiusY = radiusX * number(fields, 40, 1);
      if (radiusX < 1e-9 || radiusY < 1e-9) skip(type);
      else finish(doc.createEllipse(centre, radiusX, radiusY, Math.atan2(major.y, major.x)), fields, layer);
    } else if (type === 'DIMENSION') {
      noteFlattened(fields, 30);
      // The low bits of 70 hold the kind; 32/64/128 are unrelated flags.
      const kind = number(fields, 70, 0) & 7;
      const point = (xCode: number, yCode: number) => ({ x: number(fields, xCode) * scale, y: number(fields, yCode) * scale });
      const textPoint = point(11, 21);
      // Our dimension always renders its own measurement, so an overridden text
      // ("25 TYP") cannot survive. '<>' just means "use the measurement".
      const override = fields.find((pair) => pair.code === 1)?.value ?? '';
      if (override && override !== '<>') approximated++;

      if (kind === 0 || kind === 1) {
        // 13/14 are the extension line origins and 10 sits on the dimension line.
        // Type 0 is rotated/linear and measures along code 50; type 1 is aligned
        // and measures point to point. Both map exactly now.
        const start = point(13, 23);
        const end = point(14, 24);
        finish(kind === 1
          ? doc.createDimension(start, end, point(10, 20), 'aligned')
          : doc.createDimension(start, end, point(10, 20), 'linear', number(fields, 50, 0) * Math.PI / 180),
          fields, layer);
      } else if (kind === 3) {
        // Diameter: 10 and 15 are opposite ends of the diameter, so the centre
        // is between them; we store centre → rim.
        const rim = point(10, 20);
        const opposite = point(15, 25);
        const centre = { x: (rim.x + opposite.x) / 2, y: (rim.y + opposite.y) / 2 };
        finish(doc.createDimension(centre, rim, textPoint, 'diameter'), fields, layer);
      } else if (kind === 4) {
        // Radius: 15 is the centre, 10 the point on the arc carrying the arrow.
        finish(doc.createDimension(point(15, 25), point(10, 20), textPoint, 'radius'), fields, layer);
      } else skip(type); // angular and ordinate have no counterpart
    } else if (type === 'SPLINE') {
      noteFlattened(fields, 30);
      const spline: SplineData = {
        degree: number(fields, 71, 3),
        controlPoints: repeatedPoints(fields, 10, 20),
        knots: fields.filter((pair) => pair.code === 40).map((pair) => Number(pair.value)),
        weights: fields.filter((pair) => pair.code === 41).map((pair) => Number(pair.value)),
        closed: (number(fields, 70) & 1) === 1,
      };
      if (isSingleCubic(spline)) {
        // Exactly one cubic segment: our bezier holds it without loss.
        const [start, control1, control2, splineEnd] = spline.controlPoints;
        finish(doc.createBezier(start, control1, control2, splineEnd), fields, layer);
      } else {
        const points = sampleSpline(spline);
        if (points.length < 2) skip(type);
        else {
          // A general NURBS has no exact home in our model, so it is kept as the
          // polyline it samples to — reported, never silently.
          approximated++;
          finish(doc.createPolyline(points, spline.closed), fields, layer);
        }
      }
    } else if (type === 'LWPOLYLINE') {
      noteFlattened(fields, 38);
      addPolyline(readLwVertices(fields), (number(fields, 70) & 1) === 1, fields, layer, type);
    } else if (type === 'POLYLINE') {
      const vertices: BulgeVertex[] = [];
      let cursor = end;
      while (cursor < pairs.length && pairs[cursor].code === 0 && pairs[cursor].value.toUpperCase() === 'VERTEX') {
        let vertexEnd = cursor + 1;
        while (vertexEnd < pairs.length && pairs[vertexEnd].code !== 0) vertexEnd++;
        const vertex = pairs.slice(cursor + 1, vertexEnd);
        vertices.push({ x: number(vertex, 10) * scale, y: number(vertex, 20) * scale, bulge: number(vertex, 42, 0) });
        cursor = vertexEnd;
      }
      addPolyline(vertices, (number(fields, 70) & 1) === 1, fields, layer, type);
      while (cursor < pairs.length && !(pairs[cursor].code === 0 && pairs[cursor].value.toUpperCase() === 'SEQEND')) cursor++;
      end = Math.min(pairs.length, cursor + 1);
    } else if (!['VERTEX', 'SEQEND'].includes(type)) skip(type);
    index = end;
  }

  doc.layers = layersBefore;
  doc.layerAci = layerAciBefore;
  doc.layerColors = layerColorsBefore;
  return { entities, layers: [...layers], layerAci, ignored, ignoredTypes, approximated, unitScale: scale };
}
