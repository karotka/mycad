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

export function drawArc({ ctx, active, data, value }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) { data.center = value; return 'advance'; }
  if (active.stepIndex === 1) { data.start = value; return 'advance'; }

  const center = data.center as Vec2, start = data.start as Vec2, end = value as Vec2;
  const radius = dist2(center, start);
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  let sweep = Math.atan2(end.y - center.y, end.x - center.x) - startAngle;
  // Always the long way round rather than backwards: an arc is drawn
  // anticlockwise from its start, so a negative sweep is the same arc named
  // from the other end.
  if (sweep <= 0) sweep += Math.PI * 2;
  ctx.history.execute(new AddEntityEdit('Arc', ctx.doc.createArc(center, radius, startAngle, sweep)));
  ctx.log(`Arc created: center ${formatPoint(center)}, r=${radius.toFixed(4)}, ${(sweep * 180 / Math.PI).toFixed(2)}°`);
  return 'advance';
}

export function drawBezier({ ctx, active, data, value }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) { data.start = value; return 'advance'; }
  if (active.stepIndex === 1) { data.control1 = value; return 'advance'; }
  if (active.stepIndex === 2) { data.control2 = value; return 'advance'; }

  const bezier = ctx.doc.createBezier(data.start as Vec2, data.control1 as Vec2, data.control2 as Vec2, value as Vec2);
  ctx.history.execute(new AddEntityEdit('Bezier', bezier));
  ctx.log(`Bezier created: ${formatPoint(data.start as Vec2)} -> ${formatPoint(value as Vec2)}`);
  return 'advance';
}

export function drawPolygon({ ctx, active, data, value }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) { data.center = value; return 'advance'; }
  if (active.stepIndex === 1) {
    const sides = Math.round(value as number);
    if (sides < 3 || sides > 128) {
      ctx.log('The number of sides must be an integer from 3 to 128.');
      return 'stay';
    }
    data.sides = sides;
    return 'advance';
  }

  const center = data.center as Vec2;
  const cursor = value as Vec2;
  const sides = data.sides as number;
  // The cursor gives the apothem — the perpendicular distance to a side — so
  // the polygon's corners sit further out than the point that placed it.
  const apothem = dist2(center, cursor);
  if (apothem <= 0) {
    ctx.log('The polygon must have a size.');
    return 'stay';
  }
  const radius = apothem / Math.cos(Math.PI / sides);
  const normalAngle = Math.atan2(cursor.y - center.y, cursor.x - center.x);
  const vertices: Vec2[] = [];
  for (let index = 0; index < sides; index++) {
    const angle = normalAngle + Math.PI / sides + index * Math.PI * 2 / sides;
    vertices.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
  }
  ctx.history.execute(new AddEntityEdit('Polygon', ctx.doc.createPolyline(vertices, true)));
  ctx.log(`Polygon created: ${sides} sides, apothem=${apothem.toFixed(3)} mm`);
  return 'advance';
}

export function drawText({ ctx, active, data, value }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) { data.font = String(value); return 'advance'; }
  if (active.stepIndex === 1) {
    const height = value as number;
    if (height <= 0) {
      ctx.log('Text height must be greater than zero.');
      return 'stay';
    }
    data.height = height;
    return 'advance';
  }
  if (active.stepIndex === 2) { data.position = value; return 'advance'; }

  const text = ctx.doc.createText(data.position as Vec2, String(value), data.height as number, data.font as string);
  ctx.history.execute(new AddEntityEdit('Text', text));
  ctx.log(`Text created: "${text.text}" in ${text.font}`);
  return 'advance';
}
