/**
 * A cosmetic thread on a hole or a shaft.
 *
 * The user clicks a circular edge (a solid through-hole rim, or a plain circle),
 * confirms internal/external, and takes a metric size — pre-guessed from the
 * measured diameter. Nothing is cut: the thread is the standard two-circle
 * symbol (major and minor diameter) plus an "M<n>" label, drawn on the hole's
 * own plane so it rides on the face in 3D and reads flat in the plan view.
 */
import { AddEntitiesEdit } from '../../history/edits';
import type { Entity, SolidEdgeSelection } from '../../entities/types';
import { cloneWorkPlane, workPlaneFromXAxis, WORLD_WORK_PLANE, type WorkPlane } from '../../../math/workplane';
import type { Vec2 } from '../../../math/geometry';
import type { CommandRun, StepOutcome } from '../types';

interface MetricThread {
  size: number;
  pitch: number;
  /** ISO internal minor diameter D1. */
  minor: number;
  /** Recommended tapping drill — what a threaded hole is actually bored to. */
  tapDrill: number;
}

// ISO 261 coarse-pitch metric threads, the everyday range.
const METRIC_THREADS: MetricThread[] = [
  { size: 2, pitch: 0.40, minor: 1.567, tapDrill: 1.60 },
  { size: 2.5, pitch: 0.45, minor: 2.013, tapDrill: 2.05 },
  { size: 3, pitch: 0.50, minor: 2.459, tapDrill: 2.50 },
  { size: 4, pitch: 0.70, minor: 3.242, tapDrill: 3.30 },
  { size: 5, pitch: 0.80, minor: 4.134, tapDrill: 4.20 },
  { size: 6, pitch: 1.00, minor: 4.917, tapDrill: 5.00 },
  { size: 8, pitch: 1.25, minor: 6.647, tapDrill: 6.80 },
  { size: 10, pitch: 1.50, minor: 8.376, tapDrill: 8.50 },
  { size: 12, pitch: 1.75, minor: 10.106, tapDrill: 10.20 },
  { size: 16, pitch: 2.00, minor: 13.835, tapDrill: 14.00 },
  { size: 20, pitch: 2.50, minor: 17.294, tapDrill: 17.50 },
];

/** A shaft is measured at its major diameter; a threaded hole at its tapping drill. */
function nearestThread(diameter: number, external: boolean): MetricThread {
  const key = (thread: MetricThread): number => (external ? thread.size : thread.tapDrill);
  return METRIC_THREADS.reduce((best, thread) =>
    Math.abs(key(thread) - diameter) < Math.abs(key(best) - diameter) ? thread : best);
}

function threadForSize(size: number): MetricThread {
  return METRIC_THREADS.find((thread) => thread.size === size)
    ?? METRIC_THREADS.reduce((best, thread) =>
      Math.abs(thread.size - size) < Math.abs(best.size - size) ? thread : best);
}

/** Reads "M6", "6", "6.0" — anything else means "use the suggestion". */
function parseSize(text: string): number | null {
  const match = /^\s*m?\s*([0-9]+(?:\.[0-9]+)?)/i.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function createThread(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;

  if (active.stepIndex === 0) {
    const picked = value as Entity | SolidEdgeSelection;
    if ('type' in picked) {
      if (picked.type !== 'circle' && picked.type !== 'arc') {
        ctx.log('Thread: select a circular hole/shaft edge, or a circle.');
        return 'stay';
      }
      data.diameter = picked.radius * 2;
      data.plane = cloneWorkPlane(picked.workPlane ?? WORLD_WORK_PLANE);
      data.center = { x: picked.center.x, y: picked.center.y };
    } else if (picked.circular) {
      data.diameter = picked.circular.radius * 2;
      // The hole's own plane: origin at its centre, Z along its axis.
      data.plane = workPlaneFromXAxis(picked.circular.center, picked.start, picked.circular.normal);
      data.center = { x: 0, y: 0 };
    } else {
      ctx.log('That solid edge is not circular — pick a round hole or shaft.');
      return 'stay';
    }
    return 'advance';
  }

  if (active.stepIndex === 1) {
    const text = typeof value === 'string' ? value : '';
    data.external = /^\s*e/i.test(text);
    const suggested = nearestThread(data.diameter as number, data.external as boolean);
    data.suggested = suggested.size;
    ctx.log(`⌀${(data.diameter as number).toFixed(2)} mm ${data.external ? 'shaft' : 'hole'} → suggested M${suggested.size}. Enter size (e.g. M6) or press Enter to accept.`);
    return 'advance';
  }

  const text = typeof value === 'string' ? value : '';
  const thread = threadForSize(parseSize(text) ?? (data.suggested as number));
  const plane = data.plane as WorkPlane;
  const center = data.center as Vec2;
  const external = data.external as boolean;

  // The two-circle symbol: the nominal (major) and the root (minor) diameter.
  const outer = ctx.doc.createCircle(center, thread.size / 2);
  const inner = ctx.doc.createCircle(center, thread.minor / 2);
  const labelHeight = Math.max(1.5, thread.size * 0.6);
  const label = ctx.doc.createText(
    { x: center.x + thread.size / 2 + labelHeight, y: center.y },
    `M${thread.size}`,
    labelHeight,
  );
  for (const entity of [outer, inner, label]) entity.workPlane = cloneWorkPlane(plane);

  ctx.history.execute(new AddEntitiesEdit(`Thread M${thread.size}`, [outer, inner, label]));
  ctx.log(`Thread M${thread.size}×${thread.pitch} ${external ? 'external' : 'internal'} added.`);
  return 'advance';
}
