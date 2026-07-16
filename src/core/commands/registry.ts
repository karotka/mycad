/**
 * The one place a command is declared.
 *
 * Everything that used to be a hand-maintained parallel list — the CommandName
 * union, the alias table, the autocomplete order, which tools restart, which
 * tools take snapped viewport points — is derived from this array. `CommandName`
 * itself is inferred from it, so adding an entry here is what makes a command
 * exist; forgetting to register one is a type error rather than a silent gap.
 */
import { isLineLikeEntity, isOffsetEntity, isSweepProfileEntity, type Entity } from '../entities/types';
import type { ActiveCommand, CommandContext, CommandStep } from './types';

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
  { name: 'LINE', aliases: ['L', 'LINE'], help: 'draw line', suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify first point:' }, { kind: 'point', label: 'Specify second point:' }, { kind: 'done' }] },
  { name: 'POLYLINE', aliases: ['PL', 'PLINE', 'POLYLINE'], help: 'draw a connected polyline', suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify start point:' }, { kind: 'point', label: 'Specify next point (Enter to finish, C to close):', optional: true }, { kind: 'done' }], data: () => ({ vertices: [] }) },
  { name: 'RECTANGLE', aliases: ['R', 'REC', 'RECTANGLE'], help: 'draw rectangle', suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify first rectangle corner:' }, { kind: 'point', label: 'Specify opposite corner:', corner: true }, { kind: 'done' }] },
  { name: 'CIRCLE', aliases: ['C', 'CIRCLE'], help: 'draw circle', suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify circle center:' }, { kind: 'point', label: 'Specify radius or point on circumference:' }, { kind: 'done' }] },
  { name: 'POLYGON', aliases: ['P', 'POL', 'POLYGON'], help: 'draw regular polygon', suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify polygon center:' }, { kind: 'number', label: 'Enter number of sides:' }, { kind: 'point', label: 'Specify perpendicular distance to side:' }, { kind: 'done' }] },
  { name: 'ARC', aliases: ['A', 'ARC'], suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify arc center:' }, { kind: 'point', label: 'Specify start point:' }, { kind: 'point', label: 'Specify end point or angle:' }, { kind: 'done' }] },
  { name: 'BEZIER', aliases: ['B', 'BEZIER'], suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify start point:' }, { kind: 'point', label: 'Specify first control point:' }, { kind: 'point', label: 'Specify second control point:' }, { kind: 'point', label: 'Specify end point:' }, { kind: 'done' }] },
  { name: 'TEXT', aliases: ['T', 'TEXT'], suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'text', label: 'Select font:' }, { kind: 'number', label: 'Enter text height in mm:' }, { kind: 'point', label: 'Specify text insertion point:' }, { kind: 'text', label: 'Enter text:' }, { kind: 'done' }] },
  { name: 'MEASURE', aliases: ['D', 'DI', 'DIM', 'DIMENSION', 'MEASURE'], help: 'create an aligned dimension', suggest: true, sticky: true, pointInput: true,
    steps: [{ kind: 'point', label: 'Select first measurement point:' }, { kind: 'point', label: 'Select second measurement point:' }, { kind: 'point', label: 'Specify dimension line location:' }, { kind: 'done' }],
    data: (ctx) => ({ dimensionStyle: { ...ctx.doc.dimensionStyle } }) },
  { name: 'DIMRADIUS', aliases: ['DR', 'DRA', 'DIMRADIUS'], suggest: true, sticky: true, pointInput: true,
    steps: [{ kind: 'entity', label: 'Select circle or arc for radius dimension:' }, { kind: 'point', label: 'Specify dimension text location:' }, { kind: 'done' }],
    data: (ctx) => ({ entity: undefined, dimensionStyle: { ...ctx.doc.dimensionStyle } }),
    onStart: preselectOne('entity', (entity) => entity.type === 'circle' || entity.type === 'arc', '') },
  { name: 'DIMDIAMETER', aliases: ['DD', 'DDI', 'DIMDIAMETER'], suggest: true, sticky: true, pointInput: true,
    steps: [{ kind: 'entity', label: 'Select circle or arc for diameter dimension:' }, { kind: 'point', label: 'Specify dimension text location:' }, { kind: 'done' }],
    data: (ctx) => ({ entity: undefined, dimensionStyle: { ...ctx.doc.dimensionStyle } }),
    onStart: preselectOne('entity', (entity) => entity.type === 'circle' || entity.type === 'arc', '') },
  { name: 'MOVE', aliases: ['MO', 'MOVE'], help: 'move in view plane', suggest: true, pointInput: true, transformsObjects: true, steps: [{ kind: 'entity', label: 'Select object to move:', accepts: ['entity', 'solid'] }, { kind: 'point', label: 'Specify base point:' }, { kind: 'point', label: 'Specify target point:' }, { kind: 'done' }] },
  { name: 'COPY', aliases: ['CO', 'CP', 'COPY'], help: 'copy objects repeatedly', suggest: true, pointInput: true, transformsObjects: true,
    steps: [{ kind: 'entity', label: 'Select object(s) to copy, then press Enter:', multi: true, accepts: ['entity', 'solid'] }, { kind: 'point', label: 'Specify base point:' }, { kind: 'point', label: 'Specify target point (Escape to finish):' }, { kind: 'done' }],
    data: () => ({ entities: [], solids: [] }),
    onStart: preselectObjects((count) => `${count} object(s) preselected. Specify base point.`) },
  { name: 'SCALE', aliases: ['SC', 'SCALE'], help: 'scale objects from a base point', suggest: true, pointInput: true, transformsObjects: true,
    steps: [{ kind: 'entity', label: 'Select object(s) to scale, then press Enter:', multi: true, accepts: ['entity', 'solid'] }, { kind: 'point', label: 'Specify scale base point:' }, { kind: 'point', label: 'Specify scale factor or enter a number:' }, { kind: 'done' }],
    data: () => ({ entities: [], solids: [] }),
    onStart: preselectObjects((count) => `${count} object(s) preselected. Specify scale base point.`) },
  { name: 'ROTATE', aliases: ['RO', 'ROTATE'], suggest: true, pointInput: true, transformsObjects: true,
    steps: [{ kind: 'entity', label: 'Select 2D object(s), then press Enter:', multi: true }, { kind: 'point', label: 'Specify rotation base point:' }, { kind: 'point', label: 'Specify rotation angle or enter degrees:' }, { kind: 'done' }],
    data: () => ({ entities: [] }),
    onStart: (active, ctx) => {
      const selected = ctx.doc.getSelectedEntities();
      if (selected.length === 0) return;
      active.data.entities = [...selected];
      active.stepIndex = 1;
      ctx.log(`${selected.length} object(s) preselected. Specify rotation base point.`);
    } },
  { name: 'MIRROR', aliases: ['MI', 'MIRROR'], help: 'mirror objects', suggest: true, steps: [{ kind: 'entity', label: 'Select object(s) — click, then Enter to continue:', multi: true }, { kind: 'point', label: 'Specify first mirror-axis point:' }, { kind: 'point', label: 'Specify second mirror-axis point:' }, { kind: 'done' }], data: () => ({ entities: [] }) },
  { name: 'JOIN', aliases: ['J', 'JOIN'], help: 'join connected 2D lines into one polyline', suggest: true,
    steps: [{ kind: 'entity', label: 'Select connected lines or curves, then press Enter:', multi: true }, { kind: 'done' }],
    data: () => ({ entities: [] }),
    onStart: (active, ctx) => {
      const lines = ctx.doc.getSelectedEntities().filter((entity) =>
        entity.type === 'line' || entity.type === 'arc' || entity.type === 'bezier' || entity.type === 'polyline');
      active.data.entities = lines;
      if (lines.length >= 2) ctx.log(`${lines.length} preselected object(s). Joining selection.`);
      else if (lines.length > 0) ctx.log('1 object preselected. Select at least one connected object or press Enter.');
    } },
  { name: 'EXPLODE', aliases: ['X', 'EXPLODE'], help: 'break compound objects into parts', suggest: true,
    steps: [{ kind: 'entity', label: 'Select objects to explode, then press Enter:', multi: true, accepts: ['entity', 'solid'] }, { kind: 'done' }],
    data: () => ({ entities: [], solids: [] }),
    onStart: preselectObjects((count) => `${count} object(s) preselected. Press Enter to explode.`, { skipStep: false }) },
  { name: 'EXTEND', aliases: ['EX', 'EXTEND'], help: 'extend a line to a boundary', suggest: true,
    steps: [{ kind: 'entity', label: 'Select boundary line or polyline:' }, { kind: 'entity', label: 'Select line or polyline to extend:' }, { kind: 'done' }],
    data: () => ({ boundary: undefined }),
    onStart: preselectOne('boundary', isLineLikeEntity, 'Boundary line or polyline preselected.') },
  { name: 'TRIM', aliases: ['TR', 'TRIM'], help: 'trim a line at a cutting edge', suggest: true,
    steps: [{ kind: 'entity', label: 'Select cutting line or polyline:' }, { kind: 'entity', label: 'Select line or polyline to trim:' }, { kind: 'done' }],
    data: () => ({ boundary: undefined }),
    onStart: preselectOne('boundary', isLineLikeEntity, 'Cutting line or polyline preselected.') },
  { name: 'OFFSET', aliases: ['O', 'OFFSET', 'EQUID', 'EKVID'], help: 'create an equidistant parallel line', suggest: true,
    steps: [{ kind: 'entity', label: 'Select line or closed 2D object to offset:' }, { kind: 'number', label: 'Enter offset distance:' }, { kind: 'point', label: 'Specify side for offset:' }, { kind: 'done' }],
    data: () => ({ entity: undefined }),
    onStart: preselectOne('entity', isOffsetEntity, 'Object preselected. Enter offset distance.') },
  { name: 'CHAMFER', aliases: ['CHA', 'CHAMFER'], help: 'chamfer a solid edge', suggest: true, steps: [{ kind: 'edge', label: 'Select solid edge to chamfer:' }, { kind: 'number', label: 'Enter chamfer distance:' }, { kind: 'done' }] },
  { name: 'FILLET', aliases: ['F', 'FILLET'], help: 'round a solid edge', suggest: true, steps: [{ kind: 'edge', label: 'Select solid edge to fillet:' }, { kind: 'number', label: 'Enter fillet radius:' }, { kind: 'done' }] },
  { name: 'BOX', aliases: ['BX', 'BOX'], suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify first base corner:' }, { kind: 'point', label: 'Specify opposite base corner:', corner: true }, { kind: 'number', label: 'Specify box height:' }, { kind: 'done' }] },
  { name: 'WEDGE', aliases: ['WE', 'WEDGE'], suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify first base corner:' }, { kind: 'point', label: 'Specify opposite base corner:', corner: true }, { kind: 'number', label: 'Specify wedge height:' }, { kind: 'done' }] },
  { name: 'SPHERE', aliases: ['SPH', 'SPHERE'], suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify sphere center:' }, { kind: 'point', label: 'Specify sphere radius:' }, { kind: 'done' }] },
  { name: 'CONE', aliases: ['CONE'], suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify cone base center:' }, { kind: 'point', label: 'Specify base radius:' }, { kind: 'number', label: 'Specify cone height:' }, { kind: 'done' }] },
  { name: 'CYLINDER', aliases: ['CYL', 'CYLINDER'], suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify cylinder center:' }, { kind: 'point', label: 'Specify radius:' }, { kind: 'number', label: 'Specify cylinder height:' }, { kind: 'done' }] },
  { name: 'PYRAMID', aliases: ['PYR', 'PYRAMID'], suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify pyramid base center:' }, { kind: 'point', label: 'Specify base radius:' }, { kind: 'number', label: 'Specify pyramid height:' }, { kind: 'done' }] },
  { name: 'TORUS', aliases: ['TOR', 'TORUS'], suggest: true, sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify torus center:' }, { kind: 'point', label: 'Specify torus radius:' }, { kind: 'number', label: 'Specify tube radius:' }, { kind: 'done' }] },
  { name: 'ARRAY_RECTANGULAR', aliases: ['ARR', 'ARRAY', 'RECTARRAY', 'ARRAYRECTANGULAR', 'RECTANGULAR'], help: 'create a rectangular array', suggest: true,
    steps: [{ kind: 'entity', label: 'Select objects to array, then press Enter:', multi: true }, { kind: 'number', label: 'Enter number of rows:' }, { kind: 'number', label: 'Enter number of columns:' }, { kind: 'number', label: 'Enter row spacing:' }, { kind: 'number', label: 'Enter column spacing:' }, { kind: 'done' }],
    data: () => ({ entities: [], solids: [] }),
    onStart: preselectObjects((count) => `${count} object(s) preselected. Enter array size.`) },
  { name: 'ARRAY_POLAR', aliases: ['POLARARRAY', 'ARRAYPOLAR'], help: 'create a polar array', suggest: true,
    steps: [{ kind: 'entity', label: 'Select objects to array, then press Enter:', multi: true }, { kind: 'point', label: 'Specify array center:' }, { kind: 'number', label: 'Enter number of items:' }, { kind: 'number', label: 'Enter total angle:' }, { kind: 'done' }],
    data: () => ({ entities: [], solids: [], totalAngle: 360 }),
    onStart: preselectObjects((count) => `${count} object(s) preselected. Enter polar array settings.`) },
  { name: 'EXTRUDE', aliases: ['E', 'EXT', 'EXTRUDE'], help: 'extrude closed profile', suggest: true,
    steps: [{ kind: 'entity', label: 'Select a closed 2D profile:' }, { kind: 'number', label: 'Enter extrusion height:' }, { kind: 'done' }],
    data: () => ({ entities: [] }),
    onStart: (active, ctx) => {
      const profile = ctx.doc.getSelectedEntities()[0] ?? ctx.doc.entities.find((entity) => entity.selected);
      if (!profile) return;
      active.data.entities = [profile];
      active.stepIndex = 1;
    } },
  { name: 'SWEEP', aliases: ['SW', 'SWEEP'], help: 'sweep profile along path', suggest: true,
    steps: [{ kind: 'entity', label: 'Select closed 2D profile:' }, { kind: 'entity', label: 'Select path:' }, { kind: 'done' }],
    data: () => ({ profile: undefined }),
    onStart: preselectOne('profile', isSweepProfileEntity, 'Profile preselected. Select sweep path.') },
  { name: 'PRESSPULL', aliases: ['PP', 'PRESSPULL'], help: 'modify a solid face', suggest: true, steps: [{ kind: 'solid', label: 'Select solid:' }, { kind: 'number', label: 'Enter height change (+/-):' }, { kind: 'done' }] },
  { name: 'UNION', aliases: ['U', 'UNI', 'UNION'], help: 'join solids', suggest: true, steps: [{ kind: 'solid', label: 'Select first solid:', additive: true }, { kind: 'solid', label: 'Select second solid:', additive: true }, { kind: 'done' }], data: () => ({ solids: [] }) },
  { name: 'SUBTRACT', aliases: ['S', 'SUB', 'SUBTRACT', 'SUBSTRACT'], help: 'subtract solids', suggest: true, steps: [{ kind: 'solid', label: 'Select base solid:', additive: true }, { kind: 'solid', label: 'Select solid to subtract:', additive: true }, { kind: 'done' }] },
  { name: 'UCS', aliases: ['UCS'], suggest: true, steps: [{ kind: 'point', label: 'Select UCS origin vertex:' }, { kind: 'point', label: 'Select a point on the positive X axis:' }, { kind: 'point', label: 'Select a point on the positive Y axis:' }, { kind: 'done' }] },

  // Not offered by autocomplete.
  { name: 'OCTAGON', aliases: ['OCT', 'OCTAGON'], sticky: true, pointInput: true, steps: [{ kind: 'point', label: 'Specify octagon center:' }, { kind: 'point', label: 'Specify radius (point on circumference):' }, { kind: 'done' }] },
  { name: 'ERASE', aliases: ['ERASE'], help: 'delete object', steps: [{ kind: 'entity', label: 'Select object to delete (or a 3D solid):', accepts: ['entity', 'solid'] }, { kind: 'done' }] },
  { name: 'VIEW2D', aliases: ['V2', 'VIEW2D'], help: '2D view', run: (ctx) => { ctx.doc.viewMode = '2d'; ctx.redraw(); ctx.log('Rezim zobrazeni: 2D'); } },
  { name: 'VIEW3D', aliases: ['V3', 'VIEW3D'], help: '3D view', run: (ctx) => { ctx.doc.viewMode = '3d'; ctx.redraw(); ctx.log('Rezim zobrazeni: 3D'); } },
  { name: 'ZOOM', aliases: ['Z', 'ZOOM'], run: (ctx) => ctx.log('Zoom extents aktivujte tlacitkem ZOOM nebo koleckem mysi.') },
  { name: 'SNAP', aliases: ['SN', 'SNAP'], help: 'toggle snap', run: (ctx) => { ctx.doc.snapEnabled = !ctx.doc.snapEnabled; ctx.log(`Snap: ${ctx.doc.snapEnabled ? 'ON' : 'OFF'}`); } },
  { name: 'UNDO', aliases: ['UNDO'], help: 'undo last edit', run: (ctx) => { ctx.log(ctx.history.undo() ? 'Undo complete.' : 'Nothing to undo.'); ctx.redraw(); } },
  { name: 'REDO', aliases: ['REDO'], help: 'redo last edit', run: (ctx) => { ctx.log(ctx.history.redo() ? 'Redo complete.' : 'Nothing to redo.'); ctx.redraw(); } },
  { name: 'HELP', aliases: ['H', 'HELP'], run: (ctx) => { for (const line of helpText()) ctx.log(line); } },
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
    ...COMMAND_LIST.filter((command) => command.help).map((command) => {
      const short = command.aliases[0];
      const label = !short || short === command.name ? command.name : `${command.name} (${short})`;
      return `${label.padEnd(14)} — ${command.help}`;
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
