/**
 * The one place a command is declared.
 *
 * Everything that used to be a hand-maintained parallel list — the CommandName
 * union, the alias table, the autocomplete order, which tools restart, which
 * tools take snapped viewport points — is derived from this array. `CommandName`
 * itself is inferred from it, so adding an entry here is what makes a command
 * exist; forgetting to register one is a type error rather than a silent gap.
 */
import { cloneEntity, expandedInsertSolids, isOffsetEntity, isSweepProfileEntity, type Entity } from '../entities/types';
import type { ActiveCommand, CommandContext, CommandRun, CommandStep, StepOutcome } from './types';
import { drawArc, drawArcStartEndRadius, drawBezier, drawCircle, drawCircleByDiameter, drawEllipse, drawLine, drawOctagon, drawPolygon, drawPolyline, drawRectangle, drawSpline, drawText } from './steps/draw';
import { createBox, createCone, createCylinder, createPyramid, createSphere, createTorus, createWedge } from './steps/solids';
import { intersectSolids, subtractSolids, unionSolids } from './steps/booleans';
import { copyObjects, eraseObjects, mirrorObjects, moveObjects, rotateObjects, scaleObjects } from './steps/transform';
import { measureAngle, measureDistance, measureRadius, quickDimension, setWorkPlane } from './steps/dimensions';
import { explodeObjects } from './steps/explode';
import { deleteFaceStep, extrudeProfileStep, modifyEdgeStep, pressPullStep, sweepProfileStep } from './steps/solidOps';
import { extendEntity, joinObjects, offsetEntity, simplifyEntity, trimEntity } from './steps/edit2d';
import { createThread } from './steps/thread';
import { arrayPolar, arrayRectangular } from './steps/array';
import { exportStepSelection, exportStlSelection } from './steps/export';
import { selectPrintArea } from './steps/print';
import { sliceSolids } from './steps/slice';
import { createBlock, insertBlock, purgeUnreachableBlocks } from './steps/blocks';
import { removeGeometricDuplicates } from './steps/overkill';
import { changeToCurrentLayer, hideSelectedObjects, isolateSelectedObjects, showAllObjects } from './steps/objectVisibility';
import { optimizeDrawingPathsCommand } from './steps/optimizePaths';
import { createHatch } from './steps/hatch';
import { editText } from './steps/textEdit';
import { measureArea } from './steps/area';

/**
 * Dragging the text off the middle of the dimension line, for when the line is
 * too short to hold it. Optional because that is the unusual case: Enter leaves
 * the text centred and is the quick way through.
 */
const DIMENSION_TEXT_STEP: CommandStep = {
  kind: 'point',
  label: 'Specify text location (Enter to keep it centred):',
  optional: true,
  // Where the text sits is a placement, not a direction from the points.
  ignoresDirection: true,
};

/**
 * Takes the objects already selected into the command's first step and skips it,
 * so picking a tool after selecting does not ask for the selection again.
 */
function preselectObjects(
  message: (count: number) => string,
  options: { skipStep?: boolean } = {},
): (active: ActiveCommand, ctx: CommandContext) => void {
  return (active, ctx) => {
    const entities = ctx.doc.getSelectedEntities();
    const solids = ctx.doc.getSelectedSolids();
    const count = entities.length + solids.length;
    if (count === 0) return;
    active.data.entities = [...entities];
    active.data.solids = [...solids];
    if (options.skipStep !== false) active.stepIndex = 1;
    ctx.log(message(count));
  };
}

/**
 * Takes one preselected object — an entity or a solid id — for a command that
 * acts on a single object. With several selected there is no right one to pick,
 * so it asks rather than guessing.
 */
function preselectSingleObject(key: string, message: string): (active: ActiveCommand, ctx: CommandContext) => void {
  return (active, ctx) => {
    const entities = ctx.doc.getSelectedEntities();
    const solids = ctx.doc.getSelectedSolids();
    if (entities.length + solids.length !== 1) return;
    active.data[key] = entities[0] ?? solids[0].id;
    active.stepIndex = 1;
    ctx.log(message);
  };
}

/** Takes a single preselected object into `key` and skips the step asking for it. */
function preselectOne(
  key: string,
  matches: (entity: Entity) => boolean,
  message: string,
): (active: ActiveCommand, ctx: CommandContext) => void {
  return (active, ctx) => {
    const found = ctx.doc.getSelectedEntities().find(matches);
    if (!found) return;
    active.data[key] = found;
    active.stepIndex = 1;
    if (message) ctx.log(message);
  };
}

