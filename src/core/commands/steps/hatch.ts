import { AddEntityEdit } from '../../history/edits';
import { closedVertices, ellipsePoints, type Entity } from '../../entities/types';
import type { Vec2 } from '../../../math/geometry';
import type { CommandRun, StepOutcome } from '../types';

function boundary(entity: Entity): Vec2[] | null {
  const closed = closedVertices(entity);
  if (closed) return closed;
  if (entity.type === 'circle') return Array.from({ length: 96 }, (_, index) => {
    const angle = index * Math.PI * 2 / 96;
    return { x: entity.center.x + Math.cos(angle) * entity.radius, y: entity.center.y + Math.sin(angle) * entity.radius };
  });
  if (entity.type === 'ellipse') return ellipsePoints(entity, 96).slice(0, -1);
  return null;
}

export function createHatch(run: CommandRun): StepOutcome {
  if (run.gather(run.value)) return 'stay';
  const entities = run.data.entities as Entity[];
  const loops = entities.map(boundary).filter((loop): loop is Vec2[] => Boolean(loop && loop.length >= 3));
  if (loops.length === 0) {
    run.ctx.log('HATCH: select at least one closed polyline, rectangle, circle, ellipse or octagon.');
    return 'advance';
  }
  const hatch = run.ctx.doc.createHatch(loops);
  // The first boundary establishes the plane for the hatch.
  hatch.workPlane = entities.find((entity) => boundary(entity))?.workPlane;
  run.ctx.history.execute(new AddEntityEdit('Hatch', hatch));
  run.ctx.doc.clearSelection();
  run.ctx.doc.selectEntity(hatch.id);
  run.ctx.log(`Hatch created: ${hatch.pattern}, ${hatch.angle}°, spacing ${hatch.spacing}.`);
  return 'advance';
}
