/**
 * Repeating a selection: in rows and columns, or around a point.
 *
 * The rectangular one asked its four numbers with four copies of the same
 * validation, differing only in the message and in whether the answer had to be
 * a whole number. They are a table now, so the wizard's questions and the rules
 * for them sit together and a fifth cannot be added to only one of the two.
 */
import { ReplaceObjectsEdit } from '../../history/edits';
import type { Entity, Solid } from '../../entities/types';
import { copyEntity, copySolid, rotateEntity, rotateSolidAroundPlane } from './transform';
import { localToWorld, worldToLocal, type WorkPlane } from '../../../math/workplane';
import type { Vec2, Vec3 } from '../../../math/geometry';
import type { CommandRun, StepOutcome } from '../types';

/** A distance in the work plane, as the world sees it. */
function workPlaneDelta(plane: WorkPlane, local: Vec2): Vec3 {
  return {
    x: plane.xAxis.x * local.x + plane.yAxis.x * local.y,
    y: plane.xAxis.y * local.x + plane.yAxis.y * local.y,
    z: plane.xAxis.z * local.x + plane.yAxis.z * local.y,
  };
}

/** The copies, selected, in one undoable step. */
function placeCopies(run: CommandRun, label: string, entities: Entity[], solids: Solid[], message: string): void {
  const { ctx } = run;
  ctx.history.execute(new ReplaceObjectsEdit(label, [], [], entities, solids));
  ctx.doc.clearSelection();
  entities.forEach((entity, index) => ctx.doc.selectEntity(entity.id, index > 0));
  solids.forEach((solid) => ctx.doc.selectSolid(solid.id, true));
  ctx.log(message);
}

interface NumberField {
  key: string;
  /** Whole numbers for counts; a spacing may be any positive distance. */
  whole: boolean;
  least: number;
  refusal: string;
}

const RECTANGULAR: NumberField[] = [
  { key: 'rows', whole: true, least: 1, refusal: 'Rows must be an integer greater than zero.' },
  { key: 'columns', whole: true, least: 1, refusal: 'Columns must be an integer greater than zero.' },
  { key: 'rowSpacing', whole: false, least: 1e-9, refusal: 'Row spacing must be greater than zero.' },
  { key: 'columnSpacing', whole: false, least: 1e-9, refusal: 'Column spacing must be greater than zero.' },
];

/** Writes the answer into `data`, or says why it will not. */
function takeNumber(run: CommandRun, field: NumberField): boolean {
  const answer = Number(run.value);
  if (!Number.isFinite(answer) || (field.whole && !Number.isInteger(answer)) || answer < field.least) {
    run.ctx.log(field.refusal);
    return false;
  }
  run.data[field.key] = answer;
  return true;
}

export function arrayRectangular(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) return run.gather(value) ? 'stay' : 'advance';

  const field = RECTANGULAR[active.stepIndex - 1];
  if (!field) return 'advance';
  if (!takeNumber(run, field)) return 'stay';
  if (active.stepIndex < RECTANGULAR.length) return 'advance';

  const rows = data.rows as number;
  const columns = data.columns as number;
  const originals = data.entities as Entity[];
  const originalSolids = data.solids as Solid[];
  const entities: Entity[] = [];
  const solids: Solid[] = [];
  const plane = ctx.doc.activeWorkPlane;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      // The first cell is where the originals already are.
      if (row === 0 && column === 0) continue;
      const local = { x: column * (data.columnSpacing as number), y: row * (data.rowSpacing as number) };
      entities.push(...originals.map((entity) => copyEntity(entity, local)));
      solids.push(...originalSolids.map((solid) => copySolid(solid, workPlaneDelta(plane, local))));
    }
  }
  placeCopies(run, 'Rectangular array', entities, solids, `Created rectangular array: ${rows} x ${columns}.`);
  return 'advance';
}

export function arrayPolar(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) return run.gather(value) ? 'stay' : 'advance';
  if (active.stepIndex === 1) { data.center = value; return 'advance'; }
  if (active.stepIndex === 2) {
    // Two is the fewest that is an array rather than the thing you started with.
    return takeNumber(run, { key: 'count', whole: true, least: 2, refusal: 'Number of items must be an integer greater than one.' })
      ? 'advance' : 'stay';
  }

  const totalAngle = Number(value);
  if (!Number.isFinite(totalAngle) || Math.abs(totalAngle) <= 1e-9) {
    ctx.log('Total angle must be non-zero.');
    return 'stay';
  }
  const centre = data.center as Vec2;
  const count = data.count as number;
  const originals = data.entities as Entity[];
  const originalSolids = data.solids as Solid[];
  const entities: Entity[] = [];
  const solids: Solid[] = [];
  const plane = ctx.doc.activeWorkPlane;
  const centreLocal = worldToLocal(plane, localToWorld(plane, centre));
  // The angle is the whole sweep, shared out between the copies — so the last
  // one lands on it rather than one step short.
  for (let index = 1; index < count; index++) {
    const angle = (totalAngle * Math.PI / 180) * (index / (count - 1));
    entities.push(...originals.map((entity) => rotateEntity(copyEntity(entity, { x: 0, y: 0 }), centre, angle, ctx.doc)));
    solids.push(...originalSolids.map((solid) => rotateSolidAroundPlane(copySolid(solid, { x: 0, y: 0, z: 0 }), centreLocal, angle, plane)));
  }
  placeCopies(run, 'Polar array', entities, solids, `Created polar array: ${count} items over ${totalAngle.toFixed(3)}°.`);
  return 'advance';
}