interface CommandDefShape {
  readonly name: string;
  /** Every string that starts this command when typed. First is the canonical short form. */
  readonly aliases: readonly string[];
  /**
   * The wizard the command walks through. Commands still carrying their steps
   * in the CommandManager switch leave this out; the switch handles those until
   * they move across.
   */
  readonly steps?: readonly CommandStep[];
  /** Fresh mutable state for one run. Must return a new object each time. */
  readonly data?: (ctx: CommandContext) => Record<string, unknown>;
  /**
   * Runs once the wizard is built, to take the existing selection into account:
   * fill `data` and skip the step that would have asked for it again.
   */
  readonly onStart?: (active: ActiveCommand, ctx: CommandContext) => void;
  /**
   * What each answer means. The manager runs the wizard — prompts, step index,
   * sticky restarts — and this decides only what to do with what it was given.
   *
   * Left out, the command's behaviour is still a case in `CommandManager`'s
   * `advanceStep` switch, which is being emptied a batch at a time. There is no
   * difference in what they can do; a case is just further from its own
   * declaration.
   */
  readonly execute?: (run: CommandRun) => StepOutcome | Promise<StepOutcome>;
  /**
   * A command that acts at once and has no wizard — toggling a mode, undo, help.
   * Mutually exclusive with `steps`.
   */
  readonly run?: (ctx: CommandContext) => void;
  /** One-line description for HELP. Commands without one stay undocumented. */
  readonly help?: string;
  /**
   * Offered by the command-line autocomplete, in the order declared below.
   * ERASE is deliberately excluded so a destructive command must be typed out,
   * and the view/system commands are not drawing tools.
   */
  readonly suggest?: boolean;
  /** Restarts itself after finishing, until Escape or another command is chosen. */
  readonly sticky?: boolean;
  /** Point steps take a snapped pick from the viewport. */
  readonly pointInput?: boolean;
  /** Acts on existing objects, so a picked point is also tracked in world space. */
  readonly transformsObjects?: boolean;
}

