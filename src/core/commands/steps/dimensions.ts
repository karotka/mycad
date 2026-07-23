/**
 * The dimensions, and the coordinate system they are measured in.
 *
 * A linear or aligned dimension is two points and where the line goes, a radial
 * one is a circle and its leader, and an angular one is a vertex, two rays and
 * an arc placement. UCS sits here because it is the same question turned
 * around — three points that say what "horizontal" means after them.
 */
import { AddEntityEdit } from '../../history/edits';
import { dimensionGeometry, linearDimensionRotation, type Entity, type LineEntity, type SolidEdgeSelection } from '../../entities/types';
import {
  cloneWorkPlane,
  localToWorld,
  workPlaneFromXAxis,
  workPlaneFromXYAxes,
  worldToLocal,
  WORLD_WORK_PLANE,
  type WorkPlane,
} from '../../../math/workplane';
import { dist3, formatPoint, type Vec2, type Vec3 } from '../../../math/geometry';
import type { CommandRun, StepOutcome } from '../types';

type SpatialLocalPoint = Vec2 & { z?: number };

type AlignedDimensionPlacement = {
  sourceWorkPlane: WorkPlane;
  workPlane: WorkPlane;
  start: Vec2;
  end: Vec2;
  offset: Vec2;
};

type RadialDimensionSource = {
  center: Vec2;
  radius: number;
  workPlane: WorkPlane;
};

export type AngularDimensionSource = {
  workPlane: WorkPlane;
  vertex: Vec2;
  first: Vec2;
  second: Vec2;
};

type AngularLineSource = LineEntity | SolidEdgeSelection;

const flat = (point: Vec2 | Vec3): Vec2 => ({ x: point.x, y: point.y });
const pointWorld = (plane: WorkPlane, point: Vec2 | Vec3): Vec3 =>
  localToWorld(plane, flat(point), 'z' in point ? point.z : 0);

const subtract3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const addScaled3 = (point: Vec3, direction: Vec3, scale: number): Vec3 => ({
  x: point.x + direction.x * scale,
  y: point.y + direction.y * scale,
  z: point.z + direction.z * scale,
});
const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const length3 = (value: Vec3): number => Math.hypot(value.x, value.y, value.z);

function angularLine(source: AngularLineSource): { start: Vec3; end: Vec3 } | null {
  if ('type' in source) {
    if (source.type !== 'line') return null;
    const plane = source.workPlane ?? WORLD_WORK_PLANE;
    return { start: pointWorld(plane, source.start), end: pointWorld(plane, source.end) };
  }
  if (source.circular) return null;
  return { start: { ...source.start }, end: { ...source.end } };
}

function angularSourceFromLines(
  firstSource: AngularLineSource,
  secondSource: AngularLineSource,
  firstPick: Vec3 | undefined,
  secondPick: Vec3 | undefined,
  sourceWorkPlane: WorkPlane,
  keepSourcePlane: boolean,
): AngularDimensionSource | null {
  const firstLine = angularLine(firstSource);
  const secondLine = angularLine(secondSource);
  if (!firstLine || !secondLine) return null;
  const d1 = subtract3(firstLine.end, firstLine.start);
  const d2 = subtract3(secondLine.end, secondLine.start);
  const a = dot3(d1, d1), b = dot3(d1, d2), c = dot3(d2, d2);
  const between = subtract3(firstLine.start, secondLine.start);
  const d = dot3(d1, between), e = dot3(d2, between);
  const denominator = a * c - b * b;
  if (a < 1e-12 || c < 1e-12 || Math.abs(denominator) < 1e-10 * a * c) return null;
  const firstParameter = (b * e - c * d) / denominator;
  const secondParameter = (a * e - b * d) / denominator;
  const firstClosest = addScaled3(firstLine.start, d1, firstParameter);
  const secondClosest = addScaled3(secondLine.start, d2, secondParameter);
  const tolerance = Math.max(Math.sqrt(a), Math.sqrt(c), 1) * 1e-5;
  if (length3(subtract3(firstClosest, secondClosest)) > tolerance) return null;
  const vertex = {
    x: (firstClosest.x + secondClosest.x) / 2,
    y: (firstClosest.y + secondClosest.y) / 2,
    z: (firstClosest.z + secondClosest.z) / 2,
  };
  const rayPoint = (line: { start: Vec3; end: Vec3 }, direction: Vec3, pick: Vec3 | undefined): Vec3 => {
    const reference = pick ?? (length3(subtract3(line.start, vertex)) > length3(subtract3(line.end, vertex)) ? line.start : line.end);
    const sign = dot3(subtract3(reference, vertex), direction) < 0 ? -1 : 1;
    const scale = sign / length3(direction);
    return addScaled3(vertex, direction, scale);
  };
  const firstRay = rayPoint(firstLine, d1, firstPick);
  const secondRay = rayPoint(secondLine, d2, secondPick);
  const workPlane = keepSourcePlane
    ? cloneWorkPlane(sourceWorkPlane)
    : workPlaneFromXYAxes(vertex, firstRay, secondRay);
  const project = (point: Vec3): Vec2 => {
    const local = worldToLocal(workPlane, point);
    return { x: local.x, y: local.y };
  };
  return {
    workPlane,
    vertex: project(vertex),
    first: project(firstRay),
    second: project(secondRay),
  };
}

