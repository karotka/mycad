import type { Document } from '../Document';
import {
  COMMAND_ALIASES,
  COMMAND_LIST,
  SUGGESTED_COMMANDS,
  commandDef,
  isStickyCommand,
  type CommandDef,
  type CommandName,
} from './registry';
import type { ActiveCommand, CommandContext, CommandStep, PickTarget } from './types';
import type { Vec2, Vec3 } from '../../math/geometry';
import { closePolyline, dist2, rotatePoint } from '../../math/geometry';
import { worldToLocal } from '../../math/workplane';
import { WORLD_WORK_PLANE } from '../../math/workplane';
import { curvePoints, ellipsePoints, entityBounds, type Entity, type Solid, type SolidEdgeSelection, type SolidFaceSelection, type SolidFeature } from '../entities/types';
import type { CommandHistory } from '../history/CommandHistory';
import {
} from '../history/edits';
import {
} from '../solids/ManifoldEngine';
import { translatedFeature } from '../solids/featureTransform';
import { rotateSolidAroundPlane } from './steps/transform';


// Commands are declared in ./registry; re-exported here so existing importers
// keep working while behaviour moves across.
export type { CommandName };
export type { ActiveCommand, CommandContext, CommandStep, PickTarget } from './types';

/** `NAME (ALIAS)  — description`, with the alias taken from the registry so it cannot go stale. */
function helpLine(command: CommandDef): string {
  const short = command.aliases[0];
  const label = !short || short === command.name ? command.name : `${command.name} (${short})`;
  return `${label.padEnd(14)} — ${command.help}`;
}








function workPlaneDelta(plane: typeof WORLD_WORK_PLANE, localDelta: Vec2): Vec3 {
  return {
    x: plane.xAxis.x * localDelta.x + plane.yAxis.x * localDelta.y,
    y: plane.xAxis.y * localDelta.x + plane.yAxis.y * localDelta.y,
    z: plane.xAxis.z * localDelta.x + plane.yAxis.z * localDelta.y,
  };
}

export class CommandManager {
  active: ActiveCommand | null = null;
  history: string[] = [];
  historyIndex = -1;
  /** What Enter at an empty prompt repeats, however that command was started. */
  private lastCommand: CommandName | null = null;

  constructor(private ctx: CommandContext) {}

  updateContext(ctx: Partial<CommandContext>): void {
    Object.assign(this.ctx, ctx);
  }

  /** The step awaiting input, or null when no command is running. */
  get activeStep(): CommandStep | null {
    return this.active?.steps[this.active.stepIndex] ?? null;
  }

  /**
   * True while the active step collects a set of objects. Drawing a selection
   * window and consuming one are both gated on this, so they cannot disagree.
   */
  get isMultiObjectStep(): boolean {
    const step = this.activeStep;
    return (step?.kind === 'entity' || step?.kind === 'solid') && step.multi === true;
  }

  /** True when a pick should extend the selection rather than replace it. */
  get isAdditiveStep(): boolean {
    const step = this.activeStep;
    if (step?.kind !== 'entity' && step?.kind !== 'solid') return false;
    return step.multi === true || step.additive === true;
  }

  /** True when the active step can consume the given pick from the viewport. */
  stepAccepts(target: PickTarget): boolean {
    const step = this.activeStep;
    if (step?.kind === 'solid') return target === 'solid';
    if (step?.kind !== 'entity') return false;
    return (step.accepts ?? ['entity']).includes(target);
  }

  syncWindowSelection(): boolean {
    if (!this.active || !this.isMultiObjectStep) return false;
    this.active.data.entities = [...this.ctx.doc.getSelectedEntities()];
    this.active.data.solids = [...this.ctx.doc.getSelectedSolids()];
    const count = (this.active.data.entities as Entity[]).length + (this.active.data.solids as Solid[]).length;
    this.ctx.log(`${count} object(s) selected. Select more or press Enter.`);
    this.showCurrentPrompt();
    return true;
  }

