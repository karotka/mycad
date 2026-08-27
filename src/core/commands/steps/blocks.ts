/** Native named blocks: turn drawing objects into one reusable INSERT, or place
 * another reference to a definition already stored in the document. */
import { cloneEntity, cloneSolidValue, type BlockDefinition, type Entity, type InsertEntity, type Solid } from '../../entities/types';
import { AddEntityEdit, CompositeEdit, ReplaceObjectsEdit, SetBlockDefinitionsEdit } from '../../history/edits';
import { cloneWorkPlane, localToWorld, worldToLocal, WORLD_WORK_PLANE, type WorkPlane } from '../../../math/workplane';
import type { Vec2, Vec3 } from '../../../math/geometry';
import type { CommandContext, CommandRun, StepOutcome } from '../types';
import type { Document } from '../../Document';

type SpatialPoint = Vec2 & { z?: number };

function sameWorkPlane(a: WorkPlane, b: WorkPlane, tolerance = 1e-8): boolean {
  const close = (x: number, y: number): boolean => Math.abs(x - y) <= tolerance;
  return close(a.origin.x, b.origin.x) && close(a.origin.y, b.origin.y) && close(a.origin.z, b.origin.z)
    && close(a.xAxis.x, b.xAxis.x) && close(a.xAxis.y, b.xAxis.y) && close(a.xAxis.z, b.xAxis.z)
    && close(a.yAxis.x, b.yAxis.x) && close(a.yAxis.y, b.yAxis.y) && close(a.yAxis.z, b.yAxis.z)
    && close(a.zAxis.x, b.zAxis.x) && close(a.zAxis.y, b.zAxis.y) && close(a.zAxis.z, b.zAxis.z);
}

function namedDefinition(definitions: readonly BlockDefinition[], name: string): BlockDefinition | undefined {
  const key = name.trim().toUpperCase();
  return definitions.find((definition) => definition.name.toUpperCase() === key);
}

function pointInPlane(point: SpatialPoint, source: WorkPlane, target: WorkPlane): Vec3 {
  const world = localToWorld(source, point, point.z ?? 0);
  return worldToLocal(target, world);
}

function selectOnlyInsert(run: CommandRun, insert: InsertEntity): void {
  run.ctx.doc.clearSelection();
  run.ctx.doc.selectEntity(insert.id);
}

export function createBlock(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;

  if (active.stepIndex === 0) {
    if (run.gather(value)) return 'stay';
    const entities = data.entities as Entity[];
    const solids = data.solids as Solid[];
    if (entities.length + solids.length === 0) {
      ctx.log('BLOCK: select at least one drawing object or 3D solid.');
      return 'stay';
    }
    return 'advance';
  }

  if (active.stepIndex === 1) {
    const name = String(value ?? '').trim();
    if (!name || /[\0\r\n]/.test(name)) {
      ctx.log('BLOCK: enter a valid block name.');
      return 'stay';
    }
    if (namedDefinition(ctx.doc.blockDefinitions, name)) {
      ctx.log(`BLOCK: a block named ${name} already exists.`);
      return 'stay';
    }
    data.blockName = name;
    return 'advance';
  }

  const entities = data.entities as Entity[];
  const solids = data.solids as Solid[];
  const name = data.blockName as string;
  const plane = cloneWorkPlane(entities[0]?.workPlane ?? ctx.doc.activeWorkPlane);
  if (entities.some((entity) => !sameWorkPlane(entity.workPlane ?? WORLD_WORK_PLANE, plane))) {
    ctx.log('BLOCK: all selected objects must lie in the same UCS/work plane.');
    return 'stay';
  }

  const local = pointInPlane(value as SpatialPoint, ctx.doc.activeWorkPlane, plane);
  const basePoint: SpatialPoint = {
    x: local.x,
    y: local.y,
    ...(Math.abs(local.z) > 1e-12 ? { z: local.z } : {}),
  };
  const definition: BlockDefinition = {
    name,
    basePoint,
    workPlane: cloneWorkPlane(plane),
    entities: entities.map((entity) => ({ ...cloneEntity(entity), selected: false })),
    solids: solids.map((solid) => ({ ...cloneSolidValue(solid), selected: false })),
  };
  const insert = ctx.doc.createInsert(definition, basePoint);
  insert.workPlane = cloneWorkPlane(plane);

  ctx.history.execute(new CompositeEdit(`Create block ${name}`, [
    new SetBlockDefinitionsEdit(`Define block ${name}`, ctx.doc.blockDefinitions, [...ctx.doc.blockDefinitions, definition]),
    new ReplaceObjectsEdit(`Replace objects with block ${name}`, entities, solids, [insert], []),
  ]));
  selectOnlyInsert(run, insert);
  ctx.log(`Block ${name} created from ${entities.length + solids.length} object(s).`);
  return 'advance';
}

