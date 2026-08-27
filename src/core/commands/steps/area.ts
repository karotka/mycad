import { dist2, type Vec2 } from '../../../math/geometry';
import type { CommandRun, StepOutcome } from '../types';

function finishArea(run: CommandRun, vertices: Vec2[]): StepOutcome {
  if (vertices.length < 3) {
    run.ctx.log('AREA: specify at least three points.');
    return 'stay';
  }
  let twiceArea = 0;
  let perimeter = 0;
  for (let index = 0; index < vertices.length; index++) {
    const point = vertices[index], next = vertices[(index + 1) % vertices.length];
    twiceArea += point.x * next.y - next.x * point.y;
    perimeter += dist2(point, next);
  }
  const area = Math.abs(twiceArea) / 2;
  run.ctx.log(`Area = ${area.toFixed(3)} mm², Perimeter = ${perimeter.toFixed(3)} mm`);
  return 'advance';
}

export function measureArea(run: CommandRun): StepOutcome {
  const vertices = run.data.vertices as Vec2[];
  const point = run.value as Vec2 | null;
  if (!point) return finishArea(run, vertices);

  if (run.active.stepIndex > 0 && vertices.length > 0 && dist2(vertices[0], point) <= 1e-7) {
    if (vertices.length < 3) {
      run.ctx.log('AREA: specify at least three points before closing.');
      return 'stay';
    }
    return finishArea(run, vertices);
  }
  vertices.push({ x: point.x, y: point.y });
  run.data.start = { x: point.x, y: point.y };
  if (run.active.stepIndex === 0) return 'advance';
  run.ctx.log(`AREA: point ${vertices.length} added. Enter or click the first point to finish.`);
  return 'stay';
}
