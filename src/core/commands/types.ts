/**
 * Shared vocabulary for commands. Only types live here, so the registry and the
 * CommandManager can both depend on it — and on each other — without a runtime
 * cycle.
 */
import type { Document } from '../Document';
import type { CommandHistory } from '../history/CommandHistory';
import type { Entity } from '../entities/types';
import type { Vec2, Vec3 } from '../../math/geometry';
import type { CommandName } from './registry';

/** Everything a command is allowed to reach outside itself. */
export interface CommandContext {
  doc: Document;
  log: (msg: string) => void;
  prompt: (msg: string) => void;
  getCursor: () => Vec2;
  redraw: () => void;
  history: CommandHistory;
  /** Moves objects as a single step in the history, however many there are. */
  moveObjects: (objects: ReadonlyArray<Entity | string>, screenDelta: Vec2, worldDelta?: Vec3) => void;
  copyWorldDelta: (viewDelta: Vec2) => Vec3 | undefined;
  workPlaneChanged?: () => void;
}

/**
 * What a step did with the answer it was given.
 *
 * `advance` moves to the next step, and to the end if there is none — which is
 * what a command that finished says. `stay` leaves the command where it is, for
 * a step that gathers more than one answer, or one that refused this one.
 */
export type StepOutcome = 'advance' | 'stay';

/**
 * One answer, and everything a command needs to act on it.
 *
 * The manager runs the wizard — prompts, step index, sticky restarts — and a
 * command's `execute` only decides what the answer *means*. Everything that
 * used to be `this.` in a 1000-line switch is here, so a command's behaviour
 * can live beside its declaration instead of in a case label.
 */
export interface CommandRun {
  readonly ctx: CommandContext;
  readonly active: ActiveCommand;
  readonly step: CommandStep;
  /** The point, number, text, entity or solid id the step was answered with. */
  readonly value: unknown;
  /** Shorthand for `active.data` — the per-run bag every command reads. */
  readonly data: Record<string, unknown>;
  /**
   * Puts a picked object into the gathered set: an entity whole, a solid by the
   * id the viewport names it with. False when there was nothing to take, which
   * is Enter at a multi-object step.
   */
  gather(value: unknown): boolean;
  /** Ends the run without finishing it, for a command with nothing to do. */
  cancel(): void;
}

/** One run of a command: its steps, where it is in them, and what it gathered. */
export interface ActiveCommand {
  name: CommandName;
  steps: CommandStep[];
  stepIndex: number;
  data: Record<string, unknown>;
  preview?: (cursor: Vec2) => void;
  cancel?: () => void;
}

/** What a pick step is willing to take from the viewport. */
export type PickTarget = 'entity' | 'solid';

/**
 * `multi` marks a step that collects a set of objects and ends on Enter; it is
 * what makes window select available. `additive` only means a pick extends the
 * selection instead of replacing it — a step that advances on every pick (the
 * boolean operations) needs that without accepting a window. Interaction code
 * must ask the step for these, never the command name.
 */
export type CommandStep =
  /**
   * `ignoresDirection` marks a point that is a placement rather than a direction
   * from the base, so Ortho and Polar have nothing to say about it and must not
   * touch it. A box's opposite corner is one: snapping it onto an axis through
   * the first corner collapses the shape to nothing. So is a dimension line's
   * location — an axis through the first measurement point means nothing there.
   */
  | { kind: 'point'; label: string; optional?: boolean; ignoresDirection?: boolean }
  | { kind: 'number'; label: string; optional?: boolean }
  | { kind: 'entity'; label: string; optional?: boolean; multi?: boolean; additive?: boolean; accepts?: PickTarget[] }
  | { kind: 'solid'; label: string; optional?: boolean; multi?: boolean; additive?: boolean }
  | { kind: 'edge'; label: string; optional?: boolean }
  | { kind: 'text'; label: string; optional?: boolean }
  | { kind: 'done' };