function angularSourceFromPoints(
  workPlane: WorkPlane,
  vertex: Vec2 | Vec3,
  first: Vec2 | Vec3,
  second: Vec2 | Vec3,
  keepSourcePlane: boolean,
): AngularDimensionSource | null {
  const vertexWorld = pointWorld(workPlane, vertex);
  const firstWorld = pointWorld(workPlane, first);
  const secondWorld = pointWorld(workPlane, second);
  const firstDirection = subtract3(firstWorld, vertexWorld);
  const secondDirection = subtract3(secondWorld, vertexWorld);
  const cross = {
    x: firstDirection.y * secondDirection.z - firstDirection.z * secondDirection.y,
    y: firstDirection.z * secondDirection.x - firstDirection.x * secondDirection.z,
    z: firstDirection.x * secondDirection.y - firstDirection.y * secondDirection.x,
  };
  if (length3(firstDirection) < 1e-9 || length3(secondDirection) < 1e-9 || length3(cross) < 1e-9) return null;
  const dimensionPlane = keepSourcePlane
    ? cloneWorkPlane(workPlane)
    : workPlaneFromXYAxes(vertexWorld, firstWorld, secondWorld);
  const project = (point: Vec3): Vec2 => {
    const local = worldToLocal(dimensionPlane, point);
    return { x: local.x, y: local.y };
  };
  return {
    workPlane: dimensionPlane,
    vertex: project(vertexWorld),
    first: project(firstWorld),
    second: project(secondWorld),
  };
}

function alignedPlacement(
  sourceWorkPlane: WorkPlane,
  start: Vec2 | Vec3,
  end: Vec2 | Vec3,
  offset: Vec2 | Vec3,
): AlignedDimensionPlacement | null {
  const startWorld = pointWorld(sourceWorkPlane, start);
  const endWorld = pointWorld(sourceWorkPlane, end);
  const offsetWorld = pointWorld(sourceWorkPlane, offset);
  const edge = {
    x: endWorld.x - startWorld.x,
    y: endWorld.y - startWorld.y,
    z: endWorld.z - startWorld.z,
  };
  if (Math.hypot(edge.x, edge.y, edge.z) < 1e-9) return null;
  const crossLength = (axis: Vec3): number => Math.hypot(
    edge.y * axis.z - edge.z * axis.y,
    edge.z * axis.x - edge.x * axis.z,
    edge.x * axis.y - edge.y * axis.x,
  );
  const offsetAxis = {
    x: offsetWorld.x - startWorld.x,
    y: offsetWorld.y - startWorld.y,
    z: offsetWorld.z - startWorld.z,
  };
  // The picked line location normally supplies the second axis. When it lies
  // exactly on the measured edge, use whichever UCS axis is least parallel so
  // the dimension still has a stable plane.
  let yPoint = offsetWorld;
  if (crossLength(offsetAxis) < 1e-9) {
    const fallback = [sourceWorkPlane.yAxis, sourceWorkPlane.zAxis, sourceWorkPlane.xAxis]
      .sort((a, b) => crossLength(b) - crossLength(a))[0];
    yPoint = {
      x: startWorld.x + fallback.x,
      y: startWorld.y + fallback.y,
      z: startWorld.z + fallback.z,
    };
  }
  const workPlane = workPlaneFromXYAxes(startWorld, endWorld, yPoint);
  const project = (point: Vec3): Vec2 => {
    const local = worldToLocal(workPlane, point);
    return { x: local.x, y: local.y };
  };
  return {
    sourceWorkPlane: cloneWorkPlane(sourceWorkPlane),
    workPlane,
    start: project(startWorld),
    end: project(endWorld),
    offset: project(offsetWorld),
  };
}