// Declaration order is the autocomplete order.
export const COMMANDS = [
  { name: 'LINE', aliases: ['L', 'LINE'], help: 'draw line', suggest: true, sticky: true, pointInput: true, execute: drawLine, steps: [{ kind: 'point', label: 'Specify first point:' }, { kind: 'point', label: 'Specify second point:' }, { kind: 'done' }] },
  { name: 'POLYLINE', aliases: ['PL', 'PLINE', 'POLYLINE'], execute: drawPolyline, help: 'draw a connected polyline', suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify start point:' }, { kind: 'point', label: 'Specify next point (Enter to finish, C to close):', optional: true }, { kind: 'done' }], data: () => ({ vertices: [] }) },
  { name: 'RECTANGLE', aliases: ['R', 'REC', 'RECTANGLE'], help: 'draw rectangle', suggest: true, sticky: true, pointInput: true, execute: drawRectangle, steps: [{ kind: 'point', label: 'Specify first rectangle corner:' }, { kind: 'point', label: 'Specify opposite corner:', ignoresDirection: true }, { kind: 'done' }] },
  { name: 'CIRCLE', aliases: ['C', 'CIRCLE'], help: 'draw circle', suggest: true, sticky: true, pointInput: true, execute: drawCircle, steps: [{ kind: 'point', label: 'Specify circle center:' }, { kind: 'point', label: 'Specify radius or point on circumference:', rememberDistanceFrom: 'center' }, { kind: 'done' }] },
  { name: 'CIRCLE_DIAMETER', aliases: ['CD', 'CIRCLEDIAMETER'], help: 'draw circle by diameter', suggest: true, sticky: true, pointInput: true, execute: drawCircleByDiameter,
    steps: [{ kind: 'point', label: 'Specify circle center:' }, { kind: 'point', label: 'Specify diameter or a point at that distance:', rememberDistanceFrom: 'center' }, { kind: 'done' }] },
  { name: 'ELLIPSE', aliases: ['EL', 'ELLIPSE'], help: 'draw ellipse', suggest: true, sticky: true, pointInput: true, execute: drawEllipse,
    steps: [{ kind: 'point', label: 'Specify ellipse center:' }, { kind: 'point', label: 'Specify first axis endpoint:' }, { kind: 'point', label: 'Specify second axis distance:' }, { kind: 'done' }] },
  { name: 'POLYGON', aliases: ['P', 'POL', 'POLYGON'], execute: drawPolygon, help: 'draw regular polygon', suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify polygon center:' }, { kind: 'number', label: 'Enter number of sides:' }, { kind: 'point', label: 'Specify perpendicular distance to side:' }, { kind: 'done' }] },
  { name: 'ARC', aliases: ['A', 'ARC'], execute: drawArc, suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify arc center:' }, { kind: 'point', label: 'Specify start point:' }, { kind: 'point', label: 'Specify end point or angle:' }, { kind: 'done' }] },
  { name: 'ARC_SER', aliases: ['ASER', 'ARC_SER'], execute: drawArcStartEndRadius, help: 'draw arc by start point, end point, radius', suggest: true, sticky: true, pointInput: true,
    steps: [
      { kind: 'point', label: 'Specify arc start point:' },
      { kind: 'point', label: 'Specify arc end point:' },
      { kind: 'point', label: 'Specify point on arc, or type a radius:' },
      { kind: 'done' },
    ] },
  // Spline (CV): control points shape the curve without it passing through
  // them, same idea as AutoCAD's control-vertex SPLINE — here as a chain of
  // cubic Bezier segments, the first one 4 points, each further one 3 more.
  { name: 'BEZIER', aliases: ['BEZ', 'BEZIER'], execute: drawBezier, help: 'draw a spline by control points (does not pass through them)', suggest: true, sticky: true, pointInput: true,
    steps: [
      { kind: 'point', label: 'Specify start point:' },
      { kind: 'point', label: 'Specify first control point:' },
      { kind: 'point', label: 'Specify second control point:' },
      { kind: 'point', label: 'Specify end point:' },
      { kind: 'point', label: 'Specify next control point (2 more to continue, Enter to finish):', optional: true },
      { kind: 'done' },
    ] },
  // Spline (Fit): the curve passes through every clicked point.
  { name: 'SPLINE', aliases: ['SPL', 'SPLINE'], execute: drawSpline, help: 'draw a smooth curve through clicked points', suggest: true, sticky: true, pointInput: true,
    steps: [{ kind: 'point', label: 'Specify first point:' }, { kind: 'point', label: 'Specify next point (Enter to finish):', optional: true }, { kind: 'done' }],
    data: () => ({ points: [] }) },
  { name: 'TEXT', aliases: ['T', 'TEXT'], execute: drawText, suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'text', label: 'Select font:' }, { kind: 'number', label: 'Enter text height in mm:' }, { kind: 'point', label: 'Specify text insertion point:' }, { kind: 'text', label: 'Enter text:' }, { kind: 'done' }] },
  // Same entity, same steps as TEXT — creating one is only different in that
  // the final step answers from the on-canvas multi-line editor (see
  // syncMtextEditor in main.ts) instead of the single-line command input.
  { name: 'MTEXT', aliases: ['MT', 'MTEXT'], execute: drawText, help: 'draw multi-line text', suggest: true, pointInput: true, steps: [{ kind: 'text', label: 'Select font:' }, { kind: 'number', label: 'Enter text height in mm:' }, { kind: 'point', label: 'Specify text insertion point:' }, { kind: 'text', label: 'Enter text:' }, { kind: 'done' }] },
  { name: 'TEXTEDIT', aliases: ['ED', 'DDEDIT', 'TEXTEDIT'], execute: editText, help: 'edit TEXT, DTEXT or MTEXT content', suggest: true,
    steps: [{ kind: 'entity', label: 'Select text object:' }, { kind: 'text', label: 'Edit text:' }, { kind: 'done' }],
    data: () => ({}),
    onStart: (active, ctx) => {
      const text = ctx.doc.getSelectedEntities().find((entity) => entity.type === 'text');
      if (!text) return;
      active.data.textEntity = cloneEntity(text);
      active.stepIndex = 1;
      ctx.prefillCommandInput?.(text.text);
      ctx.log('Text selected for editing.');
    } },
  { name: 'AREA', aliases: ['AA', 'AREA'], execute: measureArea, help: 'measure polygon area and perimeter', suggest: true, pointInput: true,
    steps: [{ kind: 'point', label: 'Specify first corner point:' }, { kind: 'point', label: 'Specify next point (Enter or click first point to finish):', optional: true }, { kind: 'done' }],
    data: () => ({ vertices: [] }) },
  { name: 'MEASURE', aliases: ['D', 'DI', 'DIM', 'DIMENSION', 'MEASURE'], execute: measureDistance, help: 'dimension the horizontal or vertical distance', suggest: true, sticky: true, pointInput: true,
    steps: [{ kind: 'point', label: 'Select first measurement point:' }, { kind: 'point', label: 'Select second measurement point:' }, { kind: 'point', label: 'Specify dimension line location:', ignoresDirection: true }, DIMENSION_TEXT_STEP, { kind: 'done' }],
    data: (ctx) => ({ dimensionStyle: { ...ctx.doc.dimensionStyle } }) },
  { name: 'DIMALIGNED', aliases: ['DAL', 'DIMALIGNED'], execute: measureDistance, help: 'dimension the true distance between two points', suggest: true, sticky: true, pointInput: true,
    steps: [{ kind: 'point', label: 'Select first measurement point:' }, { kind: 'point', label: 'Select second measurement point:' }, { kind: 'point', label: 'Specify dimension line location:', ignoresDirection: true }, DIMENSION_TEXT_STEP, { kind: 'done' }],
    data: (ctx) => ({ dimensionStyle: { ...ctx.doc.dimensionStyle } }) },
  { name: 'DIMANGULAR', aliases: ['DAN', 'DIMANGULAR'], execute: measureAngle, help: 'dimension the angle between two lines or three points', suggest: true, sticky: true, pointInput: true,
    steps: [
      { kind: 'entity', label: 'Select first line or straight solid edge (Enter for three points):', optional: true, accepts: ['entity', 'edge'] },
      { kind: 'entity', label: 'Select second line or straight solid edge:', accepts: ['entity', 'edge'] },
      { kind: 'point', label: 'Specify angle vertex:' },
      { kind: 'point', label: 'Specify point on first ray:' },
      { kind: 'point', label: 'Specify point on second ray:' },
      { kind: 'point', label: 'Specify dimension arc location:', ignoresDirection: true },
      DIMENSION_TEXT_STEP,
      { kind: 'done' },
    ],
    data: (ctx) => ({ dimensionStyle: { ...ctx.doc.dimensionStyle } }) },
  { name: 'DIMRADIUS', aliases: ['DR', 'DRA', 'DIMRADIUS'], execute: measureRadius, suggest: true, sticky: true, pointInput: true,
    steps: [{ kind: 'entity', label: 'Select circle, arc, or circular solid edge for radius dimension:', accepts: ['entity', 'edge'] }, { kind: 'point', label: 'Specify dimension text location:', ignoresDirection: true }, { kind: 'done' }],
    data: (ctx) => ({ entity: undefined, dimensionStyle: { ...ctx.doc.dimensionStyle } }),
    onStart: preselectOne('entity', (entity) => entity.type === 'circle' || entity.type === 'arc', '') },
  { name: 'DIMDIAMETER', aliases: ['DD', 'DDI', 'DIMDIAMETER'], execute: measureRadius, suggest: true, sticky: true, pointInput: true,
    steps: [{ kind: 'entity', label: 'Select circle, arc, or circular solid edge for diameter dimension:', accepts: ['entity', 'edge'] }, { kind: 'point', label: 'Specify dimension text location:', ignoresDirection: true }, { kind: 'done' }],
    data: (ctx) => ({ entity: undefined, dimensionStyle: { ...ctx.doc.dimensionStyle } }),
    onStart: preselectOne('entity', (entity) => entity.type === 'circle' || entity.type === 'arc', '') },
  { name: 'QDIM', aliases: ['QD', 'QDIM'], execute: quickDimension, help: 'dimension a whole selection at once, in one continuous chain', suggest: true, sticky: true, pointInput: true,
    steps: [
      { kind: 'entity', label: 'Select geometry to dimension, then press Enter:', multi: true, accepts: ['entity'] },
      { kind: 'point', label: 'Specify dimension line location:', ignoresDirection: true },
      { kind: 'done' },
    ],
    data: () => ({ entities: [] }) },
  { name: 'MOVE', aliases: ['MO', 'MOVE'], execute: moveObjects, help: 'move in view plane', suggest: true, pointInput: true, transformsObjects: true, steps: [{ kind: 'entity', label: 'Select object(s) to move, then press Enter:', multi: true, accepts: ['entity', 'solid'] }, { kind: 'point', label: 'Specify base point:' }, { kind: 'point', label: 'Specify target point:' }, { kind: 'done' }],
    data: () => ({ entities: [], solids: [] }),
    onStart: preselectObjects((count) => `${count} object(s) preselected. Specify base point.`) },
  { name: 'COPY', aliases: ['CO', 'CP', 'COPY'], execute: copyObjects, help: 'copy objects repeatedly', suggest: true, pointInput: true, transformsObjects: true,
    steps: [{ kind: 'entity', label: 'Select object(s) to copy, then press Enter:', multi: true, accepts: ['entity', 'solid'] }, { kind: 'point', label: 'Specify base point:' }, { kind: 'point', label: 'Specify target point (Escape to finish):' }, { kind: 'done' }],
    data: () => ({ entities: [], solids: [] }),
    onStart: preselectObjects((count) => `${count} object(s) preselected. Specify base point.`) },
  { name: 'SCALE', aliases: ['SC', 'SCALE'], execute: scaleObjects, help: 'scale objects by a reference length, or a typed factor', suggest: true, pointInput: true, transformsObjects: true,
    steps: [
      { kind: 'entity', label: 'Select object(s) to scale, then press Enter:', multi: true, accepts: ['entity', 'solid'] },
      { kind: 'point', label: 'Specify scale base point:' },
      { kind: 'point', label: 'Specify reference length from the base point:' },
      { kind: 'point', label: 'New length: drag to shrink or grow, or type the length:' },
      { kind: 'done' },
    ],
    data: () => ({ entities: [], solids: [] }),
    onStart: preselectObjects((count) => `${count} object(s) preselected. Specify scale base point.`) },
  // Takes solids, like SCALE beside it. It used to say "2D object(s)" and mean
  // it: a solid could be scaled but not turned, which is not a rule anyone
  // decided, only one command's step that never grew the other's.
  { name: 'ROTATE', aliases: ['RO', 'ROTATE'], execute: rotateObjects, suggest: true, pointInput: true, transformsObjects: true,
    steps: [{ kind: 'entity', label: 'Select object(s) to rotate, then press Enter:', multi: true, accepts: ['entity', 'solid'] }, { kind: 'point', label: 'Specify rotation base point:' }, { kind: 'point', label: 'Specify rotation angle or enter degrees:' }, { kind: 'done' }],
    data: () => ({ entities: [], solids: [] }),
    onStart: preselectObjects((count) => `${count} object(s) preselected. Specify rotation base point.`) },
  { name: 'MIRROR', aliases: ['MI', 'MIRROR'], execute: mirrorObjects, help: 'mirror objects', suggest: true, pointInput: true, transformsObjects: true, steps: [{ kind: 'entity', label: 'Select object(s) — click, then Enter to continue:', multi: true, accepts: ['entity', 'solid'] }, { kind: 'point', label: 'Specify first mirror-axis point:' }, { kind: 'point', label: 'Specify second mirror-axis point:' }, { kind: 'done' }],
    data: () => ({ entities: [], solids: [] }),
    onStart: preselectObjects((count) => `${count} object(s) preselected. Specify first mirror-axis point.`) },
  { name: 'JOIN', aliases: ['J', 'JOIN'], execute: joinObjects, help: 'join connected 2D lines into one polyline', suggest: true,
    steps: [{ kind: 'entity', label: 'Select connected lines or curves, then press Enter:', multi: true }, { kind: 'done' }],
    data: () => ({ entities: [] }),
    onStart: (active, ctx) => {
      const lines = ctx.doc.getSelectedEntities().filter((entity) =>
        entity.type === 'line' || entity.type === 'arc' || entity.type === 'bezier' || entity.type === 'polyline');
      active.data.entities = lines;
      // Too few to join is finishJoin's message to give; it would only be echoed here.
      if (lines.length >= 2) ctx.log(`${lines.length} preselected object(s). Joining selection.`);
    } },
  { name: 'EXPLODE', aliases: ['X', 'EXPLODE'], execute: explodeObjects, help: 'break compound objects into parts', suggest: true,
    steps: [{ kind: 'entity', label: 'Select objects to explode, then press Enter:', multi: true, accepts: ['entity', 'solid'] }, { kind: 'done' }],
    data: () => ({ entities: [], solids: [] }),
    onStart: preselectObjects((count) => `${count} object(s) preselected. Press Enter to explode.`, { skipStep: false }) },
  { name: 'HATCH', aliases: ['HA', 'HATCH'], execute: createHatch, help: 'hatch closed boundaries using the current Hatch settings', suggest: true,
    steps: [{ kind: 'entity', label: 'Select closed boundaries, then press Enter:', multi: true }, { kind: 'done' }],
    data: () => ({ entities: [] }),
    onStart: preselectObjects((count) => `${count} boundary object(s) preselected. Press Enter to hatch.`, { skipStep: false }) },
  { name: 'BLOCK', aliases: ['B', 'BLOCK'], execute: createBlock, help: 'create a named reusable block from 2D objects and 3D solids', suggest: true, pointInput: true,
    steps: [
      { kind: 'entity', label: 'Select objects for block, then press Enter:', multi: true, accepts: ['entity', 'solid'] },
      { kind: 'text', label: 'Enter block name:' },
      { kind: 'point', label: 'Specify block base point:', ignoresDirection: true },
      { kind: 'done' },
    ],
    data: () => ({ entities: [], solids: [] }),
    onStart: (active, ctx) => {
      const entities = ctx.doc.getSelectedEntities();
      const solids = ctx.doc.getSelectedSolids();
      if (entities.length + solids.length === 0) return;
      active.data.entities = [...entities];
      active.data.solids = [...solids];
      active.stepIndex = 1;
      ctx.log(`${entities.length + solids.length} object(s) preselected. Enter block name.`);
    } },
  { name: 'INSERT', aliases: ['I', 'INSERT'], execute: insertBlock, help: 'insert a reference to a named block', suggest: true, pointInput: true,
    steps: [
      { kind: 'text', label: 'Enter block name:' },
      { kind: 'point', label: 'Specify insertion point:', ignoresDirection: true },
      { kind: 'number-pair', label: 'Enter X,Y scale', remember: true, defaultValue: [1, 1] },
      { kind: 'number', label: 'Enter rotation in degrees (Enter = 0):', optional: true },
      { kind: 'done' },
    ] },
  { name: 'PURGEBLOCKS', aliases: ['PURGEBLOCKS'], run: purgeUnreachableBlocks, help: 'delete block definitions not reachable from anything placed in the drawing' },
  { name: 'OVERKILL', aliases: ['OVERKILL', 'OK'], run: removeGeometricDuplicates, help: 'delete objects that exactly duplicate another object’s geometry' },
  { name: 'EXTEND', aliases: ['EX', 'EXTEND'], execute: extendEntity, help: 'extend lines to boundaries', suggest: true,
    steps: [{ kind: 'entity', label: 'Select boundary edges, then press Enter:', multi: true }, { kind: 'entity', label: 'Select object to extend (Enter to finish):', optional: true }, { kind: 'done' }],
    data: () => ({}) },
  { name: 'TRIM', aliases: ['TR', 'TRIM'], execute: trimEntity, help: 'trim objects at cutting edges', suggest: true,
    steps: [{ kind: 'entity', label: 'Select cutting edges, then press Enter:', multi: true }, { kind: 'entity', label: 'Select object to trim (Enter to finish):', optional: true }, { kind: 'done' }],
    data: () => ({}) },
  { name: 'OFFSET', aliases: ['O', 'OFFSET', 'EQUID', 'EKVID'], execute: offsetEntity, help: 'create an equidistant parallel line', suggest: true,
    steps: [{ kind: 'entity', label: 'Select line or closed 2D object to offset:' }, { kind: 'number', label: 'Enter offset distance:', remember: true }, { kind: 'point', label: 'Specify side for offset:' }, { kind: 'done' }],
    data: () => ({ entity: undefined }),
    onStart: preselectOne('entity', isOffsetEntity, 'Object preselected. Enter offset distance.') },
  { name: 'SIMPLIFY', aliases: ['SIMPLIFY', 'REDUCE'], execute: simplifyEntity, help: 'reduce a polyline’s vertex count within a tolerance', suggest: true,
    steps: [{ kind: 'entity', label: 'Select polyline to simplify:' }, { kind: 'number', label: 'Enter tolerance in mm:' }, { kind: 'done' }],
    data: () => ({ entity: undefined }),
    onStart: preselectOne('entity', (entity) => entity.type === 'polyline', 'Object preselected. Enter tolerance.') },
  { name: 'CHAMFER', aliases: ['CHA', 'CHAMFER'], execute: modifyEdgeStep, help: 'chamfer a solid edge, or the corner between two 2D lines', suggest: true,
    steps: [
      { kind: 'entity', label: 'Select solid edge, or first 2D side (line/polyline) to chamfer:', accepts: ['entity', 'edge'] },
      { kind: 'entity', label: 'Select second 2D side (line or polyline):' },
      { kind: 'number-pair', label: 'Enter chamfer distance', remember: true, defaultValue: [1, 1] },
      { kind: 'done' },
    ] },
  { name: 'FILLET', aliases: ['F', 'FILLET'], execute: modifyEdgeStep, help: 'round a solid edge, or the corner between two 2D lines', suggest: true,
    steps: [
      { kind: 'entity', label: 'Select solid edge, or first 2D side (line/polyline) to fillet:', accepts: ['entity', 'edge'] },
      { kind: 'entity', label: 'Select second 2D side (line or polyline):' },
      { kind: 'number', label: 'Enter fillet radius:', remember: true },
      { kind: 'done' },
    ] },
  { name: 'DELETEFACE', aliases: ['DF', 'DELETEFACE'], execute: deleteFaceStep, help: 'delete a solid face and heal the body', suggest: true,
    steps: [{ kind: 'solid', label: 'Select planar solid face to delete:' }, { kind: 'done' }] },
  { name: 'BOX', aliases: ['BX', 'BOX'], execute: createBox, suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify first base corner:' }, { kind: 'point', label: 'Specify opposite base corner:', ignoresDirection: true }, { kind: 'number', label: 'Specify box height:' }, { kind: 'done' }] },
  { name: 'WEDGE', aliases: ['WE', 'WEDGE'], execute: createWedge, suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify first base corner:' }, { kind: 'point', label: 'Specify opposite base corner:', ignoresDirection: true }, { kind: 'number', label: 'Specify wedge height:' }, { kind: 'done' }] },
  { name: 'SPHERE', aliases: ['SPH', 'SPHERE'], execute: createSphere, suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify sphere center:' }, { kind: 'point', label: 'Specify sphere radius:' }, { kind: 'done' }] },
  { name: 'CONE', aliases: ['CONE'], execute: createCone, suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify cone base center:' }, { kind: 'point', label: 'Specify base radius:' }, { kind: 'number', label: 'Specify cone height:' }, { kind: 'done' }] },
  { name: 'CYLINDER', aliases: ['CYL', 'CYLINDER'], execute: createCylinder, suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify cylinder center:' }, { kind: 'point', label: 'Specify radius:' }, { kind: 'number', label: 'Specify cylinder height:' }, { kind: 'done' }] },
  { name: 'PYRAMID', aliases: ['PYR', 'PYRAMID'], execute: createPyramid, suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify pyramid base center:' }, { kind: 'point', label: 'Specify base radius:' }, { kind: 'number', label: 'Specify pyramid height:' }, { kind: 'done' }] },
  { name: 'TORUS', aliases: ['TOR', 'TORUS'], execute: createTorus, suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify torus center:' }, { kind: 'point', label: 'Specify torus radius:' }, { kind: 'number', label: 'Specify tube radius:' }, { kind: 'done' }] },
  { name: 'ARRAY_RECTANGULAR', aliases: ['ARR', 'ARRAY', 'RECTARRAY', 'ARRAYRECTANGULAR', 'RECTANGULAR'], execute: arrayRectangular, help: 'create a rectangular array', suggest: true,
    steps: [{ kind: 'entity', label: 'Select objects to array, then press Enter:', multi: true }, { kind: 'number', label: 'Enter number of rows:' }, { kind: 'number', label: 'Enter number of columns:' }, { kind: 'number', label: 'Enter row spacing:' }, { kind: 'number', label: 'Enter column spacing:' }, { kind: 'done' }],
    data: () => ({ entities: [], solids: [] }),
    onStart: preselectObjects((count) => `${count} object(s) preselected. Enter array size.`) },
  { name: 'ARRAY_POLAR', aliases: ['POLARARRAY', 'ARRAYPOLAR'], execute: arrayPolar, help: 'create a polar array', suggest: true,
    steps: [{ kind: 'entity', label: 'Select objects to array, then press Enter:', multi: true }, { kind: 'point', label: 'Specify array center:' }, { kind: 'number', label: 'Enter number of items:' }, { kind: 'number', label: 'Enter total angle:' }, { kind: 'done' }],
    data: () => ({ entities: [], solids: [], totalAngle: 360 }),
    onStart: preselectObjects((count) => `${count} object(s) preselected. Enter polar array settings.`) },
  { name: 'EXTRUDE', aliases: ['E', 'EXT', 'EXTRUDE'], execute: extrudeProfileStep, help: 'extrude closed profile', suggest: true,
    steps: [
      { kind: 'entity', label: 'Select closed 2D profile(s), then press Enter:', multi: true },
      { kind: 'number-or-option', label: 'Specify extrusion height or [Direction/Path/Taper angle]:', remember: true },
      { kind: 'done' },
    ],
    data: () => ({ entities: [] }),
    onStart: (active, ctx) => {
      const profiles = ctx.doc.getSelectedEntities().filter(isSweepProfileEntity);
      if (profiles.length === 0) return;
      active.data.entities = profiles;
      active.stepIndex = 1;
      ctx.log(`${profiles.length} profile(s) preselected. Specify height or [Direction/Path/Taper angle].`);
    } },
  { name: 'SWEEP', aliases: ['SW', 'SWEEP'], execute: sweepProfileStep, help: 'sweep profile along path', suggest: true,
    steps: [{ kind: 'entity', label: 'Select closed 2D profile:' }, { kind: 'entity', label: 'Select path:' }, { kind: 'done' }],
    data: () => ({ profile: undefined }),
    onStart: preselectOne('profile', isSweepProfileEntity, 'Profile preselected. Select sweep path.') },
  { name: 'PRESSPULL', aliases: ['PP', 'PRESSPULL'], execute: pressPullStep, help: 'modify a planar face region', suggest: true, steps: [{ kind: 'solid', label: 'Select planar face or bounded region:' }, { kind: 'number', label: 'Enter height change (+/-):' }, { kind: 'done' }] },
  { name: 'UNION', aliases: ['U', 'UNI', 'UNION'], execute: unionSolids, help: 'join solids', suggest: true, steps: [{ kind: 'solid', label: 'Select first solid:', additive: true }, { kind: 'solid', label: 'Select second solid:', additive: true }, { kind: 'done' }], data: () => ({ solids: [] }) },
  { name: 'SUBTRACT', aliases: ['S', 'SUB', 'SUBTRACT', 'SUBSTRACT'], execute: subtractSolids, help: 'subtract solids', suggest: true,
    steps: [
      { kind: 'solid', label: 'Select base solid, then press Enter:', additive: true, optional: true },
      { kind: 'solid', label: 'Select solid(s) to subtract, then press Enter:', multi: true },
      { kind: 'done' },
    ],
    data: () => ({ solids: [] }) },
  { name: 'INTERSECT', aliases: ['IN', 'INT', 'INTERSECT'], execute: intersectSolids, help: 'keep the common volume of solids', suggest: true,
    steps: [
      { kind: 'solid', label: 'Select intersecting solids, then press Enter:', multi: true },
      { kind: 'done' },
    ],
    data: () => ({ solids: [] }),
    onStart: (active, ctx) => {
      const solids = ctx.doc.getSelectedSolids();
      if (solids.length < 2) return;
      active.data.solids = [...solids];
      ctx.log(`${solids.length} solids preselected. Press Enter to intersect them.`);
    } },
  { name: 'THREAD', aliases: ['THR', 'THREAD'], execute: createThread, help: 'add a cosmetic thread to a hole or shaft', suggest: true,
    steps: [
      { kind: 'entity', label: 'Select a hole or shaft edge (or a circle) to thread:', accepts: ['entity', 'edge'] },
      { kind: 'text', label: 'Internal or external? I/E [I]:', optional: true },
      { kind: 'text', label: 'Thread size, e.g. M6 (Enter = suggested):', optional: true },
      { kind: 'done' },
    ] },
  { name: 'SLICE', aliases: ['SL', 'SLICE'], execute: sliceSolids, help: 'split solids with a plane', suggest: true, pointInput: true,
    steps: [
      { kind: 'solid', label: 'Select solid(s) to slice, then press Enter:', multi: true },
      { kind: 'plane', label: 'Select a planar face or specify first slice-plane point:' },
      { kind: 'point', label: 'Specify second slice-plane point:', ignoresDirection: true },
      { kind: 'point', label: 'Specify third slice-plane point:', ignoresDirection: true },
      { kind: 'done' },
    ],
    data: () => ({ solids: [] }),
    onStart: (active, ctx) => {
      const solids = ctx.doc.getSelectedSolids();
      if (solids.length === 0) return;
      active.data.solids = [...solids];
      active.stepIndex = 1;
      ctx.log(`${solids.length} solid(s) preselected. Specify the slice plane.`);
    } },
  { name: 'UCS', aliases: ['UCS'], execute: setWorkPlane, suggest: true, steps: [{ kind: 'point', label: 'Select UCS origin vertex:' }, { kind: 'point', label: 'Select a point on the positive X axis:' }, { kind: 'point', label: 'Select a point on the positive Y axis:' }, { kind: 'done' }] },

  // Not offered by autocomplete.
  { name: 'EXPORTSTL', aliases: ['STL', 'EXPORTSTL'], execute: exportStlSelection, help: 'export selected 3D solids or 3D blocks to STL',
    steps: [{ kind: 'entity', label: 'Select 3D solid(s) or block(s) to export, then press Enter:', multi: true, accepts: ['entity', 'solid'] }, { kind: 'done' }],
    data: () => ({ entities: [], solids: [] }),
    onStart: (active, ctx) => {
      const solids = ctx.doc.getSelectedSolids();
      const entities = ctx.doc.getSelectedEntities().filter((entity) => entity.type === 'insert' && expandedInsertSolids(entity).length > 0);
      if (solids.length + entities.length === 0) return;
      active.data.solids = [...solids];
      active.data.entities = [...entities];
      ctx.log(`${solids.length + entities.length} object(s) preselected for STL export.`);
    } },
  { name: 'EXPORTSTEP', aliases: ['STEP', 'EXPORTSTEP'], execute: exportStepSelection, help: 'export selected 3D solids or 3D blocks to STEP',
    steps: [{ kind: 'entity', label: 'Select 3D solid(s) or block(s) to export, then press Enter:', multi: true, accepts: ['entity', 'solid'] }, { kind: 'done' }],
    data: () => ({ entities: [], solids: [] }),
    onStart: (active, ctx) => {
      const solids = ctx.doc.getSelectedSolids();
      const entities = ctx.doc.getSelectedEntities().filter((entity) => entity.type === 'insert' && expandedInsertSolids(entity).length > 0);
      if (solids.length + entities.length === 0) return;
      active.data.solids = [...solids];
      active.data.entities = [...entities];
      ctx.log(`${solids.length + entities.length} object(s) preselected for STEP export.`);
    } },
  { name: 'PRINTAREA', aliases: ['PRINTAREA', 'PLOT'], pointInput: true, execute: selectPrintArea, help: 'pick a window to print to PDF',
    steps: [{ kind: 'point', label: 'Specify first corner of print area:' }, { kind: 'point', label: 'Specify opposite corner:', ignoresDirection: true }, { kind: 'done' }] },
  { name: 'OCTAGON', aliases: ['OCT', 'OCTAGON'], sticky: true, pointInput: true, execute: drawOctagon, steps: [{ kind: 'point', label: 'Specify octagon center:' }, { kind: 'point', label: 'Specify radius (point on circumference):' }, { kind: 'done' }] },
  { name: 'ERASE', aliases: ['ERASE'], execute: eraseObjects, help: 'delete object', steps: [{ kind: 'entity', label: 'Select objects to delete, then press Enter:', multi: true, accepts: ['entity', 'solid'] }, { kind: 'done' }],
    data: () => ({ entities: [], solids: [] }),
    onStart: preselectObjects((count) => `${count} object(s) preselected.`, { skipStep: false }) },
  { name: 'OPTIMIZEPATHS', aliases: ['OP', 'OPTIMIZEPATHS'], help: 'refit and join curves using a geometric tolerance', suggest: true, execute: optimizeDrawingPathsCommand,
    steps: [{ kind: 'number', label: 'Enter fitting and endpoint-joining tolerance in mm (try 0.2, 0.5, or 1):', remember: true }, { kind: 'done' }] },
  { name: 'VIEW2D', aliases: ['V2', 'VIEW2D'], help: '2D view', run: (ctx) => { ctx.doc.viewMode = '2d'; ctx.redraw(); ctx.log('Rezim zobrazeni: 2D'); } },
  { name: 'VIEW3D', aliases: ['V3', 'VIEW3D'], help: '3D view', run: (ctx) => { ctx.doc.viewMode = '3d'; ctx.redraw(); ctx.log('Rezim zobrazeni: 3D'); } },
  { name: 'ZOOM', aliases: ['Z', 'ZOOM'], run: (ctx) => ctx.log('Zoom extents aktivujte tlacitkem ZOOM nebo koleckem mysi.') },
  { name: 'SNAP', aliases: ['SN', 'SNAP'], help: 'toggle snap', run: (ctx) => { ctx.doc.snapEnabled = !ctx.doc.snapEnabled; ctx.log(`Snap: ${ctx.doc.snapEnabled ? 'ON' : 'OFF'}`); } },
  { name: 'UNDO', aliases: ['UNDO'], help: 'undo last edit', run: (ctx) => { ctx.log(ctx.history.undo() ? 'Undo complete.' : 'Nothing to undo.'); ctx.redraw(); } },
  { name: 'REDO', aliases: ['REDO'], help: 'redo last edit', run: (ctx) => { ctx.log(ctx.history.redo() ? 'Redo complete.' : 'Nothing to redo.'); ctx.redraw(); } },
  { name: 'HELP', aliases: ['?', 'H', 'HELP'], help: 'list all commands', run: (ctx) => { for (const line of helpText()) ctx.log(line); } },
  { name: 'HIDEOBJECTS', aliases: ['HIDEOBJECTS', 'HIDE'], help: 'hide selected objects', run: hideSelectedObjects },
  { name: 'ISOLATEOBJECTS', aliases: ['ISOLATEOBJECTS', 'ISOLATE'], help: 'hide all but the selected objects', run: isolateSelectedObjects },
  { name: 'SHOWALL', aliases: ['SHOWALL', 'UNISOLATE'], help: 'show all hidden objects', run: showAllObjects },
  { name: 'LAYCUR', aliases: ['LAYCUR'], help: 'move selected objects to the current layer', run: changeToCurrentLayer },
] as const satisfies readonly CommandDefShape[];

/** Inferred from the array above: registering a command is what makes the name exist. */
export type CommandName = typeof COMMANDS[number]['name'];

export interface CommandDef extends CommandDefShape {
  readonly name: CommandName;
}

/** The same array, widened — `as const` narrows optional fields away per entry. */
export const COMMAND_LIST: readonly CommandDef[] = COMMANDS;

const BY_NAME = new Map<CommandName, CommandDef>(COMMAND_LIST.map((command) => [command.name, command]));

export function commandDef(name: CommandName): CommandDef {
  const def = BY_NAME.get(name);
  if (!def) throw new Error(`Command ${name} is not registered.`);
  return def;
}

export const COMMAND_ALIASES: Record<string, CommandName> = Object.fromEntries(
  COMMAND_LIST.flatMap((command) => command.aliases.map((alias) => [alias, command.name])),
);

export const SUGGESTED_COMMANDS: readonly CommandName[] = COMMAND_LIST
  .filter((command) => command.suggest)
  .map((command) => command.name);

/**
 * The HELP listing, built from the same entries that define the commands, so a
 * documented alias is by construction one that actually works.
 */
export function helpText(): string[] {
  return [
    '=== MyCAD — available commands ===',
    ...[...COMMAND_LIST].sort((a, b) => a.name.localeCompare(b.name)).map((command) => {
      const short = command.aliases[0];
      const label = !short || short === command.name ? command.name : `${command.name} (${short})`;
      return command.help ? `${label.padEnd(22)} — ${command.help}` : label;
    }),
    'Command+drag = orbit 3D, wheel / trackpad = zoom',
  ];
}

/** Restarts after finishing, so the tool stays active for the next object. */
export function isStickyCommand(name: CommandName): boolean {
  return commandDef(name).sticky === true;
}

/** Takes snapped point picks from the viewport on its point steps. */
export function takesPointInput(name: CommandName): boolean {
  return commandDef(name).pointInput === true;
}

/** Acts on existing objects, so picked points are tracked in world space too. */
export function transformsObjects(name: CommandName): boolean {
  return commandDef(name).transformsObjects === true;
}
