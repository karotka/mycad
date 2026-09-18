/**
 * Taking something apart: a rectangle into its four lines, an INSERT into the
 * drawing it stands for, single-stroke TEXT into the line segments a pen would
 * actually draw, and — like AutoCAD — a 3D solid into its faces.
 *
 * A solid explodes into one closed polyline per planar face (its outline, plus a
 * separate loop for each hole), laid on that face's own plane. Curved walls have
 * no planar region, so a cylinder gives back its two end circles and not its
 * side; this mirrors AutoCAD turning the flat faces into regions and leaving the
 * curved ones as surfaces it cannot represent here.
 */
import { ReplaceObjectsEdit } from '../../history/edits';
import { cloneSolidValue, closedVertices, curvePoints, expandedInsertEntities, expandedInsertSolids, genId, type Entity, type InsertEntity, type Solid } from '../../entities/types';
import { bulgeArc, hasPolylineArcs, polylineSegments } from '../../entities/polylineArcs';
import { solidPlanarFaces } from '../../solids/SolidTopology';
import type { Document } from '../../Document';
import { dist2, type Vec2 } from '../../../math/geometry';
import { cloneWorkPlane, WORLD_WORK_PLANE } from '../../../math/workplane';
import type { CommandRun, StepOutcome } from '../types';
import { hatchPatternSegments } from '../../entities/hatch';
import { isStrokeFont, strokeText } from '../../text/strokeFont';

/**
 * Where an INSERT puts one point of the block it stands for. The same
 * placement `expandedInsertEntities` applies, written out here because a
 * nested block reference has to be *moved* rather than taken apart, and that
 * needs the transform itself rather than its result.
 */
function placedByInsert(insert: InsertEntity, point: Vec2, column: number, row: number): Vec2 {
  const cos = Math.cos(insert.rotation), sin = Math.sin(insert.rotation);
  const x = (point.x - insert.definition.basePoint.x + column * insert.columnSpacing) * insert.scaleX;
  const y = (point.y - insert.definition.basePoint.y + row * insert.rowSpacing) * insert.scaleY;
  return { x: insert.position.x + x * cos - y * sin, y: insert.position.y + x * sin + y * cos };
}

/**
 * One level of a block, the way AutoCAD's EXPLODE gives it back: the objects
 * the block is made of, and a block *reference* for each block nested inside
 * it — still a block, to be exploded again if that is what is wanted. It used
 * to hand back the whole tree flattened to primitives, so exploding once took
 * apart things the user had deliberately kept together.
 *
 * A nested reference is carried out by composing the two placements, which is
 * exact as long as this INSERT does not scale its two axes differently: two
 * such scales with a rotation between them shear the result, and no single
 * position/rotation/scale can stand for that. In that one case the nested
 * block is flattened after all, and said so.
 */
function explodeInsertOneLevel(insert: InsertEntity, ctx: CommandRun['ctx']): Entity[] {
  const fresh = <T extends Entity>(entity: T): T => ({ ...entity, id: genId(entity.type), selected: false });
  const uniformScale = Math.abs(Math.abs(insert.scaleX) - Math.abs(insert.scaleY)) < 1e-9;
  const columns = Math.max(1, Math.floor(insert.columns));
  const rows = Math.max(1, Math.floor(insert.rows));
  const result: Entity[] = [];
  for (const child of insert.definition.entities) {
    // One child at a time through the shared expansion, so every entity type
    // is placed by exactly the code the renderer and snaps already agree with.
    const single: InsertEntity = { ...insert, definition: { ...insert.definition, entities: [child] } };
    if (child.type !== 'insert') {
      result.push(...expandedInsertEntities(single).map(fresh));
      continue;
    }
    if (!uniformScale && Math.abs(child.rotation) > 1e-9) {
      ctx.log(`EXPLODE: "${child.definition.name}" sits rotated inside a block scaled differently in x and y, so it cannot stay a block.`);
      result.push(...expandedInsertEntities(single).map(fresh));
      continue;
    }
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      result.push(fresh({
        ...child,
        position: placedByInsert(insert, child.position, column, row),
        rotation: child.rotation + insert.rotation,
        scaleX: child.scaleX * insert.scaleX,
        scaleY: child.scaleY * insert.scaleY,
        scaleZ: (child.scaleZ ?? 1) * (insert.scaleZ ?? 1),
        workPlane: insert.workPlane ? cloneWorkPlane(insert.workPlane) : undefined,
      }));
    }
  }
  return result;
}

