/**
 * A helix as a chain of cubic Beziers.
 *
 * Nothing in the drawing is a helix in its own right, and nothing needs to be:
 * SWEEP, EXTRUDE Path and the grip editing all take a spline, so a helix that
 * is a spline arrives already usable by them. It is generated rather than
 * fitted, so the spring a thread is swept along is as exact as the arithmetic
 * below and does not drift with the number of turns.
 *
 * Points carry their own elevation (`Vec2 & { z?: number }`, the convention
 * every curve bent through space uses here), so the curve stands up out of the
 * plane it is drawn on.
 */
import type { Vec2 } from './geometry';

export interface HelixOptions {
  /** Centre of the base circle, in the plane the helix is drawn on. */
  center: Vec2;
  baseRadius: number;
  /** Differs from the base to give a cone; equal gives a cylinder. */
  topRadius: number;
  /** Total rise. Zero is legal and draws a flat spiral. */
  height: number;
  turns: number;
  /** Anticlockwise seen from above unless this says otherwise. */
  clockwise?: boolean;
}

export interface HelixCurve {
  start: Vec2 & { z: number };
  segments: { control1: Vec2 & { z: number }; control2: Vec2 & { z: number }; end: Vec2 & { z: number } }[];
}

/** A quarter turn per segment: the error of a cubic against a true quarter
 *  circle is under three parts in ten thousand of the radius, which is finer
 *  than anything downstream measures. */
const MAX_SPAN = Math.PI / 2;

/**
 * The curve, or null when the numbers describe nothing that can be drawn —
 * no turns, or a helix with neither radius nor rise.
 */
export function helixCurve(options: HelixOptions): HelixCurve | null {
  const { center, baseRadius, topRadius, height, turns } = options;
  if (!(turns > 0)) return null;
  if (!(baseRadius >= 0) || !(topRadius >= 0)) return null;
  if (baseRadius < 1e-9 && topRadius < 1e-9) return null;
  if (Math.abs(height) < 1e-9 && Math.abs(topRadius - baseRadius) < 1e-9) return null;

  const total = Math.PI * 2 * turns * (options.clockwise ? -1 : 1);
  const spans = Math.max(1, Math.ceil(Math.abs(total) / MAX_SPAN));
  const step = total / spans;
  // The handle length that makes a cubic match a circular arc of this angle,
  // as a multiple of the derivative with respect to the angle. For a plain
  // circle that derivative is the radius and this is the familiar
  // (4/3)·tan(θ/4)·R; letting the radius and the height vary with the angle
  // then carries a cone and the rise along with it.
  const handle = (4 / 3) * Math.tan(step / 4);

  const radiusAt = (t: number) => baseRadius + (topRadius - baseRadius) * (t / total);
  const radiusRate = (topRadius - baseRadius) / total;
  const riseRate = height / total;
  const at = (t: number): Vec2 & { z: number } => {
    const radius = radiusAt(t);
    return { x: center.x + Math.cos(t) * radius, y: center.y + Math.sin(t) * radius, z: riseRate * t };
  };
  // How the point moves per radian: the radius growing outwards plus the turn
  // itself, and the steady climb.
  const velocity = (t: number) => {
    const radius = radiusAt(t);
    return {
      x: radiusRate * Math.cos(t) - radius * Math.sin(t),
      y: radiusRate * Math.sin(t) + radius * Math.cos(t),
      z: riseRate,
    };
  };

  const start = at(0);
  const segments: HelixCurve['segments'] = [];
  for (let index = 0; index < spans; index++) {
    const a = step * index, b = step * (index + 1);
    const from = at(a), to = at(b);
    const va = velocity(a), vb = velocity(b);
    segments.push({
      control1: { x: from.x + va.x * handle, y: from.y + va.y * handle, z: from.z + va.z * handle },
      control2: { x: to.x - vb.x * handle, y: to.y - vb.y * handle, z: to.z - vb.z * handle },
      end: to,
    });
  }
  return { start, segments };
}

/** The length of the curve, for the line the command logs. Exact for a
 *  cylindrical helix, and a fine approximation for a conical one. */
export function helixLength(options: HelixOptions): number {
  const { baseRadius, topRadius, height, turns } = options;
  const total = Math.PI * 2 * turns;
  const mean = (baseRadius + topRadius) / 2;
  return Math.hypot(mean * total, height);
}
