/**
 * Taking something apart: a rectangle into its four lines, an INSERT into the
 * drawing it stands for, and — like AutoCAD — a 3D solid into its faces.
 *
 * A solid explodes into one closed polyline per planar face (its outline, plus a
 * separate loop for each hole), laid on that face's own plane. Curved walls have
 * no planar region, so a cylinder gives back its two end circles and not its
 * side; this mirrors AutoCAD turning the flat faces into regions and leaving the
 * curved ones as surfaces it cannot represent here.
 */
import { ReplaceObjectsEdit } from '../../history/edits';
import { cloneSolidValue, closedVertices, curvePoints, expandedInsertEntities, expandedInsertSolids, genId, type Entity, type Solid } from '../../entities/types';
import { solidPlanarFaces } from '../../solids/SolidTopology';
import type { Document } from '../../Document';
import { dist2, type Vec2 } from '../../../math/geometry';
import { cloneWorkPlane, WORLD_WORK_PLANE } from '../../../math/workplane';
import type { CommandRun, StepOutcome } from '../types';
import { hatchPatternSegments } from '../../../io/DxfHatch';

function explodeEntity(entity: Entity, doc: Document): Entity[] {
  if (entity.type === 'insert') return expandedInsertEntities(entity).map((child) => ({
    ...child,
    id: genId(child.type),
    selected: false,
  }));
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
    const pieces = explodeEntity(entity, ctx.doc);
    const solidPieces = entity.type === 'insert'
      ? expandedInsertSolids(entity).map((solid) => ({
        ...cloneSolidValue(solid),
        id: genId('solid'),
        selected: false,
      }))
      : [];
    if (pieces.length + solidPieces.length === 0) {
      ctx.log(`EXPLODE: ${entity.type} is already a primitive object.`);
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