function explodeEntity(entity: Entity, doc: Document, ctx: CommandRun['ctx']): Entity[] {
  if (entity.type === 'insert') return explodeInsertOneLevel(entity, ctx);
  if (entity.type === 'text') {
    // Only a single-stroke font has a path a pen could follow — a system
    // font's glyphs are filled outlines with no strokes to give back, same
    // reason the plotter/G-code export leaves them out rather than tracing
    // their edges. Each pen-up/pen-down run becomes its own line segments,
    // exactly like an arc or Bezier does below.
    if (!isStrokeFont(entity.font)) return [];
    const result: Entity[] = [];
    for (const stroke of strokeText(entity.text, { position: entity.position, height: entity.height, rotation: entity.rotation, font: entity.font })) {
      for (let index = 0; index < stroke.length - 1; index++) {
        const line = doc.createLine(stroke[index], stroke[index + 1]);
        line.layer = entity.layer; line.aci = entity.aci; line.color = entity.color;
        line.workPlane = cloneWorkPlane(entity.workPlane ?? WORLD_WORK_PLANE);
        result.push(line);
      }
    }
    return result;
  }
  if (entity.type === 'hatch') {
    const segments = entity.pattern === 'solid'
      ? entity.loops.flatMap((loop) => loop.map((point, index) => [point, loop[(index + 1) % loop.length]] as [Vec2, Vec2]))
      : hatchPatternSegments(entity.loops, entity.patternLines);
    return segments.map(([start, end]) => {
      const line = doc.createLine(start, end);
      line.layer = entity.layer; line.aci = entity.aci; line.color = entity.color;
      line.workPlane = cloneWorkPlane(entity.workPlane ?? WORLD_WORK_PLANE);
      return line;
    });
  }
  // A polyline that holds arc segments explodes into real lines and arcs, the
  // way it was joined — the whole point of keeping the bulge is that this can
  // give the arc back with its radius, not a chord or a chain of chords.
  if (entity.type === 'polyline' && hasPolylineArcs(entity)) {
    const stamp = <T extends Entity>(piece: T): T => {
      piece.layer = entity.layer; piece.aci = entity.aci; piece.color = entity.color;
      piece.workPlane = cloneWorkPlane(entity.workPlane ?? WORLD_WORK_PLANE);
      return piece;
    };
    return polylineSegments(entity).flatMap((segment): Entity[] => {
      const arc = bulgeArc(segment.start, segment.end, segment.bulge);
      if (arc) return [stamp(doc.createArc(arc.center, arc.radius, arc.startAngle, arc.sweepAngle))];
      return dist2(segment.start, segment.end) < 1e-18 ? [] : [stamp(doc.createLine(segment.start, segment.end))];
    });
  }
  let points: Vec2[] = [];
  let closed = false;
  if (entity.type === 'rectangle') { points = closedVertices(entity)!; closed = true; }
  else if (entity.type === 'polyline' || entity.type === 'octagon') { points = [...entity.vertices]; closed = entity.type === 'octagon' || entity.closed; }
  else if (entity.type === 'arc' || entity.type === 'bezier') points = curvePoints(entity, 48);
  else return [];
  if (closed && points.length > 1 && dist2(points[0], points.at(-1)!) < 1e-9) points.pop();
  const count = closed ? points.length : points.length - 1;
  const result: Entity[] = [];
  for (let index = 0; index < count; index++) {
    const line = doc.createLine(points[index], points[(index + 1) % points.length]);
    line.layer = entity.layer;
    line.aci = entity.aci; line.color = entity.color;
    line.workPlane = cloneWorkPlane(entity.workPlane ?? WORLD_WORK_PLANE);
    result.push(line);
  }
  return result;
}

/**
 * A solid's planar faces as closed polylines — AutoCAD's "solid to regions". Each
 * loop (the face outline first, then any holes) becomes one closed polyline on
 * the face's plane, so the pieces sit exactly where the faces were.
 */
function explodeSolidToFaces(solid: Solid, doc: Document): Entity[] {
  const result: Entity[] = [];
  for (const face of solidPlanarFaces(solid.mesh)) {
    for (const loop of face.loops) {
      if (loop.length < 3) continue;
      const polyline = doc.createPolyline(loop.map((point) => ({ x: point.x, y: point.y })), true);
      polyline.workPlane = cloneWorkPlane(face.plane);
      polyline.layer = solid.layer;
      polyline.color = solid.color;
      result.push(polyline);
    }
  }
  return result;
}

export function explodeObjects(run: CommandRun): StepOutcome {
  const { data, value, ctx } = run;
  if (run.gather(value)) return 'stay';

  const removedEntities: Entity[] = [];
  const removedSolids: Solid[] = [];
  const parts: Entity[] = [];
  const solidParts: Solid[] = [];

  for (const entity of data.entities as Entity[]) {
    const pieces = explodeEntity(entity, ctx.doc, ctx);
    const solidPieces = entity.type === 'insert'
      ? expandedInsertSolids(entity).map((solid) => ({
        ...cloneSolidValue(solid),
        id: genId('solid'),
        selected: false,
      }))
      : [];
    if (pieces.length + solidPieces.length === 0) {
      ctx.log(entity.type === 'text'
        ? `EXPLODE: "${entity.font ?? 'Arial'}" is an outline font — only Single-stroke text has strokes to explode into.`
        : `EXPLODE: ${entity.type} is already a primitive object.`);
      continue;
    }
    removedEntities.push(entity);
    parts.push(...pieces);
    solidParts.push(...solidPieces);
  }

  for (const solid of data.solids as Solid[]) {
    // Like AutoCAD: a solid comes apart into its faces, whatever it was built
    // from. A face with no planar area (a bare curved wall) has no region to give.
    const faces = explodeSolidToFaces(solid, ctx.doc);
    if (faces.length === 0) {
      ctx.log(`EXPLODE: ${solid.name} has no planar faces to explode.`);
      continue;
    }
    removedSolids.push(solid);
    parts.push(...faces);
  }

  if (parts.length + solidParts.length === 0) {
    ctx.log('EXPLODE: no selected object can be exploded.');
    return 'advance';
  }
  ctx.history.execute(new ReplaceObjectsEdit('Explode', removedEntities, removedSolids, parts, solidParts));
  ctx.doc.clearSelection();
  parts.forEach((entity, index) => ctx.doc.selectEntity(entity.id, index > 0));
  solidParts.forEach((solid) => ctx.doc.selectSolid(solid.id, true));
  ctx.log(`Exploded into ${parts.length + solidParts.length} part(s).`);
  return 'advance';
}
