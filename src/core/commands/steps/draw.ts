/**
 * What the drawing commands do with the points they are given.
 *
 * These were case labels in `advanceStep`, a switch of 1076 lines over 43
 * commands — the last of the big ones, and the reason adding a command still
 * cost more places than it should. A command's behaviour belongs beside its
 * declaration, and the manager keeps only what is the same for all of them:
 * prompts, the step index, sticky restarts.
 *
 * Each takes the answer and says whether the wizard should move on. Nothing here
 * touches `stepIndex` or the prompt — that is the manager's, and a command that
 * reached into it is how the two used to get out of step.
 */
import { AddEntityEdit } from '../../history/edits';
import { dist2, formatPoint, type Vec2 } from '../../../math/geometry';
import type { CommandRun, StepOutcome } from '../types';

export function drawLine({ ctx, active, data, value }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) {
    data.start = value;
    return 'advance';
  }
  const line = ctx.doc.createLine(data.start as Vec2, value as Vec2);
  ctx.history.execute(new AddEntityEdit('Line', line));
  ctx.log(`Line created: ${formatPoint(data.start as Vec2)} -> ${formatPoint(value as Vec2)}`);
  return 'advance';
}

export function drawRectangle({ ctx, active, data, value }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) {
    data.start = value;
    return 'advance';
  }
  const rectangle = ctx.doc.createRectangle(data.start as Vec2, value as Vec2);
  ctx.history.execute(new AddEntityEdit('Rectangle', rectangle));
  ctx.log(`Rectangle created: ${formatPoint(data.start as Vec2)} -> ${formatPoint(value as Vec2)}`);
  return 'advance';
}

export function drawCircle({ ctx, active, data, value }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) {
    data.center = value;
    return 'advance';
  }
  const center = data.center as Vec2;
  const radius = dist2(center, value as Vec2);
  ctx.history.execute(new AddEntityEdit('Circle', ctx.doc.createCircle(center, radius)));
  ctx.log(`Circle created: center ${formatPoint(center)}, r=${radius.toFixed(4)}`);
  return 'advance';
}

export function drawCircleByDiameter({ ctx, active, data, value }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) {
    data.center = value;
    return 'advance';
  }
  const center = data.center as Vec2;
  const diameter = dist2(center, value as Vec2);
  // Staying is how a step refuses an answer: the prompt asks again rather than
  // the command ending with nothing drawn.
  if (diameter < 1e-9) {
    ctx.log('Diameter must be greater than zero.');
    return 'stay';
  }
  ctx.history.execute(new AddEntityEdit('Circle', ctx.doc.createCircle(center, diameter / 2)));
  ctx.log(`Circle created: center ${formatPoint(center)}, Ø${diameter.toFixed(4)}`);
  return 'advance';
}

export function drawOctagon({ ctx, active, data, value }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) {
    data.center = value;
    return 'advance';
  }
  const center = data.center as Vec2;
  const radius = dist2(center, value as Vec2);
  ctx.history.execute(new AddEntityEdit('Osmiuhelnik', ctx.doc.createOctagon(center, radius)));
  ctx.log(`Octagon created: center ${formatPoint(center)}, r=${radius.toFixed(4)}`);
  return 'advance';
}

export function drawEllipse({ ctx, active, data, value }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) {
    data.center = value;
    return 'advance';
  }
  if (active.stepIndex === 1) {
    data.axisPoint = value;
    return 'advance';
  }
  const center = data.center as Vec2;
  const axis = data.axisPoint as Vec2;
  const radiusX = dist2(center, axis);
  const rotation = Math.atan2(axis.y - center.y, axis.x - center.x);
  // The second axis is measured perpendicular to the first, so take the
  // cursor's distance in the ellipse's own frame.
  const cursor = value as Vec2;
  const radiusY = Math.abs(-(cursor.x - center.x) * Math.sin(rotation) + (cursor.y - center.y) * Math.cos(rotation));
  if (radiusX < 1e-9 || radiusY < 1e-9) {
    ctx.log('Ellipse radii must be greater than zero.');
    return 'stay';
  }
  ctx.history.execute(new AddEntityEdit('Ellipse', ctx.doc.createEllipse(center, radiusX, radiusY, rotation)));
  ctx.log(`Ellipse created: RX ${radiusX.toFixed(3)}, RY ${radiusY.toFixed(3)}`);
  return 'advance';
}