  /**
   * Ends a POLYLINE. Fewer than two vertices means nothing was drawn, so the
   * command is dropped rather than leaving a degenerate entity behind.
   */
  resolveAlias(input: string): CommandName | null {
    const key = input.trim().toUpperCase();
    return COMMAND_ALIASES[key] ?? null;
  }

  commandSuggestions(input: string): CommandName[] {
    const prefix = input.trim().toUpperCase();
    if (!prefix) return [];
    return SUGGESTED_COMMANDS.filter((command) => command.startsWith(prefix));
  }

  startCommand(name: CommandName): void {
    this.cancelActive();
    this.lastCommand = name;
    const def = commandDef(name);
    // A command with no wizard acts at once and leaves nothing active.
    if (def.run) {
      def.run(this.ctx);
      return;
    }
    if (!def.steps) {
      this.ctx.log(`Unknown command: ${name}`);
      return;
    }
    // Steps are data, so they are cloned per run — the wizard mutates them.
    this.active = {
      name,
      steps: def.steps.map((step) => ({ ...step })),
      stepIndex: 0,
      data: def.data?.(this.ctx) ?? {},
    };
    def.onStart?.(this.active, this.ctx);

    // When a preselection has already answered the last question a command had,
    // waiting for Enter would only ask the user to confirm what is on screen.
    // Press it for them: select objects, hit ERASE, they are gone — undo covers it.
    if (this.preselectionAnswersEverything()) {
      void this.advanceStep(null);
      return;
    }
    this.showCurrentPrompt();
  }

  /** True when the active step gathers objects, already has some, and nothing follows it. */
  private preselectionAnswersEverything(): boolean {
    if (!this.active || !this.isMultiObjectStep) return false;
    if (this.active.steps[this.active.stepIndex + 1]?.kind !== 'done') return false;
    const entities = (this.active.data.entities as Entity[] | undefined)?.length ?? 0;
    const solids = (this.active.data.solids as Solid[] | undefined)?.length ?? 0;
    return entities + solids > 0;
  }

  printHelp(): void {
    const lines = [
      '=== MyCAD — available commands ===',
      ...COMMAND_LIST.filter((command) => command.help).map(helpLine),
      'Command+drag = orbit 3D, wheel / trackpad = zoom',
    ];
    for (const l of lines) this.ctx.log(l);
  }

  cancelActive(): void {
    if (this.active?.cancel) this.active.cancel();
    this.active = null;
  }

  currentPrompt(): string {
    if (!this.active) return 'Command:';
    const step = this.active.steps[this.active.stepIndex];
    if (step.kind === 'done') return 'Command:';
    return step.label;
  }

  showCurrentPrompt(): void {
    this.ctx.prompt(this.currentPrompt());
  }

  /**
   * Every typed answer goes through here, so this is where a command that
   * throws is caught. It used to escape into an unhandled rejection: the height
   * for an EXTRUDE would be swallowed, the prompt would ask for it again, and
   * nothing anywhere said why. A command that fails has to say so.
   */
  async submitInput(input: string): Promise<void> {
    try {
      await this.readInput(input);
    } catch (error) {
      this.reportFailure(error);
    }
  }

  private reportFailure(error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.ctx.log(`${this.active?.name ?? 'Command'} failed: ${reason}`);
    // The command stays where it was, so the same answer can be tried again
    // once whatever went wrong is fixed.
    if (this.active) this.showCurrentPrompt();
    else this.ctx.prompt('Command:');
    this.ctx.redraw();
  }

