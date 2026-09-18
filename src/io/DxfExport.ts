import type { Document } from '../core/Document';
import { dimensionGeometry, type BlockDefinition, type DimensionEntity, type EllipseEntity, type Entity } from '../core/entities/types';
import type { Vec2 } from '../math/geometry';
import { ACI_BYLAYER } from './DxfAci';
import { DEFAULT_LINE_TYPE, DEFAULT_LINE_WEIGHT_MM, LINE_TYPES } from '../core/lineStyles';
import { canonicalEntityPaths } from '../core/entities/EntityGeometry';
import type { DimensionStyle } from '../core/settings';
import { leaderGeometry, type LeaderEntity } from '../core/entities/types';

export interface DxfExportResult {
  dxf: string;
  /** Objects written, a dimension counted once however many lines it draws. */
  entityCount: number;
  /** Dimensions written as real DIMENSION records, which another CAD tool
   *  reads back as dimensions rather than as loose lines and text. */
  dimensionsNative: number;
  /** Dimensions that had to be exploded after all — none, as things stand,
   *  and kept so a kind that cannot be named in DXF can say so. */
  dimensionsDecomposed: number;
  /** MyCAD 3D bodies stored in block definitions cannot be represented by 2D DXF entities. */
  blockSolidsOmitted: number;
}

/**
 * Writes the drawing as an ASCII DXF (R2000 flavour): a HEADER naming the units,
 * a TABLES section defining the line types and layers, and an ENTITIES section
 * with one record per object. Every drawing entity except a dimension maps to a
 * native DXF entity; a dimension has no self-contained form, so it is exploded
 * into the lines, arrowheads and text it draws.
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

  // A DXF dimension is two halves: a DIMENSION record saying what is measured
  // and where, and an anonymous block holding the picture of it. The block has
  // to be written before the entities that reference it, so the names are
  // handed out here, up front.
  const dimensions = doc.entities.filter((entity): entity is DimensionEntity => entity.type === 'dimension');
  const pictureBlocks = new Map<string, string>();
  dimensions.forEach((entity, index) => pictureBlocks.set(entity.id, `*D${index + 1}`));

  writeHeader(pair, doc.drafting.linetypeScale);
  writeTables(pair, doc, layers, [...usedLinetypes], doc.dimensionStyle);
  const definitions = blockDefinitions(doc);
  writeBlocks(pair, definitions, dimensions, pictureBlocks);

  pair(0, 'SECTION');
  pair(2, 'ENTITIES');
  let entityCount = 0;
  for (const entity of doc.entities) {
    if (entity.type === 'dimension') writeDimension(pair, entity, pictureBlocks.get(entity.id)!);
    else writeEntity(pair, entity);
    entityCount++;
  }
  pair(0, 'ENDSEC');
  pair(0, 'EOF');

  return {
    dxf: out.join('\n') + '\n',
    entityCount,
    dimensionsNative: dimensions.length,
    dimensionsDecomposed: 0,
    blockSolidsOmitted: definitions.reduce((total, definition) => total + (definition.solids?.length ?? 0), 0),
  };
}

function blockDefinitions(doc: Document): BlockDefinition[] {
  const definitions = new Map<string, BlockDefinition>();
  const add = (definition: BlockDefinition): void => {
    const key = definition.name.toUpperCase();
    if (definitions.has(key)) return;
    definitions.set(key, definition);
    definition.entities.forEach((entity) => { if (entity.type === 'insert') add(entity.definition); });
  };
  doc.blockDefinitions.forEach(add);
  doc.entities.forEach((entity) => { if (entity.type === 'insert') add(entity.definition); });
  return [...definitions.values()];
}

function writeBlocks(
  pair: Pair,
  definitions: BlockDefinition[],
  dimensions: readonly DimensionEntity[],
  pictureBlocks: ReadonlyMap<string, string>,
): void {
  pair(0, 'SECTION');
  pair(2, 'BLOCKS');
  // One anonymous block per dimension, holding the lines, arrowheads and text
  // it is drawn with. A reader that understands dimensions rebuilds the
  // picture from the style; one that does not still shows exactly what we drew.
  for (const entity of dimensions) {
    const name = pictureBlocks.get(entity.id)!;
    pair(0, 'BLOCK');
    pair(8, entity.layer);
    pair(2, name);
    // 1 marks the block anonymous, 2 that it has no attributes.
    pair(70, 1);
    point(pair, 10, 20, { x: 0, y: 0 });
    pair(3, name);
    pair(1, '');
    writeDimensionPicture(pair, entity);
    pair(0, 'ENDBLK');
    pair(8, entity.layer);
  }
  for (const definition of definitions) {
    pair(0, 'BLOCK');
    pair(8, '0');
    pair(2, definition.name);
    pair(70, 0);
    point(pair, 10, 20, definition.basePoint);
    pair(3, definition.name);
    pair(1, '');
    definition.entities.forEach((entity) => writeEntity(pair, entity));
    pair(0, 'ENDBLK');
    pair(8, '0');
  }
  pair(0, 'ENDSEC');
}

type Pair = (code: number, value: string | number) => void;

function writeHeader(pair: Pair, linetypeScale: number): void {
  pair(0, 'SECTION');
  pair(2, 'HEADER');
  pair(9, '$ACADVER');
  pair(1, 'AC1015');
  // 4 is millimetres; the importer keys its unit scale off this variable.
  pair(9, '$INSUNITS');
  pair(70, 4);
  // The drawing's own linetype scale. Without it a drawing whose dashes were
  // tuned here opens elsewhere as a solid or a dotted line.
  pair(9, '$LTSCALE');
  pair(40, num(linetypeScale));
  pair(0, 'ENDSEC');
}

/** The one dimension style written, and the name every DIMENSION points at. */
export const DIMENSION_STYLE_NAME = 'MYCAD';

