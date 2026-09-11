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
import { dist2, formatPoint, type Vec2, type Vec3 } from '../../../math/geometry';
import { textStepValue, type CommandRun, type StepOutcome } from '../types';
import type { BezierSegment, Entity } from '../../entities/types';
import type { MlineStyle } from '../../settings';
import { cloneWorkPlane, localToWorld, workPlaneFromXYAxes, worldToLocal, WORLD_WORK_PLANE, type WorkPlane } from '../../../math/workplane';
import { interpolatingBeziers, interpolatingBeziers3 } from '../../../math/bezierFit';
import { arcFromSagitta } from '../../../math/arcFit';

function keepCommandDrawingPlane<T extends Entity>(entity: T, data: Record<string, unknown>): T {
  const plane = data.drawingPlane as WorkPlane | undefined;
  if (plane) entity.workPlane = plane;
  return entity;
}

/**
 * Whether every point in `points` lies within `tolerance` of the plane fit
 * through the first three that are not collinear — fewer than 3 points, or
 * no non-collinear triple found among them, counts as coplanar (there is no
 * plane for them to violate). Used to tell a genuinely flat curve (built
 * the ordinary way, in one plane's own local frame, unchanged from before)
 * from one whose points came from different Dynamic UCS faces in turn — a
 * free-form 3D spline — which needs building in world space instead.
 */
export function worldPointsAreCoplanar(points: readonly Vec3[], tolerance = 1e-6): boolean {
  if (points.length < 3) return true;
  const origin = points[0];
  let normal: Vec3 | null = null;
  for (let index = 1; index < points.length - 1 && !normal; index++) {
    const a = { x: points[index].x - origin.x, y: points[index].y - origin.y, z: points[index].z - origin.z };
    const b = { x: points[index + 1].x - origin.x, y: points[index + 1].y - origin.y, z: points[index + 1].z - origin.z };
    const cross = { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
    const length = Math.hypot(cross.x, cross.y, cross.z);
    if (length > 1e-9) normal = { x: cross.x / length, y: cross.y / length, z: cross.z / length };
  }
  if (!normal) return true; // every point collinear — no plane to violate
  return points.every((point) => {
    const offset = (point.x - origin.x) * normal!.x + (point.y - origin.y) * normal!.y + (point.z - origin.z) * normal!.z;
    return Math.abs(offset) <= tolerance;
  });
}

/** `world`, expressed in `plane`'s own local frame, keeping its elevation
 *  off that plane as `z` — the per-point counterpart to a whole entity's
 *  flat `Vec2` points, for a curve that is not flat in any one plane. */
function localWithElevation(plane: WorkPlane, world: Vec3): Vec2 & { z: number } {
  const local = worldToLocal(plane, world);
  return { x: local.x, y: local.y, z: local.z };
}

/** The straight-line interpolation a Bezier's own control points use to
 *  retrace a plain line exactly (1/3 and 2/3 of the way from `from` to
 *  `to`) — used identically for both the local-2D closing segment below and
 *  its world-space counterpart, so the two never drift apart. */
function thirdsBetween<T extends { x: number; y: number; z?: number }>(from: T, to: T): [T, T] {
  const lerp = (t: number): T => ({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    ...(from.z !== undefined && to.z !== undefined ? { z: from.z + (to.z - from.z) * t } : {}),
  } as T);
  return [lerp(1 / 3), lerp(2 / 3)];
}

export function drawLine({ ctx, active, data, value }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) {
    data.start = value;
    return 'advance';
  }
  const line = keepCommandDrawingPlane(ctx.doc.createLine(data.start as Vec2, value as Vec2), data);
  ctx.history.execute(new AddEntityEdit('Line', line));
  ctx.log(`Line created: ${formatPoint(data.start as Vec2)} -> ${formatPoint(value as Vec2)}`);
  return 'advance';
}

