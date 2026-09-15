/**
 * The commands that answer a question instead of changing the drawing.
 *
 * DIST measures between two points, LIST says what an object is, MASSPROP says
 * what a solid weighs up to. None of them touches the document, so none of them
 * goes through the history — they write to the command log and stop.
 *
 * All three are thin over things the application already computes: the point
 * steps come with every snap, `entityToPaths` walks any entity's outline, and
 * the kernel's own inspection already carries volume and centre of mass because
 * SLICE needs the latter to name its halves.
 */
import type { Vec2, Vec3 } from '../../../math/geometry';
import { localToWorld } from '../../../math/workplane';
import { entityToPaths } from '../../entities/paths';
import { entityBounds, type Entity, type Solid } from '../../entities/types';
import { openExactShape, promoteSolidToExact } from '../../geometry/ExactSolid';
import { openCascadeKernel } from '../../geometry/OpenCascadeRuntime';
import type { CommandRun, StepOutcome } from '../types';

/** Four decimals: enough to read a millimetre drawing to a micron, and not so
 *  many that the answer is mostly floating-point noise. */
const format = (value: number): string => Number(value.toFixed(4)).toString();

/** A point as the user gave it, lifted into world coordinates so the answer is
 *  about the drawing rather than about whatever UCS is current. */
function worldPoint(run: CommandRun, point: Vec2 & { z?: number }): Vec3 {
  return localToWorld(run.ctx.doc.activeWorkPlane, point, point.z ?? 0);
}

/**
 * DIST: how far apart two points are, which way round, and by how much on each
 * axis — AutoCAD's own four numbers. Nothing is drawn; MEASURE is the one that
 * leaves a dimension behind.
 */
export function measurePointDistance(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) { data.start = value; return 'advance'; }
  const start = worldPoint(run, data.start as Vec2);
  const end = worldPoint(run, value as Vec2);
  const delta = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
  const planar = Math.hypot(delta.x, delta.y);
  const angleXY = ((Math.atan2(delta.y, delta.x) * 180 / Math.PI) + 360) % 360;
  // The angle out of the XY plane, which is what tells a 3D pick from a flat one.
  const angleFromXY = Math.atan2(delta.z, planar) * 180 / Math.PI;
  ctx.log(`Distance = ${format(Math.hypot(delta.x, delta.y, delta.z))}`
    + `, Angle in XY plane = ${format(angleXY)}°, Angle from XY plane = ${format(angleFromXY)}°`);
  ctx.log(`Delta X = ${format(delta.x)}, Delta Y = ${format(delta.y)}, Delta Z = ${format(delta.z)}`);
  return 'advance';
}

/** The drawn length of an entity, following its curves rather than its chords. */
export function entityLength(entity: Entity): number {
  let total = 0;
  for (const path of entityToPaths(entity, 96)) {
    const points = path.closed && path.points.length > 1 ? [...path.points, path.points[0]] : path.points;
    for (let index = 0; index + 1 < points.length; index++) {
      total += Math.hypot(points[index + 1].x - points[index].x, points[index + 1].y - points[index].y);
    }
  }
  return total;
}

/** The area an entity encloses, or null when it encloses nothing. */
export function entityArea(entity: Entity): number | null {
  const closed = entityToPaths(entity, 96).filter((path) => path.closed && path.points.length >= 3);
  if (closed.length === 0) return null;
  let total = 0;
  for (const path of closed) {
    let sum = 0;
    for (let index = 0; index < path.points.length; index++) {
      const a = path.points[index], b = path.points[(index + 1) % path.points.length];
      sum += a.x * b.y - b.x * a.y;
    }
    total += Math.abs(sum) / 2;
  }
  return total;
}

/**
 * What LIST prints for one object: what it is, where it sits, and the two
 * numbers a drawing is usually being asked for. Kept as lines rather than one
 * string so a caller can put them wherever it likes.
 */
export function describeObject(object: Entity | Solid): string[] {
  if (!('type' in object)) {
    const bounds = solidExtent(object);
    return [
      `3D SOLID  ${object.name}`,
      `  Layer: ${object.layer}    Colour: #${object.color.toString(16).padStart(6, '0')}    Feature: ${object.feature.kind}`,
      `  Bounding box: ${format(bounds.size.x)} x ${format(bounds.size.y)} x ${format(bounds.size.z)}`
      + `  from (${format(bounds.min.x)}, ${format(bounds.min.y)}, ${format(bounds.min.z)})`,
    ];
  }
  const bounds = entityBounds(object);
  const lines = [
    `${object.type.toUpperCase()}  ${object.id}`,
    `  Layer: ${object.layer}    Colour: #${object.color.toString(16).padStart(6, '0')}`
    + (object.linetypeScale !== undefined ? `    Linetype scale: ${format(object.linetypeScale)}` : ''),
  ];
  const specific = entitySpecifics(object);
  if (specific) lines.push(`  ${specific}`);
  const length = entityLength(object);
  if (length > 0) lines.push(`  Length: ${format(length)}`);
  const area = entityArea(object);
  if (area !== null) lines.push(`  Area: ${format(area)}`);
  lines.push(`  Extents: (${format(bounds.min.x)}, ${format(bounds.min.y)}) to (${format(bounds.max.x)}, ${format(bounds.max.y)})`);
  return lines;
}

