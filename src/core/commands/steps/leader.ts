/**
 * LEADER: a note with a line drawn from it to the thing it is about.
 *
 * Every callout on a real drawing is one of these — "2 HOLES Ø6", "BREAK SHARP
 * EDGES", "WELD ALL ROUND". Until now they were a hand-drawn line and a piece
 * of TEXT put near it, which is two objects pretending to be one: move the
 * part and the arrow stays behind, move the note and the line does not follow.
 *
 * The first point is what the arrow touches. Then as many corners as it takes
 * to get the note clear of the drawing, and the text.
 */
import { AddEntityEdit } from '../../history/edits';
import type { Vec2 } from '../../../math/geometry';
import { textStepValue, type CommandRun, type StepOutcome } from '../types';

export function drawLeader(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  const points = (data.points as Vec2[] | undefined) ?? [];

  if (active.stepIndex === 0) {
    data.points = [value as Vec2];
    return 'advance';
  }

  // The middle steps take corner after corner until Enter says that is enough.
  if (active.stepIndex === 1) {
    if (value) {
      points.push(value as Vec2);
      data.points = points;
      // Stay on this step: another corner is as welcome as the text.
      return 'stay';
    }
    if (points.length < 2) {
      ctx.log('A leader needs somewhere to point from: give at least one more point.');
      return 'stay';
    }
    return 'advance';
  }

  const text = textStepValue(value).text;
  if (!text.trim()) {
    ctx.log('A leader with nothing written on it is just a line — type the note.');
    return 'stay';
  }
  const leader = ctx.doc.createLeader(points, text);
  ctx.history.execute(new AddEntityEdit('Leader', leader));
  ctx.doc.clearSelection();
  ctx.doc.selectEntity(leader.id);
  ctx.log(`Leader created: "${text}".`);
  return 'advance';
}