function writeTables(
  pair: Pair,
  doc: Document,
  layers: string[],
  linetypes: string[],
  style: DimensionStyle,
): void {
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

  // The dimension style. Without one, a reader rebuilds every dimension from
  // its own defaults and the drawing comes back with the wrong text height and
  // the wrong arrows — the numbers are right and nothing else is.
  pair(0, 'TABLE');
  pair(2, 'DIMSTYLE');
  pair(70, 1);
  pair(0, 'DIMSTYLE');
  pair(2, DIMENSION_STYLE_NAME);
  pair(70, 0);
  pair(41, num(style.arrowSize));        // DIMASZ — arrowhead size
  pair(140, num(style.textHeight));      // DIMTXT — text height
  pair(42, num(style.extensionOffset));  // DIMEXO — gap from the object
  pair(44, num(style.extensionBeyond));  // DIMEXE — past the dimension line
  pair(147, num(style.textOffset));      // DIMGAP — gap round the text
  pair(271, style.precision);            // DIMDEC — decimal places
  pair(179, style.angularPrecision);     // DIMADEC — for angles
  pair(40, num(style.scale));            // DIMSCALE — overall scale
  // Ticks are drawn instead of arrowheads when this is set, which is how a
  // drawing asks for the slash a survey or an architectural plan uses.
  pair(173, style.arrowType === 'tick' ? 1 : 0);
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
    case 'insert':
      start(pair, 'INSERT', entity);
      pair(2, entity.blockName);
      point(pair, 10, 20, entity.position);
      if (entity.scaleX !== 1) pair(41, num(entity.scaleX));
      if (entity.scaleY !== 1) pair(42, num(entity.scaleY));
      if (entity.scaleZ !== 1) pair(43, num(entity.scaleZ));
      if (entity.rotation) pair(50, num(degrees(entity.rotation)));
      if (entity.columns !== 1) pair(70, entity.columns);
      if (entity.rows !== 1) pair(71, entity.rows);
      if (entity.columnSpacing) pair(44, num(entity.columnSpacing));
      if (entity.rowSpacing) pair(45, num(entity.rowSpacing));
      break;
    case 'point':
      start(pair, 'POINT', entity);
      point(pair, 10, 20, entity.position);
      break;
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
      writePolyline(pair, entity, entity.vertices, entity.closed, entity.bulges);
      break;
    case 'mline':
      // No native MLINE/MLINESTYLE writer yet — each parallel line exports as
      // its own LWPOLYLINE, in the element's own colour, so the drawing still
      // reads correctly (and cuts/plots correctly) in a plain DXF reader.
      canonicalEntityPaths(entity).forEach((path, index) => {
        writePolyline(pair, { layer: entity.layer, aci: entity.elements[index].aci }, path.points, path.closed);
      });
      break;
    case 'bezier':
      writeBezier(pair, entity);
      break;
    case 'hatch':
      writeHatch(pair, entity);
      break;
    case 'text':
      start(pair, 'TEXT', entity);
      point(pair, 10, 20, entity.position);
      pair(40, num(entity.height));
      pair(1, entity.text);
      if (entity.rotation) pair(50, num(degrees(entity.rotation)));
      break;
    case 'leader':
      writeLeader(pair, entity);
      break;
    case 'dimension':
      // Handled by the caller, which alone knows the picture block's name.
      break;
  }
}