export function drawRectangle({ ctx, active, data, value }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) {
    data.start = value;
    return 'advance';
  }
  const rectangle = keepCommandDrawingPlane(ctx.doc.createRectangle(data.start as Vec2, value as Vec2), data);
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
  ctx.history.execute(new AddEntityEdit('Circle', keepCommandDrawingPlane(ctx.doc.createCircle(center, radius), data)));
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
  ctx.history.execute(new AddEntityEdit('Circle', keepCommandDrawingPlane(ctx.doc.createCircle(center, diameter / 2), data)));
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
  ctx.history.execute(new AddEntityEdit('Osmiuhelnik', keepCommandDrawingPlane(ctx.doc.createOctagon(center, radius), data)));
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
  ctx.history.execute(new AddEntityEdit('Ellipse', keepCommandDrawingPlane(ctx.doc.createEllipse(center, radiusX, radiusY, rotation), data)));
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
  ctx.history.execute(new AddEntityEdit('Arc', keepCommandDrawingPlane(ctx.doc.createArc(center, radius, startAngle, sweep), data)));
  ctx.log(`Arc created: center ${formatPoint(center)}, r=${radius.toFixed(4)}, ${(sweep * 180 / Math.PI).toFixed(2)}°`);
  return 'advance';
}

/**
 * Arc by start point, end point and radius — AutoCAD's Start,End,Radius
 * method, but resolved like a rubber-band drag rather than a typed sign: the
 * third point's perpendicular distance from the chord (its sagitta) is the
 * radius, and which side of the chord it's on is which way the arc bulges —
 * see `arcFromSagitta`. Dragging past the resulting radius reaches the major
 * arc on its own, with no separate mode to switch into.
 */
export function drawArcStartEndRadius({ ctx, active, data, value }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) {
    data.start = value;
    const world = (value as Vec2 & { world?: Vec3 }).world;
    if (world) data.startWorld = world;
    return 'advance';
  }
  if (active.stepIndex === 1) {
    // Start and end can each snap independently off the UCS — Nearest onto
    // two different points of a curve that is not itself parallel to it, a
    // closed profile's own silhouette being the ordinary case. The plane
    // established from start alone only ever passes through start; nothing
    // says end also lies on it. Refit one that actually contains both real
    // points when it does not, keeping the UCS's own normal as the "up"
    // reference — the same direction a plain, on-UCS arc would bulge in —
    // and re-express the already-accepted start point against it too.
    const plane = data.drawingPlane as WorkPlane | undefined;
    const startWorld = data.startWorld as Vec3 | undefined;
    const endWorld = (value as Vec2 & { world?: Vec3 }).world;
    if (plane && startWorld && endWorld) {
      const localEnd = worldToLocal(plane, endWorld);
      if (Math.abs(localEnd.z) > 1e-6) {
        // The chord (start→end) becomes the new plane's X axis exactly, so
        // both real points land on it precisely; the established plane's own
        // Y axis — what the bulge would already have used, had end turned
        // out to sit on that first plane after all — is only a *reference*
        // now, refit to whatever is left perpendicular to the chord.
        const yReference = { x: startWorld.x + plane.yAxis.x, y: startWorld.y + plane.yAxis.y, z: startWorld.z + plane.yAxis.z };
        const refit = workPlaneFromXYAxes(startWorld, endWorld, yReference);
        data.drawingPlane = refit;
        const start2d = worldToLocal(refit, startWorld);
        const end2d = worldToLocal(refit, endWorld);
        data.start = { x: start2d.x, y: start2d.y };
        data.end = { x: end2d.x, y: end2d.y };
        return 'advance';
      }
    }
    data.end = value;
    return 'advance';
  }

  const start = data.start as Vec2, end = data.end as Vec2, third = value as Vec2;
  const arc = arcFromSagitta(start, end, third);
  if (!arc) { ctx.log('Arc failed: point must be off the line between start and end.'); return 'stay'; }

  ctx.history.execute(new AddEntityEdit('Arc', keepCommandDrawingPlane(ctx.doc.createArc(arc.center, arc.radius, arc.startAngle, arc.sweepAngle), data)));
  ctx.log(`Arc created: ${formatPoint(start)} -> ${formatPoint(end)}, r=${arc.radius.toFixed(4)}, ${(arc.sweepAngle * 180 / Math.PI).toFixed(2)}°`);
  return 'advance';
}