export function insertBlock(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;

  if (active.stepIndex === 0) {
    const requested = String(value ?? '').trim();
    const definition = namedDefinition(ctx.doc.blockDefinitions, requested);
    if (!definition) {
      const available = ctx.doc.blockDefinitions.map((item) => item.name).join(', ');
      ctx.log(available
        ? `INSERT: block ${requested || '(empty)'} not found. Available: ${available}.`
        : 'INSERT: the drawing contains no block definitions.');
      return 'stay';
    }
    data.definition = definition;
    data.blockName = definition.name;
    data.previewInsert = ctx.doc.createInsert(definition, definition.basePoint);
    return 'advance';
  }

  if (active.stepIndex === 1) {
    const point = value as SpatialPoint;
    data.position = { x: point.x, y: point.y, ...(point.z === undefined ? {} : { z: point.z }) };
    return 'advance';
  }

  if (active.stepIndex === 2) {
    const [scaleX, scaleY] = value as [number, number];
    if (![scaleX, scaleY].every((item) => Number.isFinite(item) && Math.abs(item) > 1e-9)) {
      ctx.log('INSERT: X and Y scale must be non-zero numbers.');
      return 'stay';
    }
    data.scale = [scaleX, scaleY];
    return 'advance';
  }

  const definition = data.definition as BlockDefinition;
  const position = data.position as Vec2;
  const [scaleX, scaleY] = data.scale as [number, number];
  const rotation = value == null ? 0 : Number(value);
  if (!Number.isFinite(rotation)) {
    ctx.log('INSERT: rotation must be a number in degrees.');
    return 'stay';
  }
  const insert = ctx.doc.createInsert(definition, position);
  insert.scaleX = scaleX;
  insert.scaleY = scaleY;
  insert.rotation = rotation * Math.PI / 180;
  ctx.history.execute(new AddEntityEdit(`Insert block ${definition.name}`, insert));
  selectOnlyInsert(run, insert);
  ctx.log(`Inserted block ${definition.name}.`);
  return 'advance';
}

/**
 * Block definitions can reference each other (a fixture block nesting a hinge
 * block, say), so a definition can show zero direct placements yet still be
 * kept alive by another definition that is itself dead — a chain unreachable
 * from anything actually in the drawing, each link "in use" only by the next.
 * This walks out from the real placements to find every definition that
 * chain can reach, and purges whatever is left over in one undoable step.
 */
function reachableBlockKeys(doc: Document): Set<string> {
  const reachable = new Set<string>();
  const visit = (entities: Entity[]): void => {
    for (const entity of entities) {
      if (entity.type !== 'insert') continue;
      const key = entity.blockName.trim().toUpperCase();
      if (reachable.has(key)) continue; // already walked — also guards a reference cycle
      reachable.add(key);
      const definition = namedDefinition(doc.blockDefinitions, entity.blockName);
      if (definition) visit(definition.entities);
    }
  };
  visit(doc.entities);
  return reachable;
}

export function purgeUnreachableBlocks(ctx: CommandContext): void {
  const reachable = reachableBlockKeys(ctx.doc);
  const before = ctx.doc.blockDefinitions;
  const after = before.filter((definition) => reachable.has(definition.name.trim().toUpperCase()));
  const removed = before.length - after.length;
  if (removed === 0) { ctx.log('PURGEBLOCKS: every block definition is reachable from the drawing.'); return; }
  ctx.history.execute(new SetBlockDefinitionsEdit(`Purge ${removed} unreachable block(s)`, before, after));
  ctx.log(`PURGEBLOCKS: removed ${removed} block definition(s) not reachable from anything placed in the drawing.`);
}