function writeHatch(pair: Pair, entity: Extract<Entity, { type: 'hatch' }>): void {
  start(pair, 'HATCH', entity);
  pair(2, entity.pattern === 'solid' ? 'SOLID' : entity.pattern);
  pair(70, entity.pattern === 'solid' ? 1 : 0);
  pair(71, 0);
  pair(91, entity.loops.length);
  for (const loop of entity.loops) {
    pair(92, 3); pair(72, 0); pair(73, 1); pair(93, loop.length);
    for (const vertex of loop) point(pair, 10, 20, vertex);
  }
  pair(75, 0); pair(76, 1);
  if (entity.pattern !== 'solid') {
    pair(78, entity.patternLines.length);
    for (const line of entity.patternLines) {
      pair(53, num(degrees(line.angle)));
      pair(43, num(line.base.x)); pair(44, num(line.base.y));
      pair(45, num(line.offset.x)); pair(46, num(line.offset.y));
      pair(79, 0);
    }
  }
}

/** Common opening for a native entity: type, layer, an own colour if it has
 *  one, and an own linetype scale if it has one. */
function start(pair: Pair, type: string, entity: { layer: string; aci: number; linetypeScale?: number }): void {
  pair(0, type);
  pair(8, entity.layer);
  // BYLAYER (256) and BYBLOCK (0) are the defaults, so they are left unwritten.
  if (entity.aci !== ACI_BYLAYER && entity.aci !== 0) pair(62, entity.aci);
  // 48 is the object's own linetype scale. 1 is the default, so writing it
  // would only add a line to every entity in the file.
  if (typeof entity.linetypeScale === 'number' && entity.linetypeScale > 0 && entity.linetypeScale !== 1) {
    pair(48, num(entity.linetypeScale));
  }
}