export function measureDistance(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) { data.start = value; return 'advance'; }
  if (active.stepIndex === 1) { data.end = value; return 'advance'; }
  if (active.stepIndex === 2) {
    data.offset = value;
    if (active.name === 'DIMALIGNED') {
      data.dimensionPlacement = alignedPlacement(
        ctx.doc.activeWorkPlane,
        data.start as Vec2 | Vec3,
        data.end as Vec2 | Vec3,
        value as Vec2 | Vec3,
      );
    }
    return 'advance';
  }

  // The last step, so the dimension is built once and lands in the history as a
  // single entry — placing the text is part of drawing it, not an edit of
  // something already drawn.
  const start = data.start as Vec2 | Vec3;
  const end = data.end as Vec2 | Vec3;
  const offset = data.offset as Vec2 | Vec3;
  const aligned = active.name === 'DIMALIGNED';
  const placement = aligned
    ? (data.dimensionPlacement as AlignedDimensionPlacement | null | undefined)
      ?? alignedPlacement(ctx.doc.activeWorkPlane, start, end, offset)
    : null;
  const dimension = ctx.doc.createDimension(
    placement?.start ?? flat(start),
    placement?.end ?? flat(end),
    placement?.offset ?? flat(offset),
    aligned ? 'aligned' : 'linear',
    aligned ? undefined : linearDimensionRotation(flat(start), flat(end), flat(offset)),
  );
  if (placement) {
    dimension.workPlane = cloneWorkPlane(placement.workPlane);
  } else if (!aligned) {
    // A horizontal edge on top of a solid carries the same local Z at both
    // endpoints. Keep the linear dimension parallel to the UCS, but lift its
    // plane to the edge instead of drawing its shadow on Z=0.
    const startZ = (start as SpatialLocalPoint).z ?? 0;
    const endZ = (end as SpatialLocalPoint).z ?? 0;
    if (Math.abs(startZ - endZ) < 1e-8 && Math.abs(startZ) > 1e-8) {
      const plane = cloneWorkPlane(ctx.doc.activeWorkPlane);
      plane.origin.x += plane.zAxis.x * startZ;
      plane.origin.y += plane.zAxis.y * startZ;
      plane.origin.z += plane.zAxis.z * startZ;
      dimension.workPlane = plane;
    }
  }
  // Enter arrives as null, which is the step declining to move the text.
  const textPosition = value as Vec2 | Vec3 | null;
  if (textPosition) {
    if (placement) {
      const local = worldToLocal(
        placement.workPlane,
        pointWorld(placement.sourceWorkPlane, textPosition),
      );
      dimension.textPosition = { x: local.x, y: local.y };
    } else {
      dimension.textPosition = flat(textPosition);
    }
  }
  ctx.history.execute(new AddEntityEdit('Dimension', dimension));
  const startWorld = pointWorld(ctx.doc.activeWorkPlane, start);
  const endWorld = pointWorld(ctx.doc.activeWorkPlane, end);
  // An aligned dimension reads the true world-space distance; a linear one
  // reads the UCS leg its geometry drew.
  const measured = aligned ? dist3(startWorld, endWorld) : Number(dimensionGeometry(dimension).text);
  ctx.log(`Dimension created: ${measured.toFixed(dimension.precision)} mm (${formatPoint(startWorld)} -> ${formatPoint(endWorld)})`);
  return 'advance';
}

export function measureAngle(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;

  if (active.stepIndex === 0) {
    if (!value) {
      data.angularPointMode = true;
      // Step 1 belongs to the two-edge mode. Jump over it so the shared fixed
      // step list remains intact for sticky command restarts.
      active.stepIndex = 1;
      ctx.log('Angular dimension: specify the vertex and a point on each ray.');
      return 'advance';
    }
    const source = value as Entity | SolidEdgeSelection;
    if (('type' in source && source.type !== 'line') || (!('type' in source) && source.circular)) {
      ctx.log('Angular dimension requires straight lines or straight solid edges.');
      return 'stay';
    }
    data.angularFirstSource = source;
    const pick = data.lastObjectPickPoint as Vec2 | Vec3 | undefined;
    if (pick) data.angularFirstPick = pointWorld(ctx.doc.activeWorkPlane, pick);
    return 'advance';
  }

  if (active.stepIndex === 1) {
    const source = value as Entity | SolidEdgeSelection;
    if (('type' in source && source.type !== 'line') || (!('type' in source) && source.circular)) {
      ctx.log('Angular dimension requires a second straight line or straight solid edge.');
      return 'stay';
    }
    const pick = data.lastObjectPickPoint as Vec2 | Vec3 | undefined;
    const placement = angularSourceFromLines(
      data.angularFirstSource as AngularLineSource,
      source as AngularLineSource,
      data.angularFirstPick as Vec3 | undefined,
      pick ? pointWorld(ctx.doc.activeWorkPlane, pick) : undefined,
      ctx.doc.activeWorkPlane,
      ctx.doc.viewMode === '2d',
    );
    if (!placement) {
      ctx.log('The selected lines must be non-parallel and lie in one plane.');
      return 'stay';
    }
    data.angularSource = placement;
    // Point steps 2–4 are the three-point alternative. The next ordinary
    // advance lands directly on step 5, where the arc is placed.
    active.stepIndex = 4;
    return 'advance';
  }

  if (!data.angularSource && data.angularPointMode) {
    if (active.stepIndex === 2) {
      data.angularVertex = value;
      return 'advance';
    }
    if (active.stepIndex === 3) {
      data.angularFirstPoint = value;
      return 'advance';
    }
    if (active.stepIndex === 4) {
      const placement = angularSourceFromPoints(
        ctx.doc.activeWorkPlane,
        data.angularVertex as Vec2 | Vec3,
        data.angularFirstPoint as Vec2 | Vec3,
        value as Vec2 | Vec3,
        ctx.doc.viewMode === '2d',
      );
      if (!placement) {
        ctx.log('The vertex and ray points must be distinct and non-collinear.');
        return 'stay';
      }
      data.angularSource = placement;
      return 'advance';
    }
  }

  const source = data.angularSource as AngularDimensionSource | undefined;
  if (!source) return 'stay';
  if (active.stepIndex === 5) {
    data.angularArcPoint = value;
    return 'advance';
  }

  const dimension = ctx.doc.createDimension(
    source.vertex,
    source.first,
    source.second,
    'angular',
  );
  dimension.workPlane = cloneWorkPlane(source.workPlane);
  dimension.arcPoint = flat(data.angularArcPoint as Vec2 | Vec3);
  if (value) dimension.textPosition = flat(value as Vec2 | Vec3);
  ctx.history.execute(new AddEntityEdit('Angular dimension', dimension));
  ctx.log(`Angular dimension created: ${dimensionGeometry(dimension).text}`);
  return 'advance';
}

