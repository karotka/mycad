/**
 * Taking something apart: a rectangle into its four lines, a boolean solid back
 * into the parts it was made of.
 *
 * The solid half only works because the feature tree kept how it was built — it
 * regenerates each operand rather than trying to cut a mesh apart, which is not
 * a thing anyone can do. That is the model history earning its keep.
 */
import { ReplaceObjectsEdit } from '../../history/edits';
import { closedVertices, curvePoints, type Entity, type Solid, type SolidFeature } from '../../entities/types';
import { regenerateSolidFeature } from '../../solids/ManifoldEngine';
import type { Document } from '../../Document';
import { dist2, type Vec2 } from '../../../math/geometry';
import { cloneWorkPlane, WORLD_WORK_PLANE } from '../../../math/workplane';
import type { CommandRun, StepOutcome } from '../types';

function explodeEntity(entity: Entity, doc: Document): Entity[] {
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
    const line = doc.createLine(points[index], points[(index + 1) % points.length], entity.color);
    line.layer = entity.layer;
    line.workPlane = cloneWorkPlane(entity.workPlane ?? WORLD_WORK_PLANE);
    result.push(line);
  }
  return result;
}

export async function explodeObjects(run: CommandRun): Promise<StepOutcome> {
  const { data, value, ctx } = run;
  if (run.gather(value)) return 'stay';

  const removedEntities: Entity[] = [];
  const removedSolids: Solid[] = [];
  const parts: Entity[] = [];
  const solidParts: Solid[] = [];

  for (const entity of data.entities as Entity[]) {
    const pieces = explodeEntity(entity, ctx.doc);
    if (pieces.length === 0) {
      ctx.log(`EXPLODE: ${entity.type} is already a primitive object.`);
      continue;
    }
    removedEntities.push(entity);
    parts.push(...pieces);
  }

  for (const solid of data.solids as Solid[]) {
    // Only a boolean has parts to give back. Everything else is one shape, and
    // a mesh has forgotten whether it ever was more than that.
    if (solid.feature.kind !== 'boolean') {
      ctx.log(`EXPLODE: ${solid.name} is not a boolean compound solid.`);
      continue;
    }
    const before = solidParts.length;
    for (const [index, feature] of solid.feature.operands.entries()) {
      const mesh = await regenerateSolidFeature(feature);
      if (!mesh) continue;
      const part = ctx.doc.createSolid(
        mesh, `${solid.name}_part_${index + 1}`, solid.height, solid.sourceEntityIds, solid.color,
        JSON.parse(JSON.stringify(feature)) as SolidFeature,
      );
      part.layer = solid.layer;
      solidParts.push(part);
    }
    if (solidParts.length > before) removedSolids.push(solid);
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