  private async readInput(input: string): Promise<void> {
    const trimmed = input.trim();

    if (!this.active) {
      if (!trimmed) {
        // Enter at an empty prompt repeats the last command, as in AutoCAD.
        if (this.lastCommand) this.startCommand(this.lastCommand);
        return;
      }
      const cmd = this.resolveAlias(trimmed);
      if (cmd) {
        this.history.push(trimmed);
        this.historyIndex = this.history.length;
        this.startCommand(cmd);
      } else {
        this.ctx.log(`Unknown command: ${trimmed}. Enter HELP.`);
      }
      return;
    }

    const step = this.active.steps[this.active.stepIndex];
    if (step.kind === 'done') return;

    if (trimmed.toUpperCase() === 'CANCEL' || trimmed === '') {
      if (step.optional) {
        await this.advanceStep(null);
        return;
      }
      // Enter ends a multi-object step once anything has been gathered; the step
      // decides whether solids count, so this cannot drift from what it accepts.
      const gathered = (this.active.data.entities as Entity[] | undefined)?.length ?? 0;
      const gatheredSolids = this.stepAccepts('solid')
        ? (this.active.data.solids as Solid[] | undefined)?.length ?? 0
        : 0;
      if (this.isMultiObjectStep && (gathered > 0 || gatheredSolids > 0)) {
        await this.advanceStep(null);
        return;
      }
      this.cancelActive();
      this.ctx.log('Command canceled.');
      this.ctx.prompt('Command:');
      return;
    }

    await this.processStepInput(trimmed, step);
  }

  async handleClick(world: Vec2 | Vec3, pickEntity?: Entity, pickSolidId?: string, pickFace?: SolidFaceSelection, pickEdge?: SolidEdgeSelection): Promise<void> {
    try {
      await this.readClick(world, pickEntity, pickSolidId, pickFace, pickEdge);
    } catch (error) {
      this.reportFailure(error);
    }
  }

  private async readClick(world: Vec2 | Vec3, pickEntity?: Entity, pickSolidId?: string, pickFace?: SolidFaceSelection, pickEdge?: SolidEdgeSelection): Promise<void> {
    if (!this.active) return;
    const step = this.active.steps[this.active.stepIndex];

    if (step.kind === 'point') {
      await this.advanceStep(world);
    } else if (step.kind === 'entity' && pickEntity && this.stepAccepts('entity')) {
      this.ctx.doc.selectEntity(pickEntity.id, this.isAdditiveStep);
      if (this.active.name === 'TRIM' && this.active.stepIndex === 1) this.active.data.targetPickPoint = world;
      await this.advanceStep(pickEntity);
    } else if (step.kind === 'edge' && pickEdge) {
      this.ctx.doc.selectSolid(pickEdge.solidId);
      await this.advanceStep(pickEdge);
    } else if (step.kind === 'entity' && pickSolidId && this.stepAccepts('solid')) {
      this.ctx.doc.selectSolid(pickSolidId, this.isAdditiveStep);
      await this.advanceStep(pickSolidId);
    } else if (step.kind === 'solid' && (pickSolidId || pickFace)) {
      const solidId = pickFace?.solidId ?? pickSolidId!;
      this.ctx.doc.selectSolid(solidId, this.isAdditiveStep);
      await this.advanceStep(this.active.name === 'PRESSPULL' && pickFace ? pickFace : pickSolidId);
    }
  }

  /**
   * A picked object into the set the command is gathering. A solid arrives as
   * its id — that is all the viewport can name it by — while an entity arrives
   * whole, so the two go to different places. Getting that wrong puts a string
   * where an object belongs, and it surfaces much later as something trying to
   * write a field onto it.
   *
   * False means there was nothing to take: Enter at a multi-object step.
   */
  private gatherPicked(value: unknown): boolean {
    if (!this.active || !value) return false;
    const data = this.active.data;
    if (typeof value === 'string') {
      const solid = this.ctx.doc.getSolid(value);
      const solids = (data.solids ??= []) as Solid[];
      if (solid && !solids.some((item) => item.id === solid.id)) solids.push(solid);
    } else {
      const entity = value as Entity;
      const entities = (data.entities ??= []) as Entity[];
      if (!entities.some((item) => item.id === entity.id)) entities.push(entity);
    }
    this.ctx.log('Object added. Select another or press Enter.');
    return true;
  }