export function measureRadius(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  const radial = active.name === 'DIMRADIUS';

  if (active.stepIndex === 0) {
    const picked = value as Entity | SolidEdgeSelection;
    if ('type' in picked) {
      if (picked.type !== 'circle' && picked.type !== 'arc') {
        ctx.log('Dimension requires a circle, arc, or circular solid edge.');
        return 'stay';
      }
      data.entity = picked;
      data.radialSource = {
        center: { ...picked.center },
        radius: picked.radius,
        workPlane: cloneWorkPlane(picked.workPlane ?? WORLD_WORK_PLANE),
      } satisfies RadialDimensionSource;
    } else if (picked.circular) {
      data.edge = picked;
      data.radialSource = {
        center: { x: 0, y: 0 },
        radius: picked.circular.radius,
        workPlane: workPlaneFromXAxis(
          picked.circular.center,
          picked.start,
          picked.circular.normal,
        ),
      } satisfies RadialDimensionSource;
    } else {
      ctx.log('The selected solid edge is not circular.');
      return 'stay';
    }
    return 'advance';
  }

  let source = data.radialSource as RadialDimensionSource | undefined;
  // A preselected 2D circle skips the picking step before execute() runs, so
  // initialise the same source description here as an ordinary click would.
  const preselected = data.entity as Entity | undefined;
  if (!source && (preselected?.type === 'circle' || preselected?.type === 'arc')) {
    source = {
      center: { ...preselected.center },
      radius: preselected.radius,
      workPlane: cloneWorkPlane(preselected.workPlane ?? WORLD_WORK_PLANE),
    };
    data.radialSource = source;
  }
  if (!source) return 'stay';
  const cursor = value as Vec2;
  // The arrow lands on the rim under the cursor. Dead centre there is no
  // direction to take, so it points along X rather than dividing by nothing.
  let dx = cursor.x - source.center.x, dy = cursor.y - source.center.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-9) { dx = 1; dy = 0; } else { dx /= distance; dy /= distance; }

  const rim = {
    x: source.center.x + dx * source.radius,
    y: source.center.y + dy * source.radius,
  };
  const dimension = ctx.doc.createDimension(source.center, rim, cursor, radial ? 'radius' : 'diameter');
  // The dimension lives on the selected circle or solid rim, not on whatever
  // UCS happened to be active when the command began.
  dimension.workPlane = cloneWorkPlane(source.workPlane);
  ctx.history.execute(new AddEntityEdit(radial ? 'Radius dimension' : 'Diameter dimension', dimension));
  ctx.log(`${radial ? 'Radius' : 'Diameter'} dimension created.`);
  return 'advance';
}

export function setWorkPlane({ active, data, value, ctx }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) { data.origin = value; return 'advance'; }
  if (active.stepIndex === 1) { data.xPoint = value; return 'advance'; }

  const origin = data.origin as Vec3;
  const xPoint = data.xPoint as Vec3;
  const yPoint = value as Vec3;
  const named = ctx.doc.addNamedWorkPlane(workPlaneFromXYAxes(origin, xPoint, yPoint));
  ctx.doc.viewMode = '3d';
  ctx.workPlaneChanged?.();
  ctx.log(`${named.name} saved: origin ${formatPoint(origin)}, X through ${formatPoint(xPoint)}, Y through ${formatPoint(yPoint)}`);
  return 'advance';
}
