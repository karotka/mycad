import type { Document } from '../core/Document';
import type { BlockDefinition, Entity, InsertEntity } from '../core/entities/types';
import { ACI_BYLAYER, ACI_WHITE, aciToRgb, resolveAci } from './DxfAci';
import { expandBulges, type BulgeVertex } from './DxfBulge';
import { isSingleCubic, sampleSpline, type SplineData } from './DxfSpline';
import { hatchDefinition } from './DxfHatch';

type Pair = { code: number; value: string };

export interface DxfImportResult {
  entities: Entity[];
  blockDefinitions: BlockDefinition[];
  layers: string[];
  /** Layer colours read from the TABLES section, so a drawing keeps its look. */
  layerAci: Record<string, number>;
  /** Layer line weights, in millimetres, for any layer whose record named one. */
  layerLineweight: Record<string, number>;
  /** Layer line types, by name, for any layer whose record named one. */
  layerLinetype: Record<string, string>;
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
    if (Number.isFinite(code)) {
      // TEXT/MTEXT chunks own their leading and trailing spaces. Trimming every
      // DXF value joined words split between repeated code 3 and final code 1.
      const rawValue = lines[index + 1];
      pairs.push({ code, value: code === 1 || code === 3 ? rawValue : rawValue.trim() });
    }
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

function insertionUnitCode(pairs: Pair[]): number {
  const marker = pairs.findIndex((pair) => pair.code === 9 && pair.value === '$INSUNITS');
  if (marker < 0) return 0;
  const unitPair = pairs.slice(marker + 1, marker + 6).find((pair) => pair.code === 70);
  const value = Number(unitPair?.value);
  return Number.isFinite(value) ? value : 0;
}

function sectionStart(pairs: Pair[], name: string): number {
  return pairs.findIndex((pair, index) =>
    pair.code === 2 && pair.value === name && pairs[index - 1]?.code === 0 && pairs[index - 1]?.value === 'SECTION');
}

function number(fields: Pair[], code: number, fallback = 0): number {
  const value = Number(fields.find((pair) => pair.code === code)?.value);
  return Number.isFinite(value) ? value : fallback;
}

interface RawBlock {
  name: string;
  basePoint: { x: number; y: number; z?: number };
  entityPairs: Pair[];
}

function readRawBlocks(pairs: Pair[], scale: number): Map<string, RawBlock> {
  const blocks = new Map<string, RawBlock>();
  const section = sectionStart(pairs, 'BLOCKS');
  if (section < 0) return blocks;
  for (let index = section + 1; index < pairs.length;) {
    if (pairs[index].code === 0 && pairs[index].value.toUpperCase() === 'ENDSEC') break;
    if (pairs[index].code !== 0 || pairs[index].value.toUpperCase() !== 'BLOCK') { index++; continue; }
    let headerEnd = index + 1;
    while (headerEnd < pairs.length && pairs[headerEnd].code !== 0) headerEnd++;
    const fields = pairs.slice(index + 1, headerEnd);
    const name = fields.find((pair) => pair.code === 2)?.value
      ?? fields.find((pair) => pair.code === 3)?.value;
    let blockEnd = headerEnd;
    while (blockEnd < pairs.length && !(pairs[blockEnd].code === 0 && pairs[blockEnd].value.toUpperCase() === 'ENDBLK')) blockEnd++;
    if (name) blocks.set(name.toUpperCase(), {
      name,
      basePoint: {
        x: number(fields, 10) * scale,
        y: number(fields, 20) * scale,
        ...(Math.abs(number(fields, 30)) > 1e-12 ? { z: number(fields, 30) * scale } : {}),
      },
      entityPairs: pairs.slice(headerEnd, blockEnd),
    });
    index = Math.min(pairs.length, blockEnd + 1);
  }
  return blocks;
}

function entityRecords(pairs: Pair[]): Array<{ type: string; fields: Pair[]; pairs: Pair[] }> {
  const records: Array<{ type: string; fields: Pair[]; pairs: Pair[] }> = [];
  for (let index = 0; index < pairs.length;) {
    if (pairs[index].code !== 0) { index++; continue; }
    let end = index + 1;
    while (end < pairs.length && pairs[end].code !== 0) end++;
    records.push({ type: pairs[index].value.toUpperCase(), fields: pairs.slice(index + 1, end), pairs: pairs.slice(index, end) });
    index = end;
  }
  return records;
}

function asciiFromPairs(pairs: Pair[]): string {
  return pairs.flatMap((pair) => [String(pair.code), pair.value]).join('\n');
}

interface LayerTable {
  aci: Record<string, number>;
  lineweight: Record<string, number>;
  linetype: Record<string, string>;
}

/**
 * Layer definitions live in TABLES, not with the entities. Without reading them
 * every imported layer fell back to white, however the drawing was authored.
 * Colour (62), line type (6) and line weight (370, in 1/100 mm) all live here.
 */
function readLayerTable(pairs: Pair[]): LayerTable {
  const table: LayerTable = { aci: {}, lineweight: {}, linetype: {} };
  const start = sectionStart(pairs, 'TABLES');
  if (start < 0) return table;
  for (let index = start; index < pairs.length; index++) {
    if (pairs[index].code === 0 && pairs[index].value.toUpperCase() === 'ENDSEC') break;
    if (pairs[index].code !== 0 || pairs[index].value.toUpperCase() !== 'LAYER') continue;
    let end = index + 1;
    while (end < pairs.length && pairs[end].code !== 0) end++;
    const fields = pairs.slice(index + 1, end);
    const name = fields.find((pair) => pair.code === 2)?.value;
    if (name) {
      // A negative colour means the layer is off; the index is its absolute value.
      table.aci[name] = Math.abs(number(fields, 62, ACI_BYLAYER));
      const linetype = fields.find((pair) => pair.code === 6)?.value;
      if (linetype) table.linetype[name] = linetype;
      // A weight of -3 (default), -2 (byblock) or -1 (bylayer) is not a real width.
      const weight = number(fields, 370, -1);
      if (weight >= 0) table.lineweight[name] = weight / 100;
    }
    index = end - 1;
  }
  return table;
}

/** MTEXT carries inline formatting; our text entity is one plain line. */
function mtextPlainText(fields: Pair[]): string {
  const raw = fields.filter((pair) => pair.code === 3).map((pair) => pair.value).join('')
    + (fields.find((pair) => pair.code === 1)?.value ?? '');
  // Protect escaped literal characters before consuming formatting commands.
  // MTEXT's underline/overline/strike toggles (\L...\l etc.) notably have no
  // trailing semicolon, unlike font, height and colour controls.
  const slash = '\uE000', openBrace = '\uE001', closeBrace = '\uE002';
  return raw
    .replace(/\\\\/g, slash)
    .replace(/\\\{/g, openBrace)
    .replace(/\\\}/g, closeBrace)
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\S([^;]*);/gi, (_match, stacked: string) => stacked.replace(/[\^#]/g, '/'))
    .replace(/\\[LlOoKk]/g, '')
    .replace(/\\[PX]/gi, ' ')
    .replace(/\\~/g, ' ')
    .replace(/\\[A-Za-z][^;\\]*;/g, '')
    .replace(/[{}]/g, '')
    .replaceAll(slash, '\\')
    .replaceAll(openBrace, '{')
    .replaceAll(closeBrace, '}')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Reverse DXF SAVEAS caret notation for embedded ASCII control characters. */
function dxfControlText(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '^' || index + 1 >= value.length) { result += value[index]; continue; }
    const marker = value[index + 1];
    // A literal caret is written as caret + space.
    if (marker === ' ') { result += '^'; index++; continue; }
    const upper = marker.toUpperCase();
    if (upper < 'A' || upper > 'Z') { result += '^'; continue; }
    const code = upper.charCodeAt(0) - 64;
    index++;
    if (code === 8) result = result.slice(0, -1); // ^H = backspace
    else if (code === 9 || code === 10 || code === 13) result += ' '; // tab/newline/return
    // Other C0 controls have no printable representation and are dropped.
  }
  return result;
}

export function importAsciiDxf(doc: Document, text: string): DxfImportResult {
  const pairs = pairsFromText(text);
  if (pairs.length === 0) throw new Error('The DXF file is empty or not an ASCII DXF file.');
  const scale = millimetreScale(pairs);
  const unitCode = insertionUnitCode(pairs);
  const rawBlocks = readRawBlocks(pairs, scale);
  const layerTable = readLayerTable(pairs);
  const layerAci = layerTable.aci;
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

  const style = <T extends Entity>(entity: T, fields: Pair[], layer: string): T => {
    entity.layer = layer;
    // The DXF colour is already an index; keep it as one. The RGB is resolved
    // here too, since the importer hands back entities without touching the
    // document, so nothing else will recompute it.
    entity.aci = number(fields, 62, ACI_BYLAYER);
    entity.color = colorOf(fields, layer);
    return entity;
  };

  const finish = (entity: Entity, fields: Pair[], layer: string): void => {
    style(entity, fields, layer);
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
    const plain = dxfControlText(value);
    if (!plain) { skip(type); return; }
    const entity = doc.createText(position, plain, (number(fields, 40, 2.5) || 2.5) * scale);
    entity.rotation = number(fields, 50, 0) * Math.PI / 180;
    finish(entity, fields, layer);
  };

  const configureInsert = (entity: InsertEntity, fields: Pair[]): InsertEntity => {
    entity.scaleX = number(fields, 41, 1);
    entity.scaleY = number(fields, 42, 1);
    entity.scaleZ = number(fields, 43, 1);
    entity.rotation = number(fields, 50, 0) * Math.PI / 180;
    entity.columns = Math.max(1, Math.floor(number(fields, 70, 1)));
    entity.rows = Math.max(1, Math.floor(number(fields, 71, 1)));
    entity.columnSpacing = number(fields, 44, 0) * scale;
    entity.rowSpacing = number(fields, 45, 0) * scale;
    return entity;
  };

  const definitions = new Map<string, BlockDefinition>();
  const resolving = new Set<string>();
  const resolveBlock = (key: string): BlockDefinition | null => {
    const normalized = key.toUpperCase();
    if (resolving.has(normalized)) return null;
    const cached = definitions.get(normalized);
    if (cached) return cached;
    const raw = rawBlocks.get(normalized);
    if (!raw) return null;
    resolving.add(normalized);

    const records = entityRecords(raw.entityPairs);
    const ordinary: Pair[] = [];
    const nestedRecords: typeof records = [];
    let attributesFollow = false;
    for (const record of records) {
      if (record.type === 'INSERT') {
        nestedRecords.push(record);
        attributesFollow = number(record.fields, 66, 0) === 1;
      } else if (attributesFollow && record.type === 'SEQEND') attributesFollow = false;
      else if (!attributesFollow) ordinary.push(...record.pairs);
    }
    const synthetic = `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n${unitCode}\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${asciiFromPairs(ordinary)}${ordinary.length ? '\n' : ''}0\nENDSEC\n0\nEOF\n`;
    const parsed = importAsciiDxf(doc, synthetic);
    // The synthetic sub-import intentionally has no TABLES section. Resolve its
    // BYLAYER colours against the real file's layer table before the definition
    // is cloned into INSERT snapshots.
    parsed.entities.forEach((entity) => {
      entity.color = resolveAci(entity.aci, layerAci[entity.layer] ?? ACI_WHITE);
    });
    approximated += parsed.approximated;
    ignored += parsed.ignored;
    for (const [type, count] of Object.entries(parsed.ignoredTypes)) ignoredTypes[type] = (ignoredTypes[type] ?? 0) + count;
    parsed.layers.forEach((layer) => layers.add(layer));

    const definition: BlockDefinition = { name: raw.name, basePoint: raw.basePoint, entities: parsed.entities };
    // Cache before resolving nested references so a malformed circular block is
    // stopped by `resolving` instead of recursing forever.
    definitions.set(normalized, definition);
    for (const record of nestedRecords) {
      const childName = record.fields.find((pair) => pair.code === 2)?.value;
      const childDefinition = childName ? resolveBlock(childName) : null;
      if (!childDefinition) { skip('INSERT'); continue; }
      const layer = layerOf(record.fields);
      const nested = configureInsert(doc.createInsert(childDefinition, {
        x: number(record.fields, 10) * scale,
        y: number(record.fields, 20) * scale,
        ...(Math.abs(number(record.fields, 30)) > 1e-12 ? { z: number(record.fields, 30) * scale } : {}),
      }), record.fields);
      definition.entities.push(style(nested, record.fields, layer));
      layers.add(layer);
    }
    resolving.delete(normalized);
    return definition;
  };
  for (const key of rawBlocks.keys()) resolveBlock(key);

  for (let index = section + 1; index < pairs.length;) {
    if (pairs[index].code !== 0) { index++; continue; }
    const type = pairs[index].value.toUpperCase();
    if (type === 'ENDSEC') break;
    let end = index + 1;
    while (end < pairs.length && pairs[end].code !== 0) end++;
    const fields = pairs.slice(index + 1, end);
    const layer = layerOf(fields);

    if (type === 'INSERT') {
      const name = fields.find((pair) => pair.code === 2)?.value;
      const definition = name ? resolveBlock(name) : null;
      if (!definition) skip(type);
      else finish(configureInsert(doc.createInsert(definition, {
        x: number(fields, 10) * scale,
        y: number(fields, 20) * scale,
        ...(Math.abs(number(fields, 30)) > 1e-12 ? { z: number(fields, 30) * scale } : {}),
      }), fields), fields, layer);
    } else if (type === 'POINT') {
      noteFlattened(fields, 30);
      finish(doc.createPoint(
        { x: number(fields, 10) * scale, y: number(fields, 20) * scale },
      ), fields, layer);
    } else if (type === 'LINE') {
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
    } else if (type === 'TEXT' || type === 'ATTRIB') {
      // An ATTRIB is a block attribute carrying its filled-in value in code 1,
      // laid out exactly like TEXT — the visible text in a title block or symbol.
      // Skip the invisible (70 bit 1) and the empty ones silently: they are data
      // or blank fields, not drawing, and are not worth naming as "unsupported".
      if (type === 'ATTRIB' && ((number(fields, 70, 0) & 1) || !(fields.find((pair) => pair.code === 1)?.value ?? ''))) { index = end; continue; }
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
      const override = fields.find((pair) => pair.code === 1)?.value ?? '';
      const preserveOverride = <T extends ReturnType<Document['createDimension']>>(dimension: T): T => {
        // DXF uses <> as its measured-value placeholder too, so both exact text
        // and decorations such as "<> TYP" now round-trip without approximation.
        if (override && override !== '<>') dimension.textOverride = override;
        return dimension;
      };

      if (kind === 0 || kind === 1) {
        // 13/14 are the extension line origins and 10 sits on the dimension line.
        // Type 0 is rotated/linear and measures along code 50; type 1 is aligned
        // and measures point to point. Both map exactly now.
        const start = point(13, 23);
        const end = point(14, 24);
        finish(preserveOverride(kind === 1
          ? doc.createDimension(start, end, point(10, 20), 'aligned')
          : doc.createDimension(start, end, point(10, 20), 'linear', number(fields, 50, 0) * Math.PI / 180)),
          fields, layer);
      } else if (kind === 3) {
        // Diameter: 10 and 15 are opposite ends of the diameter, so the centre
        // is between them; we store centre → rim.
        const rim = point(10, 20);
        const opposite = point(15, 25);
        const centre = { x: (rim.x + opposite.x) / 2, y: (rim.y + opposite.y) / 2 };
        finish(preserveOverride(doc.createDimension(centre, rim, textPoint, 'diameter')), fields, layer);
      } else if (kind === 4) {
        // Radius: 15 is the centre, 10 the point on the arc carrying the arrow.
        finish(preserveOverride(doc.createDimension(point(15, 25), point(10, 20), textPoint, 'radius')), fields, layer);
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
    } else if (type === 'HATCH') {
      noteFlattened(fields, 30);
      const definition = hatchDefinition(fields, scale);
      if (definition.loops.length) {
        const first = definition.lines[0];
        const angle = first ? first.angle * 180 / Math.PI : 0;
        const spacing = first ? Math.hypot(first.offset.x, first.offset.y) : doc.hatch.spacing;
        finish(doc.createHatch(
          definition.loops,
          definition.solid ? 'solid' : definition.pattern,
          angle,
          spacing,
          definition.lines,
        ), fields, layer);
      } else skip(type);
    } else if (!['VERTEX', 'SEQEND'].includes(type)) skip(type);
    index = end;
  }

  doc.layers = layersBefore;
  doc.layerAci = layerAciBefore;
  doc.layerColors = layerColorsBefore;
  return { entities, blockDefinitions: [...definitions.values()], layers: [...layers], layerAci, layerLineweight: layerTable.lineweight, layerLinetype: layerTable.linetype, ignored, ignoredTypes, approximated, unitScale: scale };
}