/**
 * Spline (CV): every point after the start is a control point. The first four
 * points make one cubic segment (start, control1, control2, end); each further
 * run of three continues the chain onto a new one. Unlike SPLINE's fit points,
 * these shape the curve without the curve passing through them — except at the
 * anchors where segments join.
 */
export function drawBezier(run: CommandRun): StepOutcome {
  const { data, value, ctx } = run;
  const points = (data.points as Vec2[] | undefined) ?? (data.points = []);
  // In lockstep with `points`, but true world 3D — carried so a point placed
  // by hovering a different Dynamic UCS face than the last one (BEZIER's own
  // per-point re-acquisition, see DynamicUcsCoordinator) keeps its real
  // elevation instead of being silently flattened through `points`' own
  // single shared local frame. Reported directly: drawn on a box by hovering
  // a different face for each point, the spline still came out flat.
  const worldPoints = (data.worldPoints as Vec3[] | undefined) ?? (data.worldPoints = []);
  const point = value as (Vec2 & { world?: Vec3 }) | null;

  if (point) {
    points.push({ x: point.x, y: point.y });
    worldPoints.push(point.world ?? localToWorld(ctx.doc.activeWorkPlane, point));
    // Same reason drawPolyline and drawSpline keep this current: it is what
    // ortho, polar and the rubber-band preview track from.
    data.start = { x: point.x, y: point.y };
    if (points.length <= 4) return 'advance';
    if ((points.length - 1) % 3 === 0) {
      ctx.log(`Segment ${(points.length - 1) / 3} added. Enter to finish, C to close, or 3 more points to continue.`);
    }
    return 'stay';
  }

  // Enter only reaches here once the mandatory first segment (4 points) is
  // already down — every point before that is on a mandatory step. C asks
  // for the same thing and closes the loop, same as POLYLINE's own C.
  const closing = data.closing === true;
  const leftover = (points.length - 1) % 3;
  if (leftover > 0) ctx.log(`Ignored ${leftover} trailing point(s) — not enough left to complete another segment.`);
  const segments: BezierSegment[] = [];
  const worldSegments: Array<{ control1: Vec3; control2: Vec3; end: Vec3 }> = [];
  for (let index = 1; index + 2 <= points.length - 1 - leftover; index += 3) {
    segments.push({ control1: points[index], control2: points[index + 1], end: points[index + 2] });
    worldSegments.push({ control1: worldPoints[index], control2: worldPoints[index + 1], end: worldPoints[index + 2] });
  }
  if (closing) {
    // A Bezier has no separate "closed" flag the way a polyline does — LOFT,
    // EXTRUDE and SWEEP recognise a closed one only by its last segment's end
    // exactly meeting its start (see isClosedBezierEntity), which a hand-drawn
    // final point could never land on exactly. The closing segment is a
    // straight line back to the start, matching what POLYLINE's own C draws.
    const start = points[0];
    const last = segments.at(-1)?.end ?? start;
    if (dist2(last, start) > 1e-9) {
      const [control1, control2] = thirdsBetween(last, start);
      segments.push({ control1, control2, end: { x: start.x, y: start.y } });
      const worldStart = worldPoints[0];
      const worldLast = worldSegments.at(-1)?.end ?? worldStart;
      const [worldControl1, worldControl2] = thirdsBetween(worldLast, worldStart);
      worldSegments.push({ control1: worldControl1, control2: worldControl2, end: worldStart });
    }
  }
  // A flat curve (still the ordinary case — DUCS never moved, or was never
  // used at all) builds exactly as before, in its own drawing plane's local
  // frame. Only a genuinely 3D one — points from more than one Dynamic UCS
  // face — needs building in world space instead, each point keeping its
  // own elevation.
  const flat = worldPointsAreCoplanar([...worldPoints, ...worldSegments.flatMap((s) => [s.control1, s.control2, s.end])]);
  const bezier = flat
    ? keepCommandDrawingPlane(ctx.doc.createSpline(points[0], segments), data)
    : ctx.doc.createSpline(
      localWithElevation(WORLD_WORK_PLANE, worldPoints[0]),
      worldSegments.map((segment) => ({
        control1: localWithElevation(WORLD_WORK_PLANE, segment.control1),
        control2: localWithElevation(WORLD_WORK_PLANE, segment.control2),
        end: localWithElevation(WORLD_WORK_PLANE, segment.end),
      })),
    );
  if (!flat) bezier.workPlane = cloneWorkPlane(WORLD_WORK_PLANE);
  ctx.history.execute(new AddEntityEdit('Bezier', bezier));
  ctx.log(`Bezier created: ${segments.length} segment(s)${closing ? ', closed' : ''}${flat ? '' : ', bent through 3D'}.`);
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
  ctx.history.execute(new AddEntityEdit('Polygon', keepCommandDrawingPlane(ctx.doc.createPolyline(vertices, true), data)));
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

  const { text: content, height, font } = textStepValue(value);
  const text = keepCommandDrawingPlane(ctx.doc.createText(data.position as Vec2, content, height ?? (data.height as number), font ?? (data.font as string)), data);
  ctx.history.execute(new AddEntityEdit('Text', text));
  ctx.log(`Text created: "${text.text}" in ${text.font}`);
  return 'advance';
}