/** The one line that is about this kind of object and no other. */
function entitySpecifics(entity: Entity): string | null {
  switch (entity.type) {
    case 'line':
      return `From (${format(entity.start.x)}, ${format(entity.start.y)}) to (${format(entity.end.x)}, ${format(entity.end.y)})`;
    case 'circle':
      return `Centre (${format(entity.center.x)}, ${format(entity.center.y)})  Radius ${format(entity.radius)}  Diameter ${format(entity.radius * 2)}`;
    case 'arc':
      return `Centre (${format(entity.center.x)}, ${format(entity.center.y)})  Radius ${format(entity.radius)}`
        + `  Sweep ${format(entity.sweepAngle * 180 / Math.PI)}°`;
    case 'ellipse':
      return `Centre (${format(entity.center.x)}, ${format(entity.center.y)})  Radii ${format(entity.radiusX)} / ${format(entity.radiusY)}`;
    case 'polyline':
      return `${entity.vertices.length} vertices, ${entity.closed ? 'closed' : 'open'}`
        + (entity.bulges?.some((bulge) => Math.abs(bulge) > 1e-9) ? ', with arc segments' : '');
    case 'text':
      return `"${entity.text}"  Height ${format(entity.height)}`;
    case 'insert':
      return `Block "${entity.blockName}"  at (${format(entity.position.x)}, ${format(entity.position.y)})  Scale ${format(entity.scaleX)} / ${format(entity.scaleY)}`;
    case 'dimension':
      return `${entity.dimensionKind} dimension  Text height ${format(entity.textHeight)}`;
    default:
      return null;
  }
}

function solidExtent(solid: Solid): { min: Vec3; size: Vec3 } {
  const positions = solid.mesh.positions;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let index = 0; index + 2 < positions.length; index += 3) {
    min.x = Math.min(min.x, positions[index]); max.x = Math.max(max.x, positions[index]);
    min.y = Math.min(min.y, positions[index + 1]); max.y = Math.max(max.y, positions[index + 1]);
    min.z = Math.min(min.z, positions[index + 2]); max.z = Math.max(max.z, positions[index + 2]);
  }
  return { min, size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z } };
}

/** LIST: what the selected objects are, in the command log. */
export function listObjects(run: CommandRun): StepOutcome {
  const { value, data, ctx } = run;
  if (run.gather(value)) return 'stay';
  const entities = (data.entities as Entity[] | undefined) ?? [];
  const solids = (data.solids as Solid[] | undefined) ?? [];
  if (entities.length + solids.length === 0) {
    ctx.log('LIST: select at least one object.');
    return 'stay';
  }
  for (const object of [...entities, ...solids]) for (const line of describeObject(object)) ctx.log(line);
  return 'advance';
}

/**
 * MASSPROP: volume, centre of mass and extent of the selected solids, from the
 * exact geometry rather than from the tessellation — a faceted sphere is a few
 * per cent light, which is exactly the sort of error a mass property is asked
 * for in order to avoid.
 */
export async function solidMassProperties(run: CommandRun): Promise<StepOutcome> {
  const { value, data, ctx } = run;
  if (run.gather(value)) return 'stay';
  const solids = (data.solids as Solid[] | undefined) ?? [];
  if (solids.length === 0) {
    ctx.log('MASSPROP: select at least one 3D solid.');
    return 'stay';
  }
  const kernel = await openCascadeKernel();
  let totalVolume = 0;
  for (const solid of solids) {
    if (!await promoteSolidToExact(solid)) {
      ctx.log(`${solid.name}: no exact geometry to measure.`);
      continue;
    }
    const shape = await openExactShape(solid, kernel);
    if (!shape) {
      ctx.log(`${solid.name}: could not be opened for measurement.`);
      continue;
    }
    try {
      const inspection = kernel.inspect(shape);
      totalVolume += inspection.volume;
      ctx.log(`${solid.name}`);
      ctx.log(`  Volume: ${format(inspection.volume)}`);
      ctx.log(`  Centroid: (${format(inspection.centroid.x)}, ${format(inspection.centroid.y)}, ${format(inspection.centroid.z)})`);
      ctx.log(`  Bounding box: (${format(inspection.bounds.min.x)}, ${format(inspection.bounds.min.y)}, ${format(inspection.bounds.min.z)})`
        + ` to (${format(inspection.bounds.max.x)}, ${format(inspection.bounds.max.y)}, ${format(inspection.bounds.max.z)})`);
      ctx.log(`  Faces: ${inspection.faceCount}    Valid: ${inspection.valid ? 'yes' : 'no'}`);
    } finally {
      shape.dispose();
    }
  }
  if (solids.length > 1) ctx.log(`Total volume: ${format(totalVolume)}`);
  return 'advance';
}
