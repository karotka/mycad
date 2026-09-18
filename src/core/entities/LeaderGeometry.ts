import type { Vec2 } from '../../math/geometry';
import type { LeaderEntity } from './types';

export interface LeaderGeometry {
  /** Arrow point, every corner, and the end of the shelf. */
  path: Vec2[];
  /** The three corners of the arrowhead, or empty where there is none. */
  arrow: Vec2[];
  /** Where the text starts, and which end of it that is. */
  textPoint: Vec2;
  textAnchor: 'start' | 'end';
}

/** Canonical line, arrow and text placement for one leader. */
export function leaderGeometry(entity: LeaderEntity): LeaderGeometry {
  const points = entity.points;
  if (points.length < 2) {
    const only = points[0] ?? { x: 0, y: 0 };
    return { path: [only], arrow: [], textPoint: only, textAnchor: 'start' };
  }
  const last = points[points.length - 1];
  const previous = points[points.length - 2];
  const towardsRight = last.x >= previous.x;
  const landing = Math.max(0, entity.landing) * entity.scale;
  const shelfEnd = { x: last.x + (towardsRight ? landing : -landing), y: last.y };
  const path = landing > 0 ? [...points, shelfEnd] : [...points];

  const size = entity.arrowSize * entity.scale;
  let arrow: Vec2[] = [];
  if (entity.arrowType !== 'none' && size > 0) {
    const tip = points[0];
    const next = points[1];
    const dx = next.x - tip.x, dy = next.y - tip.y;
    const length = Math.hypot(dx, dy);
    if (length > 1e-9) {
      const ux = dx / length, uy = dy / length;
      const base = { x: tip.x + ux * size, y: tip.y + uy * size };
      const half = size * (entity.arrowType === 'tick' ? 0.5 : 0.18);
      arrow = [
        tip,
        { x: base.x - uy * half, y: base.y + ux * half },
        { x: base.x + uy * half, y: base.y - ux * half },
      ];
    }
  }

  const gap = entity.textHeight * entity.scale * 0.25;
  return {
    path,
    arrow,
    textPoint: { x: shelfEnd.x + (towardsRight ? gap : -gap), y: shelfEnd.y - entity.textHeight * entity.scale / 2 },
    textAnchor: towardsRight ? 'start' : 'end',
  };
}