/**
 * A chain of points, ended by Enter or closed with C.
 *
 * The one command whose step repeats, which the step model still has no way to
 * say — so the vertex step is `optional` and this returns 'stay' to hold the
 * wizard there. Its finish used to restart the command by hand; returning
 * 'advance' walks off the end of the steps, and sticky does the rest.
 */
export function drawPolyline(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  const vertices = data.vertices as Vec2[];
  const point = value as Vec2 | null;

  if (point) {
    vertices.push({ x: point.x, y: point.y });
    // `start` is what ortho, polar and the preview track from, so keeping it on
    // the last vertex makes the rubber band follow each segment.
    data.start = { x: point.x, y: point.y };
    if (active.stepIndex === 0) return 'advance';
    ctx.log(`Vertex ${vertices.length} added. Enter to finish, C to close.`);
    return 'stay';
  }

  // Enter finishes; C asks for the same thing and joins the ends.
  const closing = data.closing === true;
  if (vertices.length < 2) {
    ctx.log('A polyline needs at least two points.');
    run.cancel();
    return 'advance';
  }
  if (closing && vertices.length < 3) {
    ctx.log('A closed polyline needs at least three points.');
    delete data.closing;
    return 'stay';
  }
  const polyline = keepCommandDrawingPlane(ctx.doc.createPolyline(vertices.map((vertex) => ({ ...vertex })), closing), data);
  ctx.history.execute(new AddEntityEdit('Polyline', polyline));
  ctx.log(`Polyline created: ${vertices.length} vertices${closing ? ', closed' : ''}.`);
  return 'advance';
}

/**
 * MLINE — same point-gathering shape as POLYLINE (including the C-to-close
 * keyword, handled the same generic way in CommandManager), but against the
 * document's current MLSTYLE rather than a bare centerline.
 */
export function drawMline(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  const vertices = data.vertices as Vec2[];
  const point = value as Vec2 | null;

  if (point) {
    vertices.push({ x: point.x, y: point.y });
    data.start = { x: point.x, y: point.y };
    if (active.stepIndex === 0) return 'advance';
    ctx.log(`Vertex ${vertices.length} added. Enter to finish, C to close.`);
    return 'stay';
  }

  const closing = data.closing === true;
  if (vertices.length < 2) {
    ctx.log('An MLINE needs at least two points.');
    run.cancel();
    return 'advance';
  }
  if (closing && vertices.length < 3) {
    ctx.log('A closed MLINE needs at least three points.');
    delete data.closing;
    return 'stay';
  }
  const style = data.mlineStyle as MlineStyle;
  const mline = keepCommandDrawingPlane(ctx.doc.createMline(vertices.map((vertex) => ({ ...vertex })), closing, style), data);
  ctx.history.execute(new AddEntityEdit('Mline', mline));
  ctx.log(`Mline created: ${vertices.length} vertices${closing ? ', closed' : ''} (${style.name}).`);
  return 'advance';
}