function point(pair: Pair, xCode: number, yCode: number, p: Vec2 & { z?: number }): void {
  pair(xCode, num(p.x));
  pair(yCode, num(p.y));
  if (p.z !== undefined && Math.abs(p.z) > 1e-12) pair(yCode + 10, num(p.z));
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

function writePolyline(
  pair: Pair,
  entity: { layer: string; aci: number; linetypeScale?: number },
  vertices: Vec2[],
  closed: boolean,
  bulges?: readonly number[],
): void {
  start(pair, 'LWPOLYLINE', entity);
  pair(90, vertices.length);
  pair(70, closed ? 1 : 0);
  for (const [index, vertex] of vertices.entries()) {
    point(pair, 10, 20, vertex);
    // 42 is the bulge of the segment leaving this vertex; 0 is the default, so
    // a straight run writes nothing and an ordinary polyline is unchanged.
    const bulge = bulges?.[index];
    if (typeof bulge === 'number' && Number.isFinite(bulge) && bulge !== 0) pair(42, num(bulge));
  }
}

function writeBezier(pair: Pair, entity: Extract<Entity, { type: 'bezier' }>): void {
  start(pair, 'SPLINE', entity);
  // A clamped, degree-3 Bezier spline: one span per segment, each fully
  // independent of its neighbours (knot multiplicity 3 at every internal
  // joint — the same "no smoothing across the join" our own grips give it).
  // One segment is exactly the [0,0,0,0,1,1,1,1] single-cubic case this wrote
  // before there were ever more than one; the importer reads either back
  // without loss.
  const segmentCount = entity.segments.length;
  const controlPoints = [entity.start, ...entity.segments.flatMap((segment) => [segment.control1, segment.control2, segment.end])];
  pair(70, 8); // planar
  pair(71, 3);
  pair(72, 8);
  pair(73, controlPoints.length);
  pair(74, 0);
  const knots: number[] = [0, 0, 0, 0];
  for (let joint = 1; joint < segmentCount; joint++) knots.push(joint, joint, joint);
  knots.push(segmentCount, segmentCount, segmentCount, segmentCount);
  for (const knot of knots) pair(40, num(knot));
  for (const control of controlPoints) point(pair, 10, 20, control);
}

/**
 * A dimension has no self-contained DXF entity — a real one points at a block of
 * the very lines and text drawn here. Rather than write that block, the drawn
 * geometry is emitted directly: the extension lines, the dimension line, each
 * arrowhead as a closed triangle, and the measurement as centred text. It is no
 * longer a live dimension on re-import, but it looks identical.
 */
/**
 * The DIMENSION record itself: what is measured, where, and which block holds
 * the picture of it.
 *
 * Until now a dimension left here as loose lines and a piece of text, which
 * another CAD tool reads as loose lines and a piece of text — you cannot
 * select it, restyle it, or see it update. The defining points below are what
 * make it a dimension again on the other side.
 */
function writeDimension(pair: Pair, entity: DimensionEntity, blockName: string): void {
  const geometry = dimensionGeometry(entity);
  start(pair, 'DIMENSION', entity);
  pair(2, blockName);
  pair(3, DIMENSION_STYLE_NAME);
  // Bit 32 says the block belongs to this dimension alone; bit 128 that the
  // text sits where it was put rather than where the style would put it.
  const flags = DIMENSION_TYPES[entity.dimensionKind] | 32 | (entity.textPosition ? 128 : 0);
  pair(70, flags);
  // 11 is where the text sits — written for every kind.
  point(pair, 11, 21, geometry.textPoint);
  if (entity.textOverride) pair(1, entity.textOverride);
  switch (entity.dimensionKind) {
    case 'linear':
    case 'aligned':
      // 13 and 14 are the two points being measured between; 10 is a point the
      // dimension line passes through.
      point(pair, 13, 23, entity.start);
      point(pair, 14, 24, entity.end);
      point(pair, 10, 20, entity.offset);
      if (entity.dimensionKind === 'linear') pair(50, num(degrees(entity.rotation ?? 0)));
      break;
    case 'diameter': {
      // The two ends of the diameter, which is how DXF names one: our centre
      // and rim give the far side by reflection.
      const opposite = { x: entity.start.x * 2 - entity.end.x, y: entity.start.y * 2 - entity.end.y };
      point(pair, 10, 20, entity.end);
      point(pair, 15, 25, opposite);
      break;
    }
    case 'radius':
      // 15 is the centre, 10 the point on the arc the arrow touches.
      point(pair, 15, 25, entity.start);
      point(pair, 10, 20, entity.end);
      break;
    case 'angular':
      // Three-point angular: the vertex, a point on each ray, and a point the
      // dimension arc passes through — exactly what this drawing stores.
      point(pair, 15, 25, entity.start);
      point(pair, 13, 23, entity.end);
      point(pair, 14, 24, entity.offset);
      point(pair, 10, 20, entity.arcPoint ?? geometry.textPoint);
      break;
  }
}

/**
 * A leader as DXF holds one: a LEADER record giving the line's corners, and
 * the note as a separate TEXT the record points at.
 *
 * DXF has no place inside a LEADER for the words — it carries an association
 * to an annotation entity instead, which is why the text is written alongside.
 * The line is what makes it a leader on the other side; the text is what it
 * says.
 */
function writeLeader(pair: Pair, entity: LeaderEntity): void {
  const geometry = leaderGeometry(entity);
  start(pair, 'LEADER', entity);
  pair(3, DIMENSION_STYLE_NAME);
  // 71 says the leader has an arrowhead, 72 that its line is straight rather
  // than a spline, 73 that what it carries is text.
  pair(71, entity.arrowType === 'none' ? 0 : 1);
  pair(72, 0);
  pair(73, 0);
  pair(76, geometry.path.length);
  // Every corner repeats the same triple of codes, which is how DXF lists the
  // vertices of a leader.
  for (const corner of geometry.path) { pair(10, num(corner.x)); pair(20, num(corner.y)); pair(30, 0); }
  // The height and the shelf, so a reader redraws it at the size it was drawn.
  pair(40, num(entity.textHeight * entity.scale));
  pair(41, num(entity.landing * entity.scale));

  const height = entity.textHeight * entity.scale;
  start(pair, 'TEXT', entity);
  point(pair, 10, 20, { x: geometry.textPoint.x, y: geometry.textPoint.y });
  pair(40, num(height));
  pair(1, entity.text.split('\n')[0]);
  // 72 is the horizontal placing: the note reads away from the arrow, so a
  // leader coming in from the right ends its text at the shelf.
  pair(72, geometry.textAnchor === 'start' ? 0 : 2);
  point(pair, 11, 21, { x: geometry.textPoint.x, y: geometry.textPoint.y });
}

/** How each kind is named in a DIMENSION record's own type field. */
const DIMENSION_TYPES: Record<DimensionEntity['dimensionKind'], number> = {
  linear: 0,
  aligned: 1,
  angular: 5,
  diameter: 3,
  radius: 4,
};

/** The lines, arrowheads and text a dimension is drawn with, for its block. */
function writeDimensionPicture(pair: Pair, entity: DimensionEntity): void {
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
