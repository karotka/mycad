/**
 * What a B-rep edge is, said in the vocabulary the drawing uses.
 *
 * Everything else in this folder goes the other way: a drawn curve becomes
 * edges on the way to making something solid out of it. Nothing came back —
 * which is why a section through a part, a curve projected onto a face and a
 * hidden-line view all had nowhere to put their answer. This is the one
 * missing direction, and all three are built on it.
 *
 * A line stays a line and a circle stays a circle, exactly; anything else is
 * converted to the chain of cubics that traces it, which is exact for a spline
 * of degree three and a close fit above that.
 */
import type { Point3 } from './GeometryKernel';

/** A curve in world space, in terms the drawing has an entity for. */
export type KernelCurve =
  | { kind: 'line'; start: Point3; end: Point3 }
  | {
    kind: 'arc';
    center: Point3;
    normal: Point3;
    xAxis: Point3;
    radius: number;
    /** Measured from `xAxis` about `normal`. A full turn is a circle. */
    startAngle: number;
    sweepAngle: number;
  }
  | { kind: 'spline'; start: Point3; segments: Array<{ control1: Point3; control2: Point3; end: Point3 }> };

/** How finely a curve that is neither a line nor a circle is followed when it
 *  has to be fitted rather than converted — a hundredth of a millimetre is far
 *  below anything a drawing is read to. */
export const CURVE_TOLERANCE = 0.01;

export function curveLength(curve: KernelCurve): number {
  if (curve.kind === 'line') return Math.hypot(curve.end.x - curve.start.x, curve.end.y - curve.start.y, curve.end.z - curve.start.z);
  if (curve.kind === 'arc') return Math.abs(curve.sweepAngle) * curve.radius;
  // The control polygon is longer than the curve and the chord shorter, so
  // their mean is a good enough measure of "is there anything here at all".
  let polygon = 0;
  let chord = 0;
  let previous = curve.start;
  for (const segment of curve.segments) {
    polygon += distance(previous, segment.control1) + distance(segment.control1, segment.control2) + distance(segment.control2, segment.end);
    chord += distance(previous, segment.end);
    previous = segment.end;
  }
  return (polygon + chord) / 2;
}

function distance(a: Point3, b: Point3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}