/** How closely a DXF SPLINE import's Bezier-chain approximation must hug the
 *  points sampled off the true NURBS curve — tight enough that the deviation
 *  never reads as anything but the original curve. SPLINE drawn by hand uses
 *  `interpolatingBeziers` instead, which passes through every point exactly
 *  regardless of tolerance. */
export const SPLINE_FIT_TOLERANCE = 0.01;

/** Whether every world point sits at the same elevation on `plane` — the
 *  exact condition SPLINE's flat fit path needs, since a fit-point curve has
 *  no elevation field of its own beyond the one shared plane it is built in.
 *  Unlike `worldPointsAreCoplanar` (fits *some* plane through the points,
 *  which even two points always trivially satisfy), this checks the plane
 *  the flat path actually uses — so two points landing on different Dynamic
 *  UCS faces are correctly "not flat" even though any two points are always
 *  coplanar with each other. */
function worldPointsShareElevation(plane: WorkPlane, points: readonly Vec3[]): boolean {
  if (points.length === 0) return true;
  const z0 = worldToLocal(plane, points[0]).z;
  return points.every((point) => Math.abs(worldToLocal(plane, point).z - z0) < 1e-6);
}

export function drawSpline(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  const points = data.points as Vec2[];
  // In lockstep with `points`, but true world 3D — see drawBezier's own
  // worldPoints comment; the same per-point Dynamic UCS re-acquisition
  // applies to a fit-point spline as to a control-point one.
  const worldPoints = (data.worldPoints as Vec3[] | undefined) ?? (data.worldPoints = []);
  const point = value as (Vec2 & { world?: Vec3 }) | null;

  if (point) {
    points.push({ x: point.x, y: point.y });
    worldPoints.push(point.world ?? localToWorld(ctx.doc.activeWorkPlane, point));
    // Same reason drawPolyline keeps this current: it is what ortho, polar
    // and the rubber-band preview track from.
    data.start = { x: point.x, y: point.y };
    if (active.stepIndex === 0) return 'advance';
    ctx.log(`Point ${points.length} added. Enter to finish.`);
    return 'stay';
  }

  if (points.length < 2) {
    ctx.log('A spline needs at least two points.');
    run.cancel();
    return 'advance';
  }
  const flat = worldPointsShareElevation(ctx.doc.activeWorkPlane, worldPoints);
  if (flat) {
    const fits = interpolatingBeziers(points);
    if (fits.length === 0) {
      ctx.log('SPLINE failed to fit a curve through these points.');
      run.cancel();
      return 'advance';
    }
    const spline = keepCommandDrawingPlane(
      ctx.doc.createSpline(fits[0].start, fits.map((fit) => ({ control1: fit.control1, control2: fit.control2, end: fit.end }))),
      data,
    );
    ctx.history.execute(new AddEntityEdit('Spline', spline));
    ctx.log(`Spline created: ${points.length} fit point(s), ${fits.length} segment(s).`);
    return 'advance';
  }
  const fits = interpolatingBeziers3(worldPoints);
  if (fits.length === 0) {
    ctx.log('SPLINE failed to fit a curve through these points.');
    run.cancel();
    return 'advance';
  }
  const spline = ctx.doc.createSpline(
    localWithElevation(WORLD_WORK_PLANE, fits[0].start),
    fits.map((fit) => ({
      control1: localWithElevation(WORLD_WORK_PLANE, fit.control1),
      control2: localWithElevation(WORLD_WORK_PLANE, fit.control2),
      end: localWithElevation(WORLD_WORK_PLANE, fit.end),
    })),
  );
  spline.workPlane = cloneWorkPlane(WORLD_WORK_PLANE);
  ctx.history.execute(new AddEntityEdit('Spline', spline));
  ctx.log(`Spline created: ${points.length} fit point(s), ${fits.length} segment(s), bent through 3D.`);
  return 'advance';
}