  async handlePreview(cursor: Vec2): Promise<void> {
    if (this.active?.preview) this.active.preview(cursor);
  }

  private async processStepInput(input: string, step: CommandStep): Promise<void> {
    switch (step.kind) {
      case 'point': {
        // C closes the polyline: the same answer as Enter, with the ends
        // joined. Routed through the one path rather than a second way in.
        if (this.active?.name === 'POLYLINE' && this.active.stepIndex > 0 && input.trim().toUpperCase() === 'C') {
          this.active.data.closing = true;
          await this.advanceStep(null);
          return;
        }
        if (this.active?.name === 'SCALE' && this.active.stepIndex === 2) {
          const factor = Number(input);
          const base = this.active.data.basePoint as Vec2 | undefined;
          if (base && Number.isFinite(factor) && factor > 0) {
            this.active.data.enteredScaleFactor = factor;
            await this.advanceStep({ x: base.x + factor, y: base.y });
            return;
          }
          if (Number.isFinite(factor)) { this.ctx.log('Scale factor must be greater than zero.'); return; }
        }
        if (this.active?.name === 'ROTATE' && this.active.stepIndex === 2) {
          const degrees = Number(input);
          const base = this.active.data.basePoint as Vec2 | undefined;
          if (base && Number.isFinite(degrees)) {
            const angle = degrees * Math.PI / 180;
            await this.advanceStep({ x: base.x + Math.cos(angle), y: base.y + Math.sin(angle) });
            return;
          }
        }
        if (this.active?.name === 'ARC' && this.active.stepIndex === 2) {
          const angle = Number(input); const center = this.active.data.center as Vec2; const start = this.active.data.start as Vec2;
          if (Number.isFinite(angle) && center && start) { const a = Math.atan2(start.y-center.y,start.x-center.x) + angle*Math.PI/180; const r=dist2(center,start); await this.advanceStep({x:center.x+Math.cos(a)*r,y:center.y+Math.sin(a)*r}); return; }
        }
        if ((this.active?.name === 'CIRCLE' || this.active?.name === 'CIRCLE_DIAMETER') && this.active.stepIndex === 1) {
          const entered = Number(input);
          const center = this.active.data.center as Vec2 | undefined;
          if (center && Number.isFinite(entered) && entered > 0) {
            // The step reads a point, so hand it one the entered distance away.
            // What that distance means is the command's business: a radius for
            // CIRCLE, a diameter for CIRCLE_DIAMETER.
            await this.advanceStep({ x: center.x + entered, y: center.y });
            return;
          }
        }
        if (this.active && ['CYLINDER', 'SPHERE', 'CONE', 'PYRAMID', 'TORUS'].includes(this.active.name) && this.active.stepIndex === 1) {
          const radius = Number(input);
          const center = this.active.data.center as Vec2 | undefined;
          if (center && Number.isFinite(radius) && radius > 0) {
            await this.advanceStep({ x: center.x + radius, y: center.y });
            return;
          }
        }
        if (this.active?.name === 'POLYGON' && this.active.stepIndex === 2) {
          const apothem = Number(input);
          const center = this.active.data.center as Vec2 | undefined;
          if (center && Number.isFinite(apothem) && apothem > 0) {
            await this.advanceStep({ x: center.x + apothem, y: center.y });
            return;
          }
        }
        if (input.startsWith('@')) {
          const base = this.active?.data.lastPoint as Vec2 | undefined;
          if (!base) {
            this.ctx.log('Relative coordinates require a previous point.');
            break;
          }
          const relative = input.slice(1).trim();
          const polar = relative.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*<\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
          if (polar) {
            const distance = Number(polar[1]);
            const angle = Number(polar[2]) * Math.PI / 180;
            await this.advanceStep({ x: base.x + Math.cos(angle) * distance, y: base.y + Math.sin(angle) * distance });
            return;
          }
          const cartesian = relative.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*[,;]\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
          if (cartesian) {
            await this.advanceStep({ x: base.x + Number(cartesian[1]), y: base.y + Number(cartesian[2]) });
            return;
          }
          this.ctx.log('Invalid relative point. Use @x,y or @distance<angle.');
          break;
        }
        const parts = input.split(/[,;\s]+/).filter(Boolean);
        if (parts.length >= 2) {
          const p = { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
          if (!isNaN(p.x) && !isNaN(p.y)) {
            await this.advanceStep(p);
            return;
          }
        }
        this.ctx.log(this.active?.name === 'CIRCLE' && this.active.stepIndex === 1
          ? 'Invalid radius or point. Enter a positive number or point x,y.'
          : 'Invalid point. Use x,y, @x,y, or @distance<angle.');
        break;
      }
      case 'number': {
        const n = parseFloat(input);
        if (!isNaN(n)) {
          await this.advanceStep(n);
          return;
        }
        this.ctx.log('Invalid number.');
        break;
      }
      case 'text': await this.advanceStep(input); return;
      case 'entity':
      case 'solid':
      case 'edge':
        this.ctx.log('Click an object or enter coordinates.');
        break;
    }
  }

  /**
   * True while a step is being carried out. A command that waits on the solid
   * engine leaves the wizard open for milliseconds, and anything arriving in
   * that window used to be answered a second time — press Enter while an
   * EXPLODE is still regenerating and it explodes twice. The step in flight owns
   * the command until it is done; a keystroke that lands mid-step is dropped,
   * which is what a busy tool does.
   */
  private advancing = false;

  private async advanceStep(value: unknown): Promise<void> {
    if (this.advancing) return;
    this.advancing = true;
    try {
      await this.runStep(value);
    } finally {
      this.advancing = false;
    }
  }

  private async runStep(value: unknown): Promise<void> {
    if (!this.active) return;
    const step = this.active.steps[this.active.stepIndex];
    const data = this.active.data;
    if (step.kind === 'point' && value && typeof value === 'object' && 'x' in value && 'y' in value) {
      const point = value as Vec2;
      data.lastPoint = { x: point.x, y: point.y };
    }

    const execute = commandDef(this.active.name).execute;
    if (execute) {
      // Awaited only when there is something to await. `await` on a plain value
      // still suspends until the next microtask, which would make every command
      // asynchronous whether it needed to be or not — and `startCommand` fires
      // this off with `void` for a preselection that answers everything, so an
      // ERASE would return with the objects still there and delete them later.
      const answered = execute({
        ctx: this.ctx,
        active: this.active,
        step,
        value,
        data,
        gather: (picked) => this.gatherPicked(picked),
        cancel: () => this.cancelActive(),
      });
      const outcome = answered instanceof Promise ? await answered : answered;
      // A command that ended itself has no step to advance and no prompt to show.
      if (!this.active) return;
      if (outcome === 'stay') {
        this.showCurrentPrompt();
        this.ctx.redraw();
        return;
      }
      this.finishStep();
      return;
    }

    this.finishStep();
  }

  /**
   * On to the next question, or out. The same for every command, which is why
   * it is here and not in any of them — the switch used to reach `break` to get
   * at it, and a migrated command returns 'advance' to say the same thing.
   */
  private finishStep(): void {
    if (!this.active) return;
    this.active.stepIndex++;
    while (this.active && this.active.steps[this.active.stepIndex]?.kind === 'done') {
      if (isStickyCommand(this.active.name)) {
        // Drawing tools stay active until Escape or another command is chosen.
        // A restart is a fresh run, so its data comes from where a fresh run's
        // data comes from — naming one command here left DIMALIGNED and the
        // radial dimensions restarting without the style they were started with.
        this.active.stepIndex = 0;
        this.active.data = commandDef(this.active.name).data?.(this.ctx) ?? {};
      } else {
        this.active = null;
      }
      break;
    }

    if (this.active) {
      this.showCurrentPrompt();
    } else {
      this.ctx.prompt('Command:');
    }
    this.ctx.redraw();
  }

  historyUp(): string | null {
    if (this.history.length === 0) return null;
    this.historyIndex = Math.max(0, this.historyIndex - 1);
    return this.history[this.historyIndex];
  }

  historyDown(): string | null {
    if (this.history.length === 0) return null;
    this.historyIndex = Math.min(this.history.length, this.historyIndex + 1);
    if (this.historyIndex >= this.history.length) return '';
    return this.history[this.historyIndex];
  }
}

/** Distance from a point to a segment — the basis of every stroke hit test. */
function distanceToSegment(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (length2 < 1e-12) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** True when the point lies inside the ellipse — its own frame, so rotation is undone. */
export function pointInEllipse(point: Vec2, e: Extract<Entity, { type: 'ellipse' }>): boolean {
  const dx = point.x - e.center.x, dy = point.y - e.center.y;
  const cos = Math.cos(-e.rotation), sin = Math.sin(-e.rotation);
  const x = dx * cos - dy * sin;
  const y = dx * sin + dy * cos;
  if (e.radiusX < 1e-12 || e.radiusY < 1e-12) return false;
  return (x / e.radiusX) ** 2 + (y / e.radiusY) ** 2 <= 1;
}

/** True when the point is within tolerance of any segment of the chain. */
function hitsChain(point: Vec2, vertices: Vec2[], tolerance: number): boolean {
  for (let i = 1; i < vertices.length; i++) {
    if (distanceToSegment(point, vertices[i - 1], vertices[i]) <= tolerance) return true;
  }
  return false;
}

export function hitTestEntity(entities: Entity[], point: Vec2, tolerance = 0.5): Entity | null {
  for (let i = entities.length - 1; i >= 0; i--) {
    const e = entities[i];
    switch (e.type) {
      case 'line': {
        if (distanceToSegment(point, e.start, e.end) <= tolerance) return e;
        break;
      }
      case 'circle': {
        const d = Math.hypot(point.x - e.center.x, point.y - e.center.y);
        if (Math.abs(d - e.radius) <= tolerance || d <= e.radius) return e;
        break;
      }
      case 'ellipse': {
        // Inside counts, as it does for a circle; otherwise test the outline.
        if (pointInEllipse(point, e) || hitsChain(point, ellipsePoints(e, 64), tolerance)) return e;
        break;
      }
      case 'rectangle': {
        const minX = Math.min(e.first.x, e.opposite.x);
        const maxX = Math.max(e.first.x, e.opposite.x);
        const minY = Math.min(e.first.y, e.opposite.y);
        const maxY = Math.max(e.first.y, e.opposite.y);
        if (point.x >= minX - tolerance && point.x <= maxX + tolerance && point.y >= minY - tolerance && point.y <= maxY + tolerance) return e;
        break;
      }
      case 'octagon':
      case 'polyline': {
        // Test the strokes, the way the renderer draws them. Testing only the
        // vertices made a polyline pickable at its corners and nowhere else.
        const closed = e.type === 'octagon' || e.closed;
        if (hitsChain(point, closed ? closePolyline(e.vertices) : e.vertices, tolerance)) return e;
        break;
      }
      case 'arc':
      case 'bezier': {
        if (hitsChain(point, curvePoints(e), tolerance)) return e;
        break;
      }
      case 'text':
      case 'dimension': {
        const b = entityBounds(e);
        if (point.x >= b.min.x - tolerance && point.x <= b.max.x + tolerance && point.y >= b.min.y - tolerance && point.y <= b.max.y + tolerance) return e;
        break;
      }
    }
  }
  return null;
}
