import type { Document } from '../Document';
import {
  COMMAND_ALIASES,
  COMMAND_LIST,
  SUGGESTED_COMMANDS,
  commandDef,
  isStickyCommand,
  type CommandDef,
  type CommandName,
} from './registry';
import type { ActiveCommand, CommandContext, CommandStep, PickTarget } from './types';
import type { Vec2, Vec3 } from '../../math/geometry';
import { closePolyline, dist2, dist3, formatPoint, midpoint2, mirrorPoint2 } from '../../math/geometry';
import { cloneWorkPlane, localToWorld, workPlaneFromXYAxes, worldToLocal } from '../../math/workplane';
import { transformMeshByWorkPlane, transformMeshIndicesByWorkPlane, WORLD_WORK_PLANE } from '../../math/workplane';
import { cloneEntity, curvePoints, dimensionGeometry, ellipsePoints, entityBounds, genId, getEntityPoints, isLineLikeEntity, isOffsetEntity, isSweepProfileEntity, transformEntityPoints, type Entity, type ExtrusionFeature, type Solid, type SolidEdgeSelection, type SolidFaceSelection, type SolidFeature } from '../entities/types';
import type { CommandHistory } from '../history/CommandHistory';
import {
  AddEntitiesEdit,
  AddEntityEdit,
  RemoveEntityEdit,
  RemoveSolidEdit,
  ReplaceObjectsEdit,
  UpdateEntityEdit,
  UpdateSolidEdit,
  cloneSolid,
} from '../history/edits';
import {
  booleanSubtract,
  booleanUnion,
  extrudeProfile,
  sweepProfile,
  pressPullSolid,
  pressPullFace,
  modifySolidEdge,
  regenerateSolidFeature,
  createBoxMesh,
  createCylinderMesh,
  createConeMesh,
  createSphereMesh,
  createTorusMesh,
  createWedgeMesh,
  createPyramidMesh,
} from '../solids/ManifoldEngine';
import { rotatedFeature, scaledFeature } from '../solids/featureTransform';


// Commands are declared in ./registry; re-exported here so existing importers
// keep working while behaviour moves across.
export type { CommandName };
export type { ActiveCommand, CommandContext, CommandStep, PickTarget } from './types';

/** `NAME (ALIAS)  — description`, with the alias taken from the registry so it cannot go stale. */
function helpLine(command: CommandDef): string {
  const short = command.aliases[0];
  const label = !short || short === command.name ? command.name : `${command.name} (${short})`;
  return `${label.padEnd(14)} — ${command.help}`;
}





function lineIntersectionParameters(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { point: Vec2; t: number; u: number } | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-10) return null;
  const qx = c.x - a.x;
  const qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / denominator;
  const u = (qx * ry - qy * rx) / denominator;
  return { point: { x: a.x + t * rx, y: a.y + t * ry }, t, u };
}

type LineLikeSegment = { start: Vec2; end: Vec2; startIndex: number; endIndex: number };


function lineLikeSegments(entity: Extract<Entity, { type: 'line' | 'polyline' }>): LineLikeSegment[] {
  if (entity.type === 'line') return [{ start: entity.start, end: entity.end, startIndex: 0, endIndex: 1 }];
  const segments: LineLikeSegment[] = [];
  const count = entity.closed ? entity.vertices.length : entity.vertices.length - 1;
  for (let index = 0; index < count; index++) {
    const startIndex = index;
    const endIndex = entity.closed ? (index + 1) % entity.vertices.length : index + 1;
    const start = entity.vertices[startIndex];
    const end = entity.vertices[endIndex];
    if (start && end) segments.push({ start, end, startIndex, endIndex });
  }
  return segments;
}

function segmentDistance(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return dist2(point, start);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / len2));
  const projection = { x: start.x + t * dx, y: start.y + t * dy };
  return dist2(point, projection);
}

function nearestLineLikeSegment(entity: Extract<Entity, { type: 'line' | 'polyline' }>, point: Vec2): LineLikeSegment {
  const segments = lineLikeSegments(entity);
  if (segments.length === 0) {
    if (entity.type === 'line') return { start: entity.start, end: entity.end, startIndex: 0, endIndex: 1 };
    const fallback = entity.vertices[0] ?? { x: 0, y: 0 };
    return { start: fallback, end: fallback, startIndex: 0, endIndex: 0 };
  }
  let best = segments[0];
  let bestDistance = segmentDistance(point, best.start, best.end);
  for (const segment of segments.slice(1)) {
    const distance = segmentDistance(point, segment.start, segment.end);
    if (distance < bestDistance) { best = segment; bestDistance = distance; }
  }
  return best;
}

function collectLineLikeIntersections(target: LineLikeSegment, boundary: Extract<Entity, { type: 'line' | 'polyline' }>): Array<{ point: Vec2; t: number; u: number }> {
  const intersections: Array<{ point: Vec2; t: number; u: number }> = [];
  for (const segment of lineLikeSegments(boundary)) {
    const hit = lineIntersectionParameters(target.start, target.end, segment.start, segment.end);
    if (hit) intersections.push(hit);
  }
  return intersections;
}

function sameWorkPlane(a: Entity, b: Entity): boolean {
  return JSON.stringify(a.workPlane ?? WORLD_WORK_PLANE) === JSON.stringify(b.workPlane ?? WORLD_WORK_PLANE);
}



function isSweepPathEntity(entity: Entity): boolean {
  return entity.type === 'line' || entity.type === 'arc' || entity.type === 'bezier'
    || entity.type === 'circle' || entity.type === 'polyline';
}

function closedVertices(entity: Entity): Vec2[] | null {
  if (entity.type === 'rectangle') return [
    entity.first,
    { x: entity.opposite.x, y: entity.first.y },
    entity.opposite,
    { x: entity.first.x, y: entity.opposite.y },
  ];
  if (entity.type === 'octagon') return entity.vertices.map((point) => ({ ...point }));
  if (entity.type === 'polyline' && entity.closed) {
    const vertices = entity.vertices.map((point) => ({ ...point }));
    if (vertices.length > 1 && dist2(vertices[0], vertices.at(-1)!) < 1e-9) vertices.pop();
    return vertices;
  }
  return null;
}

function pointInClosedPolygon(point: Vec2, vertices: Vec2[]): boolean {
  let inside = false;
  for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index++) {
    const a = vertices[index], b = vertices[previous];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function offsetPolygon(vertices: Vec2[], distance: number): Vec2[] | null {
  if (vertices.length < 3) return null;
  let twiceArea = 0;
  for (let index = 0; index < vertices.length; index++) {
    const a = vertices[index], b = vertices[(index + 1) % vertices.length];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  if (Math.abs(twiceArea) < 1e-9) return null;
  const orientation = twiceArea > 0 ? 1 : -1;
  const shiftedEdges = vertices.map((start, index) => {
    const end = vertices[(index + 1) % vertices.length];
    const dx = end.x - start.x, dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return null;
    const normal = orientation > 0 ? { x: dy / length, y: -dx / length } : { x: -dy / length, y: dx / length };
    const offset = { x: normal.x * distance, y: normal.y * distance };
    return {
      start: { x: start.x + offset.x, y: start.y + offset.y },
      end: { x: end.x + offset.x, y: end.y + offset.y },
    };
  });
  if (shiftedEdges.some((edge) => !edge)) return null;
  const result: Vec2[] = [];
  for (let index = 0; index < vertices.length; index++) {
    const previous = shiftedEdges[(index - 1 + vertices.length) % vertices.length]!;
    const current = shiftedEdges[index]!;
    const intersection = lineIntersectionParameters(previous.start, previous.end, current.start, current.end);
    if (!intersection) return null;
    result.push(intersection.point);
  }
  return result;
}

function rotatePoint(point: Vec2, base: Vec2, angle: number): Vec2 {
  const dx = point.x - base.x, dy = point.y - base.y;
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  return { x: base.x + dx * cosine - dy * sine, y: base.y + dx * sine + dy * cosine };
}

function rotateEntity(entity: Entity, base: Vec2, angle: number, doc: Document): Entity {
  if (entity.type === 'rectangle') {
    const corners = closedVertices(entity)!;
    const polyline = doc.createPolyline(corners.map((point) => rotatePoint(point, base, angle)), true, entity.color);
    polyline.layer = entity.layer;
    polyline.workPlane = cloneEntity(entity).workPlane;
    return polyline;
  }
  const result = cloneEntity(entity);
  switch (result.type) {
    case 'line': result.start = rotatePoint(result.start, base, angle); result.end = rotatePoint(result.end, base, angle); break;
    case 'circle': result.center = rotatePoint(result.center, base, angle); break;
    case 'ellipse':
      result.center = rotatePoint(result.center, base, angle);
      result.rotation += angle;
      break;
    case 'octagon': result.center = rotatePoint(result.center, base, angle); result.vertices = result.vertices.map((point) => rotatePoint(point, base, angle)); break;
    case 'polyline': result.vertices = result.vertices.map((point) => rotatePoint(point, base, angle)); break;
    case 'arc': result.center = rotatePoint(result.center, base, angle); result.startAngle += angle; break;
    case 'bezier':
      result.start = rotatePoint(result.start, base, angle);
      result.control1 = rotatePoint(result.control1, base, angle);
      result.control2 = rotatePoint(result.control2, base, angle);
      result.end = rotatePoint(result.end, base, angle);
      break;
    case 'text': result.position = rotatePoint(result.position, base, angle); result.rotation = (result.rotation ?? 0) + angle; break;
    case 'dimension': result.start = rotatePoint(result.start, base, angle); result.end = rotatePoint(result.end, base, angle); result.offset = rotatePoint(result.offset, base, angle); break;
    case 'rectangle': break;
  }
  return result;
}

function copyEntity(entity: Entity, localDelta: Vec2, worldDelta?: Vec3): Entity {
  let copy: Entity;
  if (worldDelta) {
    copy = cloneEntity(entity);
    const plane = cloneWorkPlane(copy.workPlane ?? WORLD_WORK_PLANE);
    plane.origin.x += worldDelta.x;
    plane.origin.y += worldDelta.y;
    plane.origin.z += worldDelta.z;
    copy.workPlane = plane;
  } else {
    copy = transformEntityPoints(entity, (point) => ({ x: point.x + localDelta.x, y: point.y + localDelta.y }));
  }
  copy.id = genId(copy.type);
  copy.selected = false;
  return copy;
}

function copySolid(solid: Solid, delta: Vec3): Solid {
  const copy = cloneSolid(solid);
  copy.id = genId('solid');
  copy.name = `${solid.name}_copy`;
  copy.selected = false;
  for (let index = 0; index < copy.mesh.positions.length; index += 3) {
    copy.mesh.positions[index] += delta.x;
    copy.mesh.positions[index + 1] += delta.y;
    copy.mesh.positions[index + 2] += delta.z;
  }
  translateCopiedFeature(copy.feature, delta);
  copy.revision++;
  return copy;
}

function workPlaneDelta(plane: typeof WORLD_WORK_PLANE, localDelta: Vec2): Vec3 {
  return {
    x: plane.xAxis.x * localDelta.x + plane.yAxis.x * localDelta.y,
    y: plane.xAxis.y * localDelta.x + plane.yAxis.y * localDelta.y,
    z: plane.xAxis.z * localDelta.x + plane.yAxis.z * localDelta.y,
  };
}

function translateCopiedFeature(feature: SolidFeature, delta: Vec3): void {
  if (feature.kind === 'extrusion') {
    feature.transform.translateX += delta.x;
    feature.transform.translateY += delta.y;
    feature.transform.translateZ = (feature.transform.translateZ ?? 0) + delta.z;
  } else if (feature.kind === 'boolean') {
    feature.operands.forEach((operand) => translateCopiedFeature(operand, delta));
  } else if (feature.kind === 'primitive') {
    const plane = cloneWorkPlane(feature.workPlane ?? WORLD_WORK_PLANE);
    plane.origin.x += delta.x; plane.origin.y += delta.y; plane.origin.z += delta.z;
    feature.workPlane = plane;
  } else if (feature.kind === 'sweep') {
    const plane = cloneWorkPlane(feature.workPlane ?? WORLD_WORK_PLANE);
    plane.origin.x += delta.x; plane.origin.y += delta.y; plane.origin.z += delta.z;
    feature.workPlane = plane;
  }
}

function scaleEntity(entity: Entity, base: Vec2, factor: number): Entity {
  const scaled = transformEntityPoints(entity, (point) => ({
    x: base.x + (point.x - base.x) * factor,
    y: base.y + (point.y - base.y) * factor,
  }));
  if (scaled.type === 'circle' || scaled.type === 'arc' || scaled.type === 'octagon') scaled.radius *= factor;
  if (scaled.type === 'ellipse') { scaled.radiusX *= factor; scaled.radiusY *= factor; }
  if (scaled.type === 'text') scaled.height *= factor;
  scaled.selected = true;
  return scaled;
}

function scaleSolid(solid: Solid, base: Vec3, factor: number): Solid {
  const scaled = cloneSolid(solid);
  for (let index = 0; index < scaled.mesh.positions.length; index += 3) {
    scaled.mesh.positions[index] = base.x + (scaled.mesh.positions[index] - base.x) * factor;
    scaled.mesh.positions[index + 1] = base.y + (scaled.mesh.positions[index + 1] - base.y) * factor;
    scaled.mesh.positions[index + 2] = base.z + (scaled.mesh.positions[index + 2] - base.z) * factor;
  }
  scaled.height *= factor;
  // The mesh is transformed rather than regenerated, because a uniform scale of
  // every vertex is exactly what regenerating would produce and it needs no
  // WASM to do it. The feature is carried along so that the shape and the story
  // of it stay the same shape — this used to end at `{ kind: 'mesh' }`, so
  // resizing a sphere cost you the radius that made it.
  scaled.feature = scaledFeature(scaled.feature, base, factor) ?? { kind: 'mesh' };
  scaled.revision++;
  scaled.selected = true;
  return scaled;
}

function rotateSolidAroundPlane(solid: Solid, centerLocal: Vec3, angle: number, plane: typeof WORLD_WORK_PLANE): Solid {
  const rotated = cloneSolid(solid);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let index = 0; index < rotated.mesh.positions.length; index += 3) {
    const local = worldToLocal(plane, {
      x: rotated.mesh.positions[index],
      y: rotated.mesh.positions[index + 1],
      z: rotated.mesh.positions[index + 2],
    });
    const dx = local.x - centerLocal.x;
    const dy = local.y - centerLocal.y;
    const x = centerLocal.x + dx * cos - dy * sin;
    const y = centerLocal.y + dx * sin + dy * cos;
    const world = localToWorld(plane, { x, y }, local.z);
    rotated.mesh.positions[index] = world.x;
    rotated.mesh.positions[index + 1] = world.y;
    rotated.mesh.positions[index + 2] = world.z;
  }
  // A rotation is the work plane turned, which every feature already carries,
  // so this one never needed to bake at all.
  rotated.feature = rotatedFeature(rotated.feature, localToWorld(plane, centerLocal, centerLocal.z), plane.zAxis, angle)
    ?? { kind: 'mesh' };
  rotated.revision++;
  return rotated;
}

function explodeEntity(entity: Entity, doc: Document): Entity[] {
  let points: Vec2[] = [];
  let closed = false;
  if (entity.type === 'rectangle') { points = closedVertices(entity)!; closed = true; }
  else if (entity.type === 'polyline' || entity.type === 'octagon') { points = [...entity.vertices]; closed = entity.type === 'octagon' || entity.closed; }
  else if (entity.type === 'arc' || entity.type === 'bezier') points = curvePoints(entity, 48);
  else return [];
  if (closed && points.length > 1 && dist2(points[0], points.at(-1)!) < 1e-9) points.pop();
  const count = closed ? points.length : points.length - 1;
  const result: Entity[] = [];
  for (let index = 0; index < count; index++) {
    const line = doc.createLine(points[index], points[(index + 1) % points.length], entity.color);
    line.layer = entity.layer;
    line.workPlane = cloneWorkPlane(entity.workPlane ?? WORLD_WORK_PLANE);
    result.push(line);
  }
  return result;
}

export class CommandManager {
  active: ActiveCommand | null = null;
  history: string[] = [];
  historyIndex = -1;
  /** What Enter at an empty prompt repeats, however that command was started. */
  private lastCommand: CommandName | null = null;

  constructor(private ctx: CommandContext) {}

  updateContext(ctx: Partial<CommandContext>): void {
    Object.assign(this.ctx, ctx);
  }

  /** The step awaiting input, or null when no command is running. */
  get activeStep(): CommandStep | null {
    return this.active?.steps[this.active.stepIndex] ?? null;
  }

  /**
   * True while the active step collects a set of objects. Drawing a selection
   * window and consuming one are both gated on this, so they cannot disagree.
   */
  get isMultiObjectStep(): boolean {
    const step = this.activeStep;
    return (step?.kind === 'entity' || step?.kind === 'solid') && step.multi === true;
  }

  /** True when a pick should extend the selection rather than replace it. */
  get isAdditiveStep(): boolean {
    const step = this.activeStep;
    if (step?.kind !== 'entity' && step?.kind !== 'solid') return false;
    return step.multi === true || step.additive === true;
  }

  /** True when the active step can consume the given pick from the viewport. */
  stepAccepts(target: PickTarget): boolean {
    const step = this.activeStep;
    if (step?.kind === 'solid') return target === 'solid';
    if (step?.kind !== 'entity') return false;
    return (step.accepts ?? ['entity']).includes(target);
  }

  syncWindowSelection(): boolean {
    if (!this.active || !this.isMultiObjectStep) return false;
    this.active.data.entities = [...this.ctx.doc.getSelectedEntities()];
    this.active.data.solids = [...this.ctx.doc.getSelectedSolids()];
    const count = (this.active.data.entities as Entity[]).length + (this.active.data.solids as Solid[]).length;
    this.ctx.log(`${count} object(s) selected. Select more or press Enter.`);
    this.showCurrentPrompt();
    return true;
  }

  /**
   * Ends a POLYLINE. Fewer than two vertices means nothing was drawn, so the
   * command is dropped rather than leaving a degenerate entity behind.
   */
  private finishPolyline(closed: boolean): void {
    if (!this.active || this.active.name !== 'POLYLINE') return;
    const vertices = (this.active.data.vertices as Vec2[]) ?? [];
    if (vertices.length < 2) {
      this.cancelActive();
      this.ctx.log('A polyline needs at least two points.');
      this.ctx.prompt('Command:');
      this.ctx.redraw();
      return;
    }
    if (closed && vertices.length < 3) {
      this.ctx.log('A closed polyline needs at least three points.');
      this.showCurrentPrompt();
      return;
    }
    const polyline = this.ctx.doc.createPolyline(vertices.map((vertex) => ({ ...vertex })), closed);
    this.ctx.history.execute(new AddEntityEdit('Polyline', polyline));
    this.ctx.log(`Polyline created: ${vertices.length} vertices${closed ? ', closed' : ''}.`);
    this.active = null;
    this.startCommand('POLYLINE'); // sticky, like the other drawing tools
    this.ctx.redraw();
  }

  private finishJoin(): void {
    if (!this.active || this.active.name !== 'JOIN') return;
    const lines = (this.active.data.entities as Entity[]).filter((entity) => entity.type === 'line' || entity.type === 'arc' || entity.type === 'bezier' || entity.type === 'polyline');
    if (lines.length < 2) {
      this.ctx.log('JOIN requires at least two connected objects.');
      this.showCurrentPrompt();
      return;
    }
    const planeKey = (entity: Entity): string => JSON.stringify(entity.workPlane ?? WORLD_WORK_PLANE);
    if (lines.some((line) => planeKey(line) !== planeKey(lines[0]))) {
      this.ctx.log('JOIN requires all lines to be on the same work plane.');
      this.showCurrentPrompt();
      return;
    }
    const tolerance = 0.5;
    const near = (a: Vec2, b: Vec2): boolean => dist2(a, b) <= tolerance;
    const pointsFor = (entity: Entity): Vec2[] => entity.type === 'line'
      ? [{ ...entity.start }, { ...entity.end }]
      : entity.type === 'arc' || entity.type === 'bezier' ? curvePoints(entity, 48)
        : entity.type === 'polyline' ? (entity.closed ? closePolyline(entity.vertices).slice(0, -1) : [...entity.vertices]) : [];
    const vertices: Vec2[] = pointsFor(lines[0]);
    const remaining = lines.slice(1);
    while (remaining.length > 0) {
      const start = vertices[0];
      const end = vertices[vertices.length - 1];
      const index = remaining.findIndex((candidate) => {
        const points = pointsFor(candidate); const a = points[0], b = points.at(-1)!;
        return near(a, end) || near(b, end) || near(a, start) || near(b, start);
      });
      if (index < 0) {
        this.ctx.log('JOIN failed: the selected objects do not form one connected chain.');
        this.showCurrentPrompt();
        return;
      }
      const candidate = remaining.splice(index, 1)[0];
      const points = pointsFor(candidate); const a = points[0], b = points.at(-1)!;
      if (near(a, end)) vertices.push(...points.slice(1));
      else if (near(b, end)) vertices.push(...points.slice(0, -1).reverse());
      else if (near(b, start)) vertices.unshift(...points.slice(0, -1));
      else vertices.unshift(...points.slice(1).reverse());
    }
    const closed = vertices.length > 2 && near(vertices[0], vertices[vertices.length - 1]);
    if (closed) vertices.pop();
    const joined = this.ctx.doc.createPolyline(vertices, closed);
    joined.workPlane = cloneEntity(lines[0]).workPlane;
    this.ctx.history.execute(new ReplaceObjectsEdit('Join', lines, [], [joined], []));
    this.ctx.doc.selectEntity(joined.id);
    this.ctx.log(`Joined ${lines.length} objects into one ${closed ? 'closed ' : ''}polyline.`);
    this.active = null;
    this.ctx.prompt('Command:');
    this.ctx.redraw();
  }

  resolveAlias(input: string): CommandName | null {
    const key = input.trim().toUpperCase();
    return COMMAND_ALIASES[key] ?? null;
  }

  commandSuggestions(input: string): CommandName[] {
    const prefix = input.trim().toUpperCase();
    if (!prefix) return [];
    return SUGGESTED_COMMANDS.filter((command) => command.startsWith(prefix));
  }

  startCommand(name: CommandName): void {
    this.cancelActive();
    this.lastCommand = name;
    const def = commandDef(name);
    // A command with no wizard acts at once and leaves nothing active.
    if (def.run) {
      def.run(this.ctx);
      return;
    }
    if (!def.steps) {
      this.ctx.log(`Unknown command: ${name}`);
      return;
    }
    // Steps are data, so they are cloned per run — the wizard mutates them.
    this.active = {
      name,
      steps: def.steps.map((step) => ({ ...step })),
      stepIndex: 0,
      data: def.data?.(this.ctx) ?? {},
    };
    def.onStart?.(this.active, this.ctx);

    // When a preselection has already answered the last question a command had,
    // waiting for Enter would only ask the user to confirm what is on screen.
    // Press it for them: select objects, hit ERASE, they are gone — undo covers it.
    if (this.preselectionAnswersEverything()) {
      void this.advanceStep(null);
      return;
    }
    this.showCurrentPrompt();
  }

  /** True when the active step gathers objects, already has some, and nothing follows it. */
  private preselectionAnswersEverything(): boolean {
    if (!this.active || !this.isMultiObjectStep) return false;
    if (this.active.steps[this.active.stepIndex + 1]?.kind !== 'done') return false;
    const entities = (this.active.data.entities as Entity[] | undefined)?.length ?? 0;
    const solids = (this.active.data.solids as Solid[] | undefined)?.length ?? 0;
    return entities + solids > 0;
  }

  printHelp(): void {
    const lines = [
      '=== MyCAD — available commands ===',
      ...COMMAND_LIST.filter((command) => command.help).map(helpLine),
      'Command+drag = orbit 3D, wheel / trackpad = zoom',
    ];
    for (const l of lines) this.ctx.log(l);
  }

  cancelActive(): void {
    if (this.active?.cancel) this.active.cancel();
    this.active = null;
  }

  currentPrompt(): string {
    if (!this.active) return 'Command:';
    const step = this.active.steps[this.active.stepIndex];
    if (step.kind === 'done') return 'Command:';
    return step.label;
  }

  showCurrentPrompt(): void {
    this.ctx.prompt(this.currentPrompt());
  }

  /**
   * Every typed answer goes through here, so this is where a command that
   * throws is caught. It used to escape into an unhandled rejection: the height
   * for an EXTRUDE would be swallowed, the prompt would ask for it again, and
   * nothing anywhere said why. A command that fails has to say so.
   */
  async submitInput(input: string): Promise<void> {
    try {
      await this.readInput(input);
    } catch (error) {
      this.reportFailure(error);
    }
  }

  private reportFailure(error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.ctx.log(`${this.active?.name ?? 'Command'} failed: ${reason}`);
    // The command stays where it was, so the same answer can be tried again
    // once whatever went wrong is fixed.
    if (this.active) this.showCurrentPrompt();
    else this.ctx.prompt('Command:');
    this.ctx.redraw();
  }

  private async readInput(input: string): Promise<void> {
    const trimmed = input.trim();

    if (!this.active) {
      if (!trimmed) {
        // Enter at an empty prompt repeats the last command, as in AutoCAD.
        if (this.lastCommand) this.startCommand(this.lastCommand);
        return;
      }
      const cmd = this.resolveAlias(trimmed);
      if (cmd) {
        this.history.push(trimmed);
        this.historyIndex = this.history.length;
        this.startCommand(cmd);
      } else {
        this.ctx.log(`Unknown command: ${trimmed}. Enter HELP.`);
      }
      return;
    }

    const step = this.active.steps[this.active.stepIndex];
    if (step.kind === 'done') return;

    if (trimmed.toUpperCase() === 'CANCEL' || trimmed === '') {
      if (step.optional) {
        await this.advanceStep(null);
        return;
      }
      // Enter ends a multi-object step once anything has been gathered; the step
      // decides whether solids count, so this cannot drift from what it accepts.
      const gathered = (this.active.data.entities as Entity[] | undefined)?.length ?? 0;
      const gatheredSolids = this.stepAccepts('solid')
        ? (this.active.data.solids as Solid[] | undefined)?.length ?? 0
        : 0;
      if (this.isMultiObjectStep && (gathered > 0 || gatheredSolids > 0)) {
        await this.advanceStep(null);
        return;
      }
      this.cancelActive();
      this.ctx.log('Command canceled.');
      this.ctx.prompt('Command:');
      return;
    }

    await this.processStepInput(trimmed, step);
  }

  async handleClick(world: Vec2 | Vec3, pickEntity?: Entity, pickSolidId?: string, pickFace?: SolidFaceSelection, pickEdge?: SolidEdgeSelection): Promise<void> {
    try {
      await this.readClick(world, pickEntity, pickSolidId, pickFace, pickEdge);
    } catch (error) {
      this.reportFailure(error);
    }
  }

  private async readClick(world: Vec2 | Vec3, pickEntity?: Entity, pickSolidId?: string, pickFace?: SolidFaceSelection, pickEdge?: SolidEdgeSelection): Promise<void> {
    if (!this.active) return;
    const step = this.active.steps[this.active.stepIndex];

    if (step.kind === 'point') {
      await this.advanceStep(world);
    } else if (step.kind === 'entity' && pickEntity && this.stepAccepts('entity')) {
      this.ctx.doc.selectEntity(pickEntity.id, this.isAdditiveStep);
      if (this.active.name === 'TRIM' && this.active.stepIndex === 1) this.active.data.targetPickPoint = world;
      await this.advanceStep(pickEntity);
    } else if (step.kind === 'edge' && pickEdge) {
      this.ctx.doc.selectSolid(pickEdge.solidId);
      await this.advanceStep(pickEdge);
    } else if (step.kind === 'entity' && pickSolidId && this.stepAccepts('solid')) {
      this.ctx.doc.selectSolid(pickSolidId, this.isAdditiveStep);
      await this.advanceStep(pickSolidId);
    } else if (step.kind === 'solid' && (pickSolidId || pickFace)) {
      const solidId = pickFace?.solidId ?? pickSolidId!;
      this.ctx.doc.selectSolid(solidId, this.isAdditiveStep);
      await this.advanceStep(this.active.name === 'PRESSPULL' && pickFace ? pickFace : pickSolidId);
    }
  }

  async handlePreview(cursor: Vec2): Promise<void> {
    if (this.active?.preview) this.active.preview(cursor);
  }

  private async processStepInput(input: string, step: CommandStep): Promise<void> {
    switch (step.kind) {
      case 'point': {
        if (this.active?.name === 'POLYLINE' && this.active.stepIndex > 0 && input.trim().toUpperCase() === 'C') {
          this.finishPolyline(true);
          return;
        }
        if (this.active?.name === 'SCALE' && this.active.stepIndex === 2) {
          const factor = Number(input);
          const base = this.active.data.basePoint as Vec2 | undefined;
          if (base && Number.isFinite(factor) && factor > 0) {
            this.active.data.enteredScaleFactor = factor;
            await this.advanceStep({ x: base.x + factor, y: base.y });
            return;
          }
          if (Number.isFinite(factor)) { this.ctx.log('Scale factor must be greater than zero.'); return; }
        }
        if (this.active?.name === 'ROTATE' && this.active.stepIndex === 2) {
          const degrees = Number(input);
          const base = this.active.data.basePoint as Vec2 | undefined;
          if (base && Number.isFinite(degrees)) {
            const angle = degrees * Math.PI / 180;
            await this.advanceStep({ x: base.x + Math.cos(angle), y: base.y + Math.sin(angle) });
            return;
          }
        }
        if (this.active?.name === 'ARC' && this.active.stepIndex === 2) {
          const angle = Number(input); const center = this.active.data.center as Vec2; const start = this.active.data.start as Vec2;
          if (Number.isFinite(angle) && center && start) { const a = Math.atan2(start.y-center.y,start.x-center.x) + angle*Math.PI/180; const r=dist2(center,start); await this.advanceStep({x:center.x+Math.cos(a)*r,y:center.y+Math.sin(a)*r}); return; }
        }
        if ((this.active?.name === 'CIRCLE' || this.active?.name === 'CIRCLE_DIAMETER') && this.active.stepIndex === 1) {
          const entered = Number(input);
          const center = this.active.data.center as Vec2 | undefined;
          if (center && Number.isFinite(entered) && entered > 0) {
            // The step reads a point, so hand it one the entered distance away.
            // What that distance means is the command's business: a radius for
            // CIRCLE, a diameter for CIRCLE_DIAMETER.
            await this.advanceStep({ x: center.x + entered, y: center.y });
            return;
          }
        }
        if (this.active && ['CYLINDER', 'SPHERE', 'CONE', 'PYRAMID', 'TORUS'].includes(this.active.name) && this.active.stepIndex === 1) {
          const radius = Number(input);
          const center = this.active.data.center as Vec2 | undefined;
          if (center && Number.isFinite(radius) && radius > 0) {
            await this.advanceStep({ x: center.x + radius, y: center.y });
            return;
          }
        }
        if (this.active?.name === 'POLYGON' && this.active.stepIndex === 2) {
          const apothem = Number(input);
          const center = this.active.data.center as Vec2 | undefined;
          if (center && Number.isFinite(apothem) && apothem > 0) {
            await this.advanceStep({ x: center.x + apothem, y: center.y });
            return;
          }
        }
        if (input.startsWith('@')) {
          const base = this.active?.data.lastPoint as Vec2 | undefined;
          if (!base) {
            this.ctx.log('Relative coordinates require a previous point.');
            break;
          }
          const relative = input.slice(1).trim();
          const polar = relative.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*<\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
          if (polar) {
            const distance = Number(polar[1]);
            const angle = Number(polar[2]) * Math.PI / 180;
            await this.advanceStep({ x: base.x + Math.cos(angle) * distance, y: base.y + Math.sin(angle) * distance });
            return;
          }
          const cartesian = relative.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*[,;]\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
          if (cartesian) {
            await this.advanceStep({ x: base.x + Number(cartesian[1]), y: base.y + Number(cartesian[2]) });
            return;
          }
          this.ctx.log('Invalid relative point. Use @x,y or @distance<angle.');
          break;
        }
        const parts = input.split(/[,;\s]+/).filter(Boolean);
        if (parts.length >= 2) {
          const p = { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
          if (!isNaN(p.x) && !isNaN(p.y)) {
            await this.advanceStep(p);
            return;
          }
        }
        this.ctx.log(this.active?.name === 'CIRCLE' && this.active.stepIndex === 1
          ? 'Invalid radius or point. Enter a positive number or point x,y.'
          : 'Invalid point. Use x,y, @x,y, or @distance<angle.');
        break;
      }
      case 'number': {
        const n = parseFloat(input);
        if (!isNaN(n)) {
          await this.advanceStep(n);
          return;
        }
        this.ctx.log('Invalid number.');
        break;
      }
      case 'text': await this.advanceStep(input); return;
      case 'entity':
      case 'solid':
      case 'edge':
        this.ctx.log('Click an object or enter coordinates.');
        break;
    }
  }

  private async advanceStep(value: unknown): Promise<void> {
    if (!this.active) return;
    const step = this.active.steps[this.active.stepIndex];
    const data = this.active.data;
    if (step.kind === 'point' && value && typeof value === 'object' && 'x' in value && 'y' in value) {
      const point = value as Vec2;
      data.lastPoint = { x: point.x, y: point.y };
    }

    switch (this.active.name) {
      case 'POLYLINE': {
        const vertices = data.vertices as Vec2[];
        const point = value as Vec2 | null;
        if (point) {
          // `start` is what ortho, polar and the preview track from, so keeping
          // it on the last vertex makes the rubber band follow each segment.
          vertices.push({ x: point.x, y: point.y });
          data.start = { x: point.x, y: point.y };
          if (this.active.stepIndex > 0) {
            this.ctx.log(`Vertex ${vertices.length} added. Enter to finish, C to close.`);
            this.showCurrentPrompt();
            this.ctx.redraw();
            return; // stay on the repeating step
          }
          break; // first point: move on to the repeating step
        }
        this.finishPolyline(false);
        return;
      }

      case 'LINE':
        if (this.active.stepIndex === 0) data.start = value;
        else if (this.active.stepIndex === 1) {
          const line = this.ctx.doc.createLine(data.start as Vec2, value as Vec2);
          this.ctx.history.execute(new AddEntityEdit('Line', line));
          this.ctx.log(`Line created: ${formatPoint(data.start as Vec2)} -> ${formatPoint(value as Vec2)}`);
        }
        break;

      case 'CIRCLE_DIAMETER':
        if (this.active.stepIndex === 0) data.center = value;
        else if (this.active.stepIndex === 1) {
          const center = data.center as Vec2;
          const diameter = dist2(center, value as Vec2);
          if (diameter < 1e-9) { this.ctx.log('Diameter must be greater than zero.'); this.showCurrentPrompt(); return; }
          const circle = this.ctx.doc.createCircle(center, diameter / 2);
          this.ctx.history.execute(new AddEntityEdit('Circle', circle));
          this.ctx.log(`Circle created: center ${formatPoint(center)}, \u00d8${diameter.toFixed(4)}`);
        }
        break;

      case 'ELLIPSE':
        if (this.active.stepIndex === 0) data.center = value;
        else if (this.active.stepIndex === 1) data.axisPoint = value;
        else if (this.active.stepIndex === 2) {
          const center = data.center as Vec2;
          const axis = data.axisPoint as Vec2;
          const radiusX = dist2(center, axis);
          const rotation = Math.atan2(axis.y - center.y, axis.x - center.x);
          // The second axis is measured perpendicular to the first, so take the
          // cursor's distance in the ellipse's own frame.
          const cursor = value as Vec2;
          const radiusY = Math.abs(-(cursor.x - center.x) * Math.sin(rotation) + (cursor.y - center.y) * Math.cos(rotation));
          if (radiusX < 1e-9 || radiusY < 1e-9) {
            this.ctx.log('Ellipse radii must be greater than zero.');
            this.showCurrentPrompt();
            return;
          }
          const ellipse = this.ctx.doc.createEllipse(center, radiusX, radiusY, rotation);
          this.ctx.history.execute(new AddEntityEdit('Ellipse', ellipse));
          this.ctx.log(`Ellipse created: RX ${radiusX.toFixed(3)}, RY ${radiusY.toFixed(3)}`);
        }
        break;

      case 'CIRCLE':
        if (this.active.stepIndex === 0) data.center = value;
        else if (this.active.stepIndex === 1) {
          const r = dist2(data.center as Vec2, value as Vec2);
          const circle = this.ctx.doc.createCircle(data.center as Vec2, r);
          this.ctx.history.execute(new AddEntityEdit('Circle', circle));
          this.ctx.log(`Circle created: center ${formatPoint(data.center as Vec2)}, r=${r.toFixed(4)}`);
        }
        break;

      case 'RECTANGLE':
        if (this.active.stepIndex === 0) data.start = value;
        else if (this.active.stepIndex === 1) {
          const rectangle = this.ctx.doc.createRectangle(data.start as Vec2, value as Vec2);
          this.ctx.history.execute(new AddEntityEdit('Rectangle', rectangle));
          this.ctx.log(`Rectangle created: ${formatPoint(data.start as Vec2)} -> ${formatPoint(value as Vec2)}`);
        }
        break;

      case 'OCTAGON':
        if (this.active.stepIndex === 0) data.center = value;
        else if (this.active.stepIndex === 1) {
          const r = dist2(data.center as Vec2, value as Vec2);
          const oct = this.ctx.doc.createOctagon(data.center as Vec2, r);
          this.ctx.history.execute(new AddEntityEdit('Osmiuhelnik', oct));
          this.ctx.log(`Octagon created: center ${formatPoint(data.center as Vec2)}, r=${r.toFixed(4)}`);
        }
        break;

      case 'POLYGON':
        if (this.active.stepIndex === 0) data.center = value;
        else if (this.active.stepIndex === 1) {
          const sides = Math.round(value as number);
          if (sides < 3 || sides > 128) {
            this.ctx.log('The number of sides must be an integer from 3 to 128.');
            this.showCurrentPrompt();
            return;
          }
          data.sides = sides;
        } else {
          const center = data.center as Vec2;
          const cursor = value as Vec2;
          const sides = data.sides as number;
          const apothem = dist2(center, cursor);
          if (apothem <= 0) return;
          const radius = apothem / Math.cos(Math.PI / sides);
          const normalAngle = Math.atan2(cursor.y - center.y, cursor.x - center.x);
          const vertices: Vec2[] = [];
          for (let i = 0; i < sides; i++) {
            const angle = normalAngle + Math.PI / sides + i * Math.PI * 2 / sides;
            vertices.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
          }
          const polygon = this.ctx.doc.createPolyline(vertices, true);
          this.ctx.history.execute(new AddEntityEdit('Polygon', polygon));
          this.ctx.log(`Polygon created: ${sides} sides, apothem=${apothem.toFixed(3)} mm`);
        }
        break;
      case 'ARC':
        if (this.active.stepIndex === 0) data.center = value;
        else if (this.active.stepIndex === 1) data.start = value;
        else { const c=data.center as Vec2,s=data.start as Vec2,e=value as Vec2; const r=dist2(c,s); let sweep=Math.atan2(e.y-c.y,e.x-c.x)-Math.atan2(s.y-c.y,s.x-c.x); if(sweep<=0)sweep+=Math.PI*2; const arc=this.ctx.doc.createArc(c,r,Math.atan2(s.y-c.y,s.x-c.x),sweep); this.ctx.history.execute(new AddEntityEdit('Arc',arc)); }
        break;
      case 'BEZIER':
        if(this.active.stepIndex===0)data.start=value; else if(this.active.stepIndex===1)data.control1=value; else if(this.active.stepIndex===2)data.control2=value; else { const bez=this.ctx.doc.createBezier(data.start as Vec2,data.control1 as Vec2,data.control2 as Vec2,value as Vec2); this.ctx.history.execute(new AddEntityEdit('Bezier',bez)); } break;
      case 'TEXT':
        if (this.active.stepIndex === 0) data.font = String(value);
        else if (this.active.stepIndex === 1) {
          const height = value as number;
          if (height <= 0) {
            this.ctx.log('Text height must be greater than zero.');
            this.showCurrentPrompt();
            return;
          }
          data.height = height;
        } else if (this.active.stepIndex === 2) data.position = value;
        else {
          const text = this.ctx.doc.createText(data.position as Vec2, String(value), data.height as number, data.font as string);
          this.ctx.history.execute(new AddEntityEdit('Text', text));
        }
        break;

      case 'BOX':
        if (this.active.stepIndex === 0) data.start = value;
        else if (this.active.stepIndex === 1) data.end = value;
        else {
          const start = data.start as Vec2, end = data.end as Vec2;
          const width = Math.abs(end.x - start.x), depth = Math.abs(end.y - start.y), height = Math.abs(value as number);
          if (width < 1e-9 || depth < 1e-9 || height < 1e-9) { this.ctx.log('Box dimensions must be greater than zero.'); this.showCurrentPrompt(); return; }
          const center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
          const plane = cloneWorkPlane(this.ctx.doc.activeWorkPlane);
          const local = createBoxMesh(width, depth, height, center.x, center.y);
          const mesh = { positions: transformMeshByWorkPlane(local.positions, plane), indices: transformMeshIndicesByWorkPlane(local.indices, plane) };
          const solid = this.ctx.doc.createSolid(mesh, 'Box', height, [], undefined, { kind: 'primitive', primitive: 'box', center, width, depth, height, workPlane: plane });
          this.ctx.history.execute(new ReplaceObjectsEdit('Box', [], [], [], [solid]));
          this.ctx.doc.viewMode = '3d'; this.ctx.log(`Box created: ${width.toFixed(3)} × ${depth.toFixed(3)} × ${height.toFixed(3)}`);
        }
        break;

      case 'CYLINDER':
        if (this.active.stepIndex === 0) data.center = value;
        else if (this.active.stepIndex === 1) data.radiusPoint = value;
        else {
          const center = data.center as Vec2, radius = dist2(center, data.radiusPoint as Vec2), height = Math.abs(value as number);
          if (radius < 1e-9 || height < 1e-9) { this.ctx.log('Cylinder radius and height must be greater than zero.'); this.showCurrentPrompt(); return; }
          const plane = cloneWorkPlane(this.ctx.doc.activeWorkPlane);
          const local = createCylinderMesh(radius, height, center.x, center.y, 64);
          const mesh = { positions: transformMeshByWorkPlane(local.positions, plane), indices: transformMeshIndicesByWorkPlane(local.indices, plane) };
          const solid = this.ctx.doc.createSolid(mesh, 'Cylinder', height, [], undefined, { kind: 'primitive', primitive: 'cylinder', center, radius, height, workPlane: plane });
          this.ctx.history.execute(new ReplaceObjectsEdit('Cylinder', [], [], [], [solid]));
          this.ctx.doc.viewMode = '3d'; this.ctx.log(`Cylinder created: R${radius.toFixed(3)}, H${height.toFixed(3)}`);
        }
        break;

      case 'TORUS':
        if (this.active.stepIndex === 0) data.center = value;
        else if (this.active.stepIndex === 1) data.radiusPoint = value;
        else {
          const center = data.center as Vec2;
          const radius = dist2(center, data.radiusPoint as Vec2);
          const tubeRadius = Math.abs(value as number);
          if (radius < 1e-9 || tubeRadius < 1e-9) { this.ctx.log('Torus radius and tube radius must be greater than zero.'); this.showCurrentPrompt(); return; }
          if (tubeRadius >= radius) { this.ctx.log('Tube radius must be smaller than the torus radius.'); this.showCurrentPrompt(); return; }
          const plane = cloneWorkPlane(this.ctx.doc.activeWorkPlane);
          const local = createTorusMesh(radius, tubeRadius, center.x, center.y);
          const mesh = { positions: transformMeshByWorkPlane(local.positions, plane), indices: transformMeshIndicesByWorkPlane(local.indices, plane) };
          const solid = this.ctx.doc.createSolid(mesh, 'Torus', tubeRadius * 2, [], undefined, { kind: 'primitive', primitive: 'torus', center, radius, tubeRadius, height: tubeRadius * 2, workPlane: plane });
          this.ctx.history.execute(new ReplaceObjectsEdit('Torus', [], [], [], [solid]));
          this.ctx.doc.viewMode = '3d';
          this.ctx.log(`Torus created: R${radius.toFixed(3)}, tube R${tubeRadius.toFixed(3)}`);
        }
        break;

      case 'WEDGE':
        if (this.active.stepIndex === 0) data.start = value;
        else if (this.active.stepIndex === 1) data.end = value;
        else {
          const start = data.start as Vec2, end = data.end as Vec2;
          const width = Math.abs(end.x - start.x), depth = Math.abs(end.y - start.y), height = Math.abs(value as number);
          if (width < 1e-9 || depth < 1e-9 || height < 1e-9) { this.ctx.log('Wedge dimensions must be greater than zero.'); this.showCurrentPrompt(); return; }
          const center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, plane = cloneWorkPlane(this.ctx.doc.activeWorkPlane);
          const local = createWedgeMesh(width, depth, height, center.x, center.y);
          const mesh = { positions: transformMeshByWorkPlane(local.positions, plane), indices: transformMeshIndicesByWorkPlane(local.indices, plane) };
          const solid = this.ctx.doc.createSolid(mesh, 'Wedge', height, [], undefined, { kind: 'primitive', primitive: 'wedge', center, width, depth, height, workPlane: plane });
          this.ctx.history.execute(new ReplaceObjectsEdit('Wedge', [], [], [], [solid])); this.ctx.doc.viewMode = '3d';
        }
        break;

      case 'SPHERE':
        if (this.active.stepIndex === 0) data.center = value;
        else {
          const center = data.center as Vec2, radius = dist2(center, value as Vec2);
          if (radius < 1e-9) { this.ctx.log('Sphere radius must be greater than zero.'); this.showCurrentPrompt(); return; }
          const plane = cloneWorkPlane(this.ctx.doc.activeWorkPlane), local = createSphereMesh(radius, center.x, center.y);
          const mesh = { positions: transformMeshByWorkPlane(local.positions, plane), indices: transformMeshIndicesByWorkPlane(local.indices, plane) };
          const solid = this.ctx.doc.createSolid(mesh, 'Sphere', radius * 2, [], undefined, { kind: 'primitive', primitive: 'sphere', center, radius, height: radius * 2, workPlane: plane });
          this.ctx.history.execute(new ReplaceObjectsEdit('Sphere', [], [], [], [solid])); this.ctx.doc.viewMode = '3d';
        }
        break;

      case 'CONE':
      case 'PYRAMID':
        if (this.active.stepIndex === 0) data.center = value;
        else if (this.active.stepIndex === 1) data.radiusPoint = value;
        else {
          const center = data.center as Vec2, radius = dist2(center, data.radiusPoint as Vec2), height = Math.abs(value as number);
          if (radius < 1e-9 || height < 1e-9) { this.ctx.log('Radius and height must be greater than zero.'); this.showCurrentPrompt(); return; }
          const plane = cloneWorkPlane(this.ctx.doc.activeWorkPlane);
          const local = this.active.name === 'CONE' ? createConeMesh(radius, height, center.x, center.y) : createPyramidMesh(radius, height, center.x, center.y);
          const mesh = { positions: transformMeshByWorkPlane(local.positions, plane), indices: transformMeshIndicesByWorkPlane(local.indices, plane) };
          const primitive = this.active.name === 'CONE' ? 'cone' : 'pyramid';
          const solid = this.ctx.doc.createSolid(mesh, this.active.name === 'CONE' ? 'Cone' : 'Pyramid', height, [], undefined, { kind: 'primitive', primitive, center, radius, height, workPlane: plane });
          this.ctx.history.execute(new ReplaceObjectsEdit(this.active.name === 'CONE' ? 'Cone' : 'Pyramid', [], [], [], [solid])); this.ctx.doc.viewMode = '3d';
        }
        break;

      case 'EXTRUDE':
        if (step.kind === 'entity' && value) {
          (data.entities as Entity[]).push(value as Entity);
          this.ctx.log(`Profile added: ${(value as Entity).type} (${(value as Entity).id})`);
          // Allow selecting one profile then height
          this.active.stepIndex = 1;
          this.showCurrentPrompt();
          return;
        } else if (step.kind === 'number') {
          const entered = value as number;
          const entities = data.entities as Entity[];
          if (entities.length === 0) {
            this.ctx.log('No profile selected.');
            break;
          }
          if (Math.abs(entered) < 1e-9) {
            this.ctx.log('Extrusion height cannot be zero.');
            this.showCurrentPrompt();
            return;
          }
          this.ctx.log('Extruding…');
          const feature = extrusionFeature(entities[0], entered);
          // Built from the feature, not beside it. The mesh used to come from
          // extrudeProfile while the feature described the same solid a second
          // time, so the shape you got and the shape it regenerated into were
          // two answers that only happened to agree.
          const mesh = await regenerateSolidFeature(feature);
          if (mesh) {
            const solid = this.ctx.doc.createSolid(
              mesh,
              `Extrusion_${entities.map((e) => e.id).join('_')}`,
              feature.height,
              entities.map((e) => e.id),
              undefined,
              feature,
            );
            this.ctx.history.execute(new ReplaceObjectsEdit('Extrude', entities, [], [], [solid]));
            this.ctx.doc.viewMode = '3d';
            this.ctx.log(`Extrusion complete, height=${entered}`);
          } else {
            this.ctx.log('Extrusion failed — select a closed profile.');
          }
        }
        break;

      case 'SWEEP':
        if (this.active.stepIndex === 0 && step.kind === 'entity' && value) {
          const entity = value as Entity;
          if (!isSweepProfileEntity(entity)) {
            this.ctx.log('Sweep profile must be a closed 2D object.');
            this.showCurrentPrompt();
            return;
          }
          data.profile = entity;
          this.ctx.log(`Profile selected: ${entity.type} (${entity.id})`);
          this.active.stepIndex = 1;
          this.showCurrentPrompt();
          return;
        } else if (this.active.stepIndex === 1 && step.kind === 'entity' && value) {
          const profile = data.profile as Entity | undefined;
          const path = value as Entity;
          if (!profile) {
            this.ctx.log('No profile selected.');
            break;
          }
          if (!isSweepPathEntity(path)) {
            this.ctx.log('Sweep path must be a line, arc, bezier, polyline or circle.');
            this.showCurrentPrompt();
            return;
          }
          this.ctx.log('Sweeping…');
          const plane = profile.workPlane ?? path.workPlane ?? WORLD_WORK_PLANE;
          const mesh = await sweepProfile(profile, path, plane);
          if (mesh) {
            const solid = this.ctx.doc.createSolid(
              mesh,
              `Sweep_${profile.id}_${path.id}`,
              0,
              [profile.id, path.id],
              undefined,
              {
                kind: 'sweep',
                profile: cloneEntity(profile),
                path: cloneEntity(path),
                workPlane: cloneWorkPlane(plane),
              },
            );
            this.ctx.history.execute(new ReplaceObjectsEdit('Sweep', [profile], [], [], [solid]));
            this.ctx.doc.clearSelection();
            this.ctx.doc.selectSolid(solid.id);
            this.ctx.doc.viewMode = '3d';
            this.ctx.log(`Sweep complete (${profile.id} along ${path.id}).`);
          } else {
            this.ctx.log('Sweep failed — select a valid path and closed profile.');
          }
        }
        break;

      case 'SUBTRACT':
        if (this.active.stepIndex === 0) {
          data.baseId = value;
          this.ctx.doc.selectSolid(value as string);
          this.ctx.log(`Base solid selected: ${value as string}`);
        }
        else if (this.active.stepIndex === 1) {
          const base = this.ctx.doc.getSolid(value as string)?.mesh;
          const baseSolid = this.ctx.doc.getSolid(data.baseId as string);
          const toolSolid = this.ctx.doc.getSolid(value as string);
          if (!baseSolid || !toolSolid) {
            this.ctx.log('Solid not found.');
            break;
          }
          this.ctx.log('Subtracting…');
          const mesh = await booleanSubtract(baseSolid.mesh, toolSolid.mesh);
          if (mesh) {
            const solid = this.ctx.doc.createSolid(mesh, 'Subtract', baseSolid.height, [], undefined, {
              kind: 'boolean',
              operation: 'subtract',
              operands: [JSON.parse(JSON.stringify(baseSolid.feature)), JSON.parse(JSON.stringify(toolSolid.feature))],
            });
            this.ctx.history.execute(new ReplaceObjectsEdit('Subtract', [], [baseSolid, toolSolid], [], [solid]));
            this.ctx.log('Subtract complete.');
          } else {
            this.ctx.log('Subtract failed.');
          }
        }
        break;

      case 'UNION':
        if (this.active.stepIndex === 0) (data.solids as string[]).push(value as string);
        else if (this.active.stepIndex === 1) {
          (data.solids as string[]).push(value as string);
          const ids = data.solids as string[];
          const meshes = ids.map((id) => this.ctx.doc.getSolid(id)?.mesh).filter(Boolean);
          if (meshes.length < 2) {
            this.ctx.log('Two solids are required.');
            break;
          }
          this.ctx.log('Joining solids…');
          const mesh = await booleanUnion(meshes as import('../entities/types').SolidMesh[]);
          if (mesh) {
            const sourceSolids = ids.map((id) => this.ctx.doc.getSolid(id)).filter((value): value is NonNullable<typeof value> => Boolean(value));
            const solid = this.ctx.doc.createSolid(mesh, 'Union', 0, [], undefined, {
              kind: 'boolean',
              operation: 'union',
              operands: sourceSolids.map((source) => JSON.parse(JSON.stringify(source.feature))),
            });
            const oldSolids = sourceSolids;
            this.ctx.history.execute(new ReplaceObjectsEdit('Union', [], oldSolids, [], [solid]));
            this.ctx.log('Union complete.');
          } else {
            this.ctx.log('Union failed.');
          }
        }
        break;

      case 'MIRROR':
        if (step.kind === 'entity' && value) {
          (data.entities as Entity[]).push(value as Entity);
          this.ctx.log('Object added. Click another or press Enter.');
          return;
        } else if (this.active.stepIndex === 1) {
          data.axisStart = value;
        } else if (this.active.stepIndex === 2) {
          const axisStart = data.axisStart as Vec2;
          const axisEnd = value as Vec2;
          const entities = data.entities as Entity[];
          const mirroredEntities: Entity[] = [];
          for (const e of entities) {
            const mirrored = transformEntityPoints(e, (p) => mirrorPoint2(p, axisStart, axisEnd));
            mirrored.id = genId(e.type);
            mirroredEntities.push(mirrored);
          }
          this.ctx.history.execute(new AddEntitiesEdit('Mirror', mirroredEntities));
          this.ctx.log(`Mirrored ${entities.length} object(s).`);
        }
        break;

      case 'JOIN':
        if (step.kind === 'entity' && value) {
          const entity = value as Entity;
          if (entity.type !== 'line' && entity.type !== 'arc' && entity.type !== 'bezier' && entity.type !== 'polyline') {
            this.ctx.log('JOIN accepts line, polyline, arc, and Bezier objects.');
            return;
          }
          const entities = data.entities as Entity[];
          if (!entities.some((item) => item.id === entity.id)) {
            entities.push(entity);
            this.ctx.doc.selectEntity(entity.id, true);
          }
          this.ctx.log('Object added. Select another or press Enter.');
          return;
        } else {
          this.finishJoin();
          return;
        }
        break;

      case 'EXTEND':
        if (this.active.stepIndex === 0) {
          const boundary = value as Entity;
          if (!isLineLikeEntity(boundary)) { this.ctx.log('EXTEND boundary must be a line or polyline.'); return; }
          data.boundary = boundary;
          this.ctx.doc.selectEntity(boundary.id);
        } else {
          const boundary = data.boundary as Entity;
          const target = value as Entity;
          if (!isLineLikeEntity(boundary) || !isLineLikeEntity(target) || boundary.id === target.id) {
            this.ctx.log('Select a different line or polyline to extend.'); return;
          }
          if (!sameWorkPlane(boundary, target)) { this.ctx.log('Both lines must be on the same work plane.'); return; }
          const click = data.targetPickPoint as Vec2 | undefined;
          const targetSegment = click ? nearestLineLikeSegment(target, click) : nearestLineLikeSegment(target, target.type === 'line' ? target.start : target.vertices[0] ?? { x: 0, y: 0 });
          const hits = collectLineLikeIntersections(targetSegment, boundary)
            .filter((hit) => (hit.t < -1e-8 || hit.t > 1 + 1e-8) && hit.u >= -1e-8 && hit.u <= 1 + 1e-8);
          if (hits.length === 0) {
            this.ctx.log('EXTEND failed: the boundary does not intersect an extension of this line or polyline.'); return;
          }
          const hit = click ? hits.reduce((best, candidate) => dist2(candidate.point, click) < dist2(best.point, click) ? candidate : best) : hits[0];
          const updated = cloneEntity(target);
          const clickT = click
            ? ((click.x - targetSegment.start.x) * (targetSegment.end.x - targetSegment.start.x) + (click.y - targetSegment.start.y) * (targetSegment.end.y - targetSegment.start.y))
              / (((targetSegment.end.x - targetSegment.start.x) ** 2 + (targetSegment.end.y - targetSegment.start.y) ** 2) || 1)
            : 1;
          const useStart = clickT < 0.5;
          if (updated.type === 'line') {
            if (useStart) updated.start = hit.point;
            else updated.end = hit.point;
          } else if (updated.type === 'polyline') {
            updated.vertices[useStart ? targetSegment.startIndex : targetSegment.endIndex] = hit.point;
          }
          this.ctx.history.execute(new UpdateEntityEdit('Extend', target, updated));
          this.ctx.doc.selectEntity(updated.id);
          this.ctx.log(`${target.type === 'line' ? 'Line' : 'Polyline'} extended by ${Math.min(dist2(hit.point, targetSegment.start), dist2(hit.point, targetSegment.end)).toFixed(3)} mm.`);
        }
        break;

      case 'TRIM':
        if (this.active.stepIndex === 0) {
          const boundary = value as Entity;
          if (!isLineLikeEntity(boundary)) { this.ctx.log('TRIM cutting edge must be a line or polyline.'); return; }
          data.boundary = boundary;
          this.ctx.doc.selectEntity(boundary.id);
        } else {
          const boundary = data.boundary as Entity;
          const target = value as Entity;
          if (!isLineLikeEntity(boundary) || !isLineLikeEntity(target) || boundary.id === target.id) {
            this.ctx.log('Select a different line or polyline to trim.'); return;
          }
          if (!sameWorkPlane(boundary, target)) { this.ctx.log('Both lines must be on the same work plane.'); return; }
          const click = data.targetPickPoint as Vec2 | undefined;
          const targetSegment = click ? nearestLineLikeSegment(target, click) : nearestLineLikeSegment(target, target.type === 'line' ? target.start : target.vertices[0] ?? { x: 0, y: 0 });
          const hits = collectLineLikeIntersections(targetSegment, boundary)
            .filter((hit) => hit.t >= -1e-8 && hit.t <= 1 + 1e-8 && hit.u >= -1e-8 && hit.u <= 1 + 1e-8);
          if (hits.length === 0) {
            this.ctx.log('TRIM failed: the line or polyline does not cross the cutting edge.'); return;
          }
          const hit = click ? hits.reduce((best, candidate) => dist2(candidate.point, click) < dist2(best.point, click) ? candidate : best) : hits[0];
          const dx = targetSegment.end.x - targetSegment.start.x;
          const dy = targetSegment.end.y - targetSegment.start.y;
          const lengthSquared = dx * dx + dy * dy;
          const clickT = click && lengthSquared > 1e-12
            ? ((click.x - targetSegment.start.x) * dx + (click.y - targetSegment.start.y) * dy) / lengthSquared
            : 1;
          const updated = cloneEntity(target);
          if (updated.type === 'line') {
            if (clickT < hit.t) updated.start = hit.point;
            else updated.end = hit.point;
          } else if (updated.type === 'polyline') {
            if (clickT < hit.t) updated.vertices[targetSegment.startIndex] = hit.point;
            else updated.vertices[targetSegment.endIndex] = hit.point;
          }
          this.ctx.history.execute(new UpdateEntityEdit('Trim', target, updated));
          this.ctx.doc.selectEntity(updated.id);
          this.ctx.log(`${target.type === 'line' ? 'Line' : 'Polyline'} trimmed at cutting edge.`);
        }
        break;

      case 'OFFSET':
        if (this.active.stepIndex === 0) {
          const entity = value as Entity;
          if (!isOffsetEntity(entity)) { this.ctx.log('OFFSET accepts lines, circles, rectangles, and closed polylines.'); return; }
          data.entity = entity;
          this.ctx.doc.selectEntity(entity.id);
        } else if (this.active.stepIndex === 1) {
          const distance = Math.abs(value as number);
          if (distance < 1e-9) { this.ctx.log('Offset distance must be greater than zero.'); return; }
          data.distance = distance;
        } else {
          const entity = data.entity as Entity;
          const sidePoint = value as Vec2;
          const distance = data.distance as number;
          let parallel: Entity | null = null;
          if (entity.type === 'line') {
            const dx = entity.end.x - entity.start.x, dy = entity.end.y - entity.start.y;
            const length = Math.hypot(dx, dy);
            if (length < 1e-9) { this.ctx.log('Cannot offset a zero-length line.'); return; }
            const center = midpoint2(entity.start, entity.end);
            const sign = dx * (sidePoint.y - center.y) - dy * (sidePoint.x - center.x) >= 0 ? 1 : -1;
            const offset = { x: -dy / length * distance * sign, y: dx / length * distance * sign };
            parallel = this.ctx.doc.createLine(
              { x: entity.start.x + offset.x, y: entity.start.y + offset.y },
              { x: entity.end.x + offset.x, y: entity.end.y + offset.y },
            );
          } else if (entity.type === 'circle') {
            const outward = dist2(sidePoint, entity.center) >= entity.radius;
            const radius = entity.radius + (outward ? distance : -distance);
            if (radius <= 1e-6) { this.ctx.log('The inward offset is larger than the circle radius.'); return; }
            parallel = this.ctx.doc.createCircle(entity.center, radius);
          } else {
            const vertices = closedVertices(entity);
            if (!vertices) return;
            const outward = !pointInClosedPolygon(sidePoint, vertices);
            const offsetVertices = offsetPolygon(vertices, outward ? distance : -distance);
            if (!offsetVertices) { this.ctx.log('OFFSET failed for this shape and distance.'); return; }
            parallel = entity.type === 'rectangle'
              ? this.ctx.doc.createRectangle(offsetVertices[0], offsetVertices[2])
              : this.ctx.doc.createPolyline(offsetVertices, true);
          }
          if (!parallel) return;
          parallel.workPlane = cloneEntity(entity).workPlane;
          this.ctx.history.execute(new AddEntityEdit('Offset', parallel));
          this.ctx.doc.selectEntity(parallel.id);
          this.ctx.log(`Offset object created at ${distance.toFixed(3)} mm.`);
        }
        break;

      case 'CHAMFER':
      case 'FILLET':
        if (this.active.stepIndex === 0) {
          const edge = value as SolidEdgeSelection;
          data.edge = edge;
          this.ctx.doc.selectSolid(edge.solidId);
          this.ctx.log('Edge selected.');
        } else {
          const amount = Math.abs(value as number);
          if (amount < 1e-6) { this.ctx.log('Edge modification size must be greater than zero.'); return; }
          const edge = data.edge as SolidEdgeSelection;
          const solid = this.ctx.doc.getSolid(edge.solidId);
          if (!solid) { this.ctx.log('Solid not found.'); return; }
          const before = cloneSolid(solid);
          const mesh = await modifySolidEdge(solid.mesh, edge, amount, this.active.name === 'FILLET');
          if (!mesh) {
            this.ctx.log(`${this.active.name} failed. Use a smaller value or select a convex edge.`);
            return;
          }
          solid.mesh = mesh;
          solid.feature = { kind: 'mesh' };
          solid.revision++;
          this.ctx.history.recordApplied(new UpdateSolidEdit(this.active.name === 'FILLET' ? 'Fillet edge' : 'Chamfer edge', before, cloneSolid(solid)));
          this.ctx.doc.notify();
          this.ctx.log(`${this.active.name === 'FILLET' ? 'Fillet' : 'Chamfer'} complete: ${amount.toFixed(3)} mm.`);
        }
        break;

      case 'MOVE':
        if (this.active.stepIndex === 0) {
          if (typeof value === 'string') {
            const solid = this.ctx.doc.getSolid(value);
            const solids = data.solids as Solid[];
            if (solid && !solids.some((item) => item.id === solid.id)) solids.push(solid);
          } else if (value) {
            const entity = value as Entity;
            const entities = data.entities as Entity[];
            if (!entities.some((item) => item.id === entity.id)) entities.push(entity);
          }
          if (value) {
            this.ctx.log('Object added. Select another or press Enter.');
            return;
          }
        } else if (this.active.stepIndex === 1) {
          data.basePoint = value;
          data.baseWorldPoint = data.pendingMoveWorldPoint;
          delete data.pendingMoveWorldPoint;
        } else if (this.active.stepIndex === 2) {
          const base = data.basePoint as Vec2;
          const target = value as Vec2;
          const delta = { x: target.x - base.x, y: target.y - base.y };
          const baseWorld = data.baseWorldPoint as Vec3 | undefined;
          const targetWorld = data.pendingMoveWorldPoint as Vec3 | undefined;
          const worldDelta = baseWorld && targetWorld ? {
            x: targetWorld.x - baseWorld.x,
            y: targetWorld.y - baseWorld.y,
            z: targetWorld.z - baseWorld.z,
          } : undefined;
          const objects: Array<Entity | string> = [
            ...(data.entities as Entity[]),
            ...(data.solids as Solid[]).map((solid) => solid.id),
          ];
          if (objects.length === 0) { this.ctx.log('Nothing to move.'); this.showCurrentPrompt(); return; }
          // One drag is one thing the user did, so it is one step in the history.
          this.ctx.moveObjects(objects, delta, worldDelta);
          delete data.pendingMoveWorldPoint;
          this.ctx.log(`${objects.length} object(s) moved by ${formatPoint(delta)}`);
        }
        break;

      case 'COPY':
        if (this.active.stepIndex === 0) {
          if (typeof value === 'string') {
            const solid = this.ctx.doc.getSolid(value);
            const solids = data.solids as Solid[];
            if (solid && !solids.some((item) => item.id === solid.id)) solids.push(solid);
          } else if (value) {
            const entity = value as Entity;
            const entities = data.entities as Entity[];
            if (!entities.some((item) => item.id === entity.id)) entities.push(entity);
          }
          if (value) {
            this.ctx.log('Object added. Select another or press Enter.');
            return;
          }
        } else if (this.active.stepIndex === 1) {
          data.basePoint = value;
          data.baseWorldPoint = data.pendingMoveWorldPoint;
          delete data.pendingMoveWorldPoint;
        } else if (this.active.stepIndex === 2) {
          const base = data.basePoint as Vec2;
          const target = value as Vec2;
          const localDelta = { x: target.x - base.x, y: target.y - base.y };
          const baseWorld = data.baseWorldPoint as Vec3 | undefined;
          const targetWorld = data.pendingMoveWorldPoint as Vec3 | undefined;
          const exactWorldDelta = baseWorld && targetWorld
            ? { x: targetWorld.x - baseWorld.x, y: targetWorld.y - baseWorld.y, z: targetWorld.z - baseWorld.z }
            : undefined;
          const viewWorldDelta = exactWorldDelta ?? this.ctx.copyWorldDelta(localDelta);
          const plane = this.ctx.doc.activeWorkPlane;
          const solidDelta = viewWorldDelta ?? {
            x: plane.xAxis.x * localDelta.x + plane.yAxis.x * localDelta.y,
            y: plane.xAxis.y * localDelta.x + plane.yAxis.y * localDelta.y,
            z: plane.xAxis.z * localDelta.x + plane.yAxis.z * localDelta.y,
          };
          const copies = (data.entities as Entity[]).map((entity) => copyEntity(entity, localDelta, viewWorldDelta));
          const solidCopies = (data.solids as Solid[]).map((solid) => copySolid(solid, solidDelta));
          this.ctx.history.execute(new ReplaceObjectsEdit('Copy', [], [], copies, solidCopies));
          this.ctx.doc.clearSelection();
          copies.forEach((entity, index) => this.ctx.doc.selectEntity(entity.id, index > 0));
          solidCopies.forEach((solid) => this.ctx.doc.selectSolid(solid.id, true));
          delete data.pendingMoveWorldPoint;
          this.ctx.log(`Copied ${copies.length + solidCopies.length} object(s) by ${formatPoint(localDelta)}.`);
          this.active.stepIndex = 1;
        }
        break;

      case 'ARRAY_RECTANGULAR':
        if (this.active.stepIndex === 0) {
          if (typeof value === 'string') {
            const solid = this.ctx.doc.getSolid(value);
            const solids = data.solids as Solid[];
            if (solid && !solids.some((item) => item.id === solid.id)) solids.push(solid);
          } else if (value) {
            const entity = value as Entity;
            const entities = data.entities as Entity[];
            if (!entities.some((item) => item.id === entity.id)) entities.push(entity);
          }
          if (value) {
            this.ctx.log('Object added. Select another or press Enter.');
            return;
          }
        } else if (this.active.stepIndex >= 1 && this.active.stepIndex <= 4) {
          const n = Number(value);
          if (!Number.isFinite(n)) {
            this.ctx.log('Invalid number.');
            return;
          }
          if (this.active.stepIndex === 1) {
            if (!Number.isInteger(n) || n < 1) {
              this.ctx.log('Rows must be an integer greater than zero.');
              return;
            }
            data.rows = n;
          } else if (this.active.stepIndex === 2) {
            if (!Number.isInteger(n) || n < 1) {
              this.ctx.log('Columns must be an integer greater than zero.');
              return;
            }
            data.columns = n;
          } else if (this.active.stepIndex === 3) {
            if (n <= 0) {
              this.ctx.log('Row spacing must be greater than zero.');
              return;
            }
            data.rowSpacing = n;
          } else if (this.active.stepIndex === 4) {
            if (n <= 0) {
              this.ctx.log('Column spacing must be greater than zero.');
              return;
            }
            data.columnSpacing = n;
          }
          if (this.active.stepIndex === 4) {
            const rows = data.rows as number;
            const columns = data.columns as number;
            const rowSpacing = data.rowSpacing as number;
            const columnSpacing = data.columnSpacing as number;
            const originals = data.entities as Entity[];
            const originalSolids = data.solids as Solid[];
            const createdEntities: Entity[] = [];
            const createdSolids: Solid[] = [];
            const plane = this.ctx.doc.activeWorkPlane;
            for (let row = 0; row < rows; row++) {
              for (let column = 0; column < columns; column++) {
                if (row === 0 && column === 0) continue;
                const localDelta = { x: column * columnSpacing, y: row * rowSpacing };
                const worldDelta = workPlaneDelta(plane, localDelta);
                createdEntities.push(...originals.map((entity) => copyEntity(entity, localDelta)));
                createdSolids.push(...originalSolids.map((solid) => copySolid(solid, worldDelta)));
              }
            }
            this.ctx.history.execute(new ReplaceObjectsEdit('Rectangular array', [], [], createdEntities, createdSolids));
            this.ctx.doc.clearSelection();
            createdEntities.forEach((entity, index) => this.ctx.doc.selectEntity(entity.id, index > 0));
            createdSolids.forEach((solid) => this.ctx.doc.selectSolid(solid.id, true));
            this.ctx.log(`Created rectangular array: ${rows} x ${columns}.`);
            this.active = null;
            this.ctx.prompt('Command:');
            return;
          }
        }
        break;

      case 'ARRAY_POLAR':
        if (this.active.stepIndex === 0) {
          if (typeof value === 'string') {
            const solid = this.ctx.doc.getSolid(value);
            const solids = data.solids as Solid[];
            if (solid && !solids.some((item) => item.id === solid.id)) solids.push(solid);
          } else if (value) {
            const entity = value as Entity;
            const entities = data.entities as Entity[];
            if (!entities.some((item) => item.id === entity.id)) entities.push(entity);
          }
          if (value) {
            this.ctx.log('Object added. Select another or press Enter.');
            return;
          }
        } else if (this.active.stepIndex === 1) {
          data.center = value;
        } else if (this.active.stepIndex === 2) {
          const count = Number(value);
          if (!Number.isInteger(count) || count < 2) {
            this.ctx.log('Number of items must be an integer greater than one.');
            return;
          }
          data.count = count;
        } else if (this.active.stepIndex === 3) {
          const totalAngle = Number(value);
          if (!Number.isFinite(totalAngle) || Math.abs(totalAngle) <= 1e-9) {
            this.ctx.log('Total angle must be non-zero.');
            return;
          }
          data.totalAngle = totalAngle;
          const center = data.center as Vec2;
          const count = data.count as number;
          const originals = data.entities as Entity[];
          const originalSolids = data.solids as Solid[];
          const createdEntities: Entity[] = [];
          const createdSolids: Solid[] = [];
          const plane = this.ctx.doc.activeWorkPlane;
          const centerLocal = worldToLocal(plane, localToWorld(plane, center));
          for (let index = 1; index < count; index++) {
            const angle = (totalAngle * Math.PI / 180) * (index / (count - 1));
            createdEntities.push(...originals.map((entity) => rotateEntity(copyEntity(entity, { x: 0, y: 0 }), center, angle, this.ctx.doc)));
            createdSolids.push(...originalSolids.map((solid) => rotateSolidAroundPlane(copySolid(solid, { x: 0, y: 0, z: 0 }), centerLocal, angle, plane)));
          }
          this.ctx.history.execute(new ReplaceObjectsEdit('Polar array', [], [], createdEntities, createdSolids));
          this.ctx.doc.clearSelection();
          createdEntities.forEach((entity, index) => this.ctx.doc.selectEntity(entity.id, index > 0));
          createdSolids.forEach((solid) => this.ctx.doc.selectSolid(solid.id, true));
          this.ctx.log(`Created polar array: ${count} items over ${totalAngle.toFixed(3)}°.`);
          this.active = null;
          this.ctx.prompt('Command:');
          return;
        }
        break;

      case 'SCALE':
        if (this.active.stepIndex === 0) {
          if (typeof value === 'string') {
            const solid = this.ctx.doc.getSolid(value);
            const solids = data.solids as Solid[];
            if (solid && !solids.some((item) => item.id === solid.id)) solids.push(solid);
          } else if (value) {
            const entity = value as Entity;
            const entities = data.entities as Entity[];
            if (!entities.some((item) => item.id === entity.id)) entities.push(entity);
          }
          if (value) { this.ctx.log('Object added. Select another or press Enter.'); return; }
        } else if (this.active.stepIndex === 1) {
          data.basePoint = value;
          data.baseWorldPoint = data.pendingMoveWorldPoint;
          delete data.pendingMoveWorldPoint;
        } else if (this.active.stepIndex === 2) {
          const base = data.basePoint as Vec2;
          const target = value as Vec2;
          const factor = (data.enteredScaleFactor as number | undefined) ?? dist2(base, target);
          delete data.enteredScaleFactor;
          if (!Number.isFinite(factor) || factor <= 1e-9) {
            this.ctx.log('Scale factor must be greater than zero.');
            this.showCurrentPrompt();
            return;
          }
          const originals = data.entities as Entity[];
          const originalSolids = data.solids as Solid[];
          const baseWorld = (data.baseWorldPoint as Vec3 | undefined) ?? localToWorld(this.ctx.doc.activeWorkPlane, base);
          const scaledEntities = originals.map((entity) => scaleEntity(entity, base, factor));
          const scaledSolids = originalSolids.map((solid) => scaleSolid(solid, baseWorld, factor));
          this.ctx.history.execute(new ReplaceObjectsEdit('Scale', originals, originalSolids, scaledEntities, scaledSolids));
          this.ctx.doc.clearSelection();
          scaledEntities.forEach((entity, index) => this.ctx.doc.selectEntity(entity.id, index > 0));
          scaledSolids.forEach((solid) => this.ctx.doc.selectSolid(solid.id, true));
          this.ctx.log(`Scaled ${scaledEntities.length + scaledSolids.length} object(s) by factor ${factor.toFixed(4)}.`);
        }
        break;

      case 'EXPLODE':
        if (value) {
          if (typeof value === 'string') {
            const solid = this.ctx.doc.getSolid(value);
            const solids = data.solids as Solid[];
            if (solid && !solids.some((item) => item.id === solid.id)) solids.push(solid);
          } else {
            const entity = value as Entity;
            const entities = data.entities as Entity[];
            if (!entities.some((item) => item.id === entity.id)) entities.push(entity);
          }
          this.ctx.log('Object added. Select another or press Enter.');
          return;
        } else {
          const selectedEntities = data.entities as Entity[];
          const selectedSolids = data.solids as Solid[];
          const removedEntities: Entity[] = [];
          const removedSolids: Solid[] = [];
          const parts: Entity[] = [];
          const solidParts: Solid[] = [];
          for (const entity of selectedEntities) {
            const exploded = explodeEntity(entity, this.ctx.doc);
            if (exploded.length > 0) { removedEntities.push(entity); parts.push(...exploded); }
            else this.ctx.log(`EXPLODE: ${entity.type} is already a primitive object.`);
          }
          for (const solid of selectedSolids) {
            if (solid.feature.kind !== 'boolean') {
              this.ctx.log(`EXPLODE: ${solid.name} is not a boolean compound solid.`);
              continue;
            }
            const partCountBefore = solidParts.length;
            for (const [index, feature] of solid.feature.operands.entries()) {
              const mesh = await regenerateSolidFeature(feature);
              if (!mesh) continue;
              const part = this.ctx.doc.createSolid(mesh, `${solid.name}_part_${index + 1}`, solid.height, solid.sourceEntityIds, solid.color, JSON.parse(JSON.stringify(feature)) as SolidFeature);
              part.layer = solid.layer;
              solidParts.push(part);
            }
            if (solidParts.length > partCountBefore) removedSolids.push(solid);
          }
          if (parts.length + solidParts.length === 0) {
            this.ctx.log('EXPLODE: no selected object can be exploded.');
            break;
          }
          this.ctx.history.execute(new ReplaceObjectsEdit('Explode', removedEntities, removedSolids, parts, solidParts));
          this.ctx.doc.clearSelection();
          parts.forEach((entity, index) => this.ctx.doc.selectEntity(entity.id, index > 0));
          solidParts.forEach((solid) => this.ctx.doc.selectSolid(solid.id, true));
          this.ctx.log(`Exploded into ${parts.length + solidParts.length} part(s).`);
        }
        break;

      case 'ROTATE':
        if (this.active.stepIndex === 0 && step.kind === 'entity' && value) {
          const entity = value as Entity;
          const entities = data.entities as Entity[];
          if (!entities.some((item) => item.id === entity.id)) {
            entities.push(entity);
            this.ctx.doc.selectEntity(entity.id, true);
          }
          this.ctx.log('Object added. Select another or press Enter.');
          return;
        } else if (this.active.stepIndex === 1) {
          data.basePoint = value;
        } else if (this.active.stepIndex === 2) {
          const base = data.basePoint as Vec2;
          const target = value as Vec2;
          const angle = Math.atan2(target.y - base.y, target.x - base.x);
          const originals = data.entities as Entity[];
          const originalSolids = (data.solids as Solid[] | undefined) ?? [];
          const rotated = originals.map((entity) => rotateEntity(entity, base, angle, this.ctx.doc));
          // Solids turn about the same axis the drawing does: the work plane's
          // normal, through the base point. ARRAY has always rotated them this
          // way; ROTATE simply never asked for them.
          const plane = this.ctx.doc.activeWorkPlane;
          const rotatedSolids = originalSolids.map((solid) => rotateSolidAroundPlane(cloneSolid(solid), { x: base.x, y: base.y, z: 0 }, angle, plane));
          this.ctx.history.execute(new ReplaceObjectsEdit('Rotate', originals, originalSolids, rotated, rotatedSolids));
          this.ctx.doc.clearSelection();
          rotated.forEach((entity, index) => this.ctx.doc.selectEntity(entity.id, index > 0));
          rotatedSolids.forEach((solid) => this.ctx.doc.selectSolid(solid.id, true));
          this.ctx.log(`Rotated ${rotated.length + rotatedSolids.length} object(s) by ${(angle * 180 / Math.PI).toFixed(3)}°.`);
        }
        break;

      case 'PRESSPULL':
        if (this.active.stepIndex === 0) {
          if (typeof value === 'string') data.solidId = value;
          else {
            const face = value as SolidFaceSelection;
            data.solidId = face.solidId;
            data.face = face;
          }
        }
        else if (this.active.stepIndex === 1) {
          const solid = this.ctx.doc.getSolid(data.solidId as string);
          if (!solid) {
            this.ctx.log('Solid not found.');
            break;
          }
          const delta = value as number;
          const before = cloneSolid(solid);
          this.ctx.log('Applying PressPull…');
          let mesh;
          const face = data.face as SolidFaceSelection | undefined;
          if (face) {
            mesh = pressPullFace(solid.mesh, face.vertexIndices, face.normal, delta);
            if (mesh) solid.feature = { kind: 'mesh' };
          } else if (solid.feature.kind === 'extrusion') {
            const nextFeature = JSON.parse(JSON.stringify(solid.feature)) as typeof solid.feature;
            nextFeature.height = Math.max(0.01, nextFeature.height + delta);
            mesh = await regenerateSolidFeature(nextFeature);
            if (mesh) solid.feature = nextFeature;
          } else {
            mesh = await pressPullSolid(solid.mesh, delta);
          }
          if (mesh) {
            solid.mesh = mesh;
            solid.height = solid.feature.kind === 'extrusion'
              ? solid.feature.height
              : Math.max(0.01, solid.height + delta);
            solid.revision++;
            const after = cloneSolid(solid);
            this.ctx.history.recordApplied(new UpdateSolidEdit('Press/Pull', before, after));
            this.ctx.doc.notify();
            this.ctx.log(`PressPull complete, delta=${delta}`);
          }
        }
        break;

      case 'DIMALIGNED':
      case 'MEASURE':
        if (this.active.stepIndex === 0) data.start = value;
        else if (this.active.stepIndex === 1) data.end = value;
        else if (this.active.stepIndex === 2) data.offset = value;
        else {
          // The last step, so the dimension is built once and lands in the
          // history as a single entry — placing the text is part of drawing it,
          // not an edit of something already drawn.
          const start = data.start as Vec2 | Vec3;
          const end = data.end as Vec2 | Vec3;
          const a: Vec3 = { x: start.x, y: start.y, z: 'z' in start ? start.z : 0 };
          const b: Vec3 = { x: end.x, y: end.y, z: 'z' in end ? end.z : 0 };
          const offset = data.offset as Vec2;
          const aligned = this.active.name === 'DIMALIGNED';
          const dimension = this.ctx.doc.createDimension(
            { x: start.x, y: start.y }, { x: end.x, y: end.y }, offset,
            aligned ? 'aligned' : 'linear',
            aligned ? undefined : linearDimensionRotation({ x: start.x, y: start.y }, { x: end.x, y: end.y }, offset),
          );
          // Enter arrives as null, which is the step declining to move the text.
          const textPosition = value as Vec2 | null;
          if (textPosition) dimension.textPosition = { x: textPosition.x, y: textPosition.y };
          this.ctx.history.execute(new AddEntityEdit('Dimension', dimension));
          const measured = aligned ? dist3(a, b) : Number(dimensionGeometry(dimension).text);
          this.ctx.log(`Dimension created: ${measured.toFixed(dimension.precision)} mm (${formatPoint(a)} -> ${formatPoint(b)})`);
        }
        break;

      case 'DIMRADIUS':
      case 'DIMDIAMETER':
        if (this.active.stepIndex === 0) {
          const entity = value as Entity;
          if (entity.type !== 'circle' && entity.type !== 'arc') {
            this.ctx.log('Dimension requires a circle or arc.');
            this.showCurrentPrompt();
            return;
          }
          data.entity = entity;
        } else {
          const entity = data.entity as Entity;
          if (entity.type !== 'circle' && entity.type !== 'arc') return;
          const cursor = value as Vec2;
          let dx = cursor.x - entity.center.x, dy = cursor.y - entity.center.y;
          const distance = Math.hypot(dx, dy);
          if (distance < 1e-9) { dx = 1; dy = 0; }
          else { dx /= distance; dy /= distance; }
          const point = { x: entity.center.x + dx * entity.radius, y: entity.center.y + dy * entity.radius };
          const dimension = this.ctx.doc.createDimension(entity.center, point, cursor, this.active.name === 'DIMRADIUS' ? 'radius' : 'diameter');
          dimension.workPlane = cloneWorkPlane(entity.workPlane ?? WORLD_WORK_PLANE);
          this.ctx.history.execute(new AddEntityEdit(this.active.name === 'DIMRADIUS' ? 'Radius dimension' : 'Diameter dimension', dimension));
          this.ctx.log(`${this.active.name === 'DIMRADIUS' ? 'Radius' : 'Diameter'} dimension created.`);
        }
        break;

      case 'UCS':
        if (this.active.stepIndex === 0) data.origin = value;
        else if (this.active.stepIndex === 1) data.xPoint = value;
        else {
          const origin = data.origin as Vec3;
          const xPoint = data.xPoint as Vec3;
          const yPoint = value as Vec3;
          this.ctx.doc.activeWorkPlane = workPlaneFromXYAxes(origin, xPoint, yPoint);
          this.ctx.doc.viewMode = '3d';
          this.ctx.workPlaneChanged?.();
          this.ctx.doc.notify();
          this.ctx.log(`UCS set: origin ${formatPoint(origin)}, X through ${formatPoint(xPoint)}, Y through ${formatPoint(yPoint)}`);
        }
        break;

      case 'ERASE': {
        if (this.active.stepIndex === 0 && value) {
          if (typeof value === 'string') {
            const solid = this.ctx.doc.getSolid(value);
            const solids = data.solids as Solid[];
            if (solid && !solids.some((item) => item.id === solid.id)) solids.push(solid);
          } else {
            const entity = value as Entity;
            const entities = data.entities as Entity[];
            if (!entities.some((item) => item.id === entity.id)) entities.push(entity);
          }
          this.ctx.log('Object added. Select another or press Enter.');
          return;
        }
        // Enter: everything gathered goes in one undoable edit.
        const entities = (data.entities as Entity[]).map(cloneEntity);
        const solids = (data.solids as Solid[]).map(cloneSolid);
        if (entities.length + solids.length === 0) {
          this.cancelActive();
          this.ctx.log('Nothing to delete.');
          this.ctx.prompt('Command:');
          return;
        }
        this.ctx.history.execute(new ReplaceObjectsEdit('Delete objects', entities, solids, [], []));
        this.ctx.log(`Deleted ${entities.length + solids.length} object(s).`);
        break;
      }
    }

    this.active.stepIndex++;
    while (this.active && this.active.steps[this.active.stepIndex]?.kind === 'done') {
      if (isStickyCommand(this.active.name)) {
        // Drawing tools stay active until Escape or another command is chosen.
        // A restart is a fresh run, so its data comes from where a fresh run's
        // data comes from — naming one command here left DIMALIGNED and the
        // radial dimensions restarting without the style they were started with.
        this.active.stepIndex = 0;
        this.active.data = commandDef(this.active.name).data?.(this.ctx) ?? {};
      } else {
        this.active = null;
      }
      break;
    }

    if (this.active) {
      this.showCurrentPrompt();
    } else {
      this.ctx.prompt('Command:');
    }
    this.ctx.redraw();
  }

  historyUp(): string | null {
    if (this.history.length === 0) return null;
    this.historyIndex = Math.max(0, this.historyIndex - 1);
    return this.history[this.historyIndex];
  }

  historyDown(): string | null {
    if (this.history.length === 0) return null;
    this.historyIndex = Math.min(this.history.length, this.historyIndex + 1);
    if (this.historyIndex >= this.history.length) return '';
    return this.history[this.historyIndex];
  }
}

/**
 * Which way a linear dimension measures, from where its line was pulled: drag it
 * up or down and it reads the horizontal distance, drag it aside and it reads the
 * vertical one. This is what AutoCAD does while you place it.
 */
/**
 * A profile pushed through a height, signed.
 *
 * A negative height used to be thrown away by `Math.abs`, on the reasoning that
 * an extrusion is a distance along the work plane's positive Z and a direction
 * is the UCS's business. But asking for -10 and being handed +10 is not a
 * convention, it is the app disagreeing with you in silence — and every CAD
 * program in the world extrudes downwards for a negative height.
 *
 * Manifold only extrudes along +Z, so downwards is the same prism built upwards
 * and dropped by its own height. `transform.translateZ` already existed for
 * exactly this kind of thing, and regeneration already honours it.
 */
export function extrusionFeature(profile: Entity, height: number): ExtrusionFeature {
  return {
    kind: 'extrusion',
    profile: cloneEntity(profile),
    height: Math.abs(height),
    // Cloned: the fallback is a shared constant, and a feature holding it would
    // hand every extrusion in the document the same work plane object.
    workPlane: cloneWorkPlane(profile.workPlane ?? WORLD_WORK_PLANE),
    transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, translateZ: height < 0 ? height : 0 },
  };
}

export function linearDimensionRotation(start: Vec2, end: Vec2, offset: Vec2): number {
  // A leg of zero has nothing to dimension, so the other one is the only answer
  // there is: an axis-aligned line always reads its own length.
  if (Math.abs(end.y - start.y) <= 1e-9) return 0;
  if (Math.abs(end.x - start.x) <= 1e-9) return Math.PI / 2;

  // Otherwise it is where the dimension line was pulled *past the points*: above
  // or below them reads across, beside them reads up. Measuring from their
  // midpoint instead would make a point that is merely far along the line look
  // like it was pulled sideways.
  const beyond = (value: number, low: number, high: number): number =>
    Math.max(low - value, value - high, 0);
  const outsideX = beyond(offset.x, Math.min(start.x, end.x), Math.max(start.x, end.x));
  const outsideY = beyond(offset.y, Math.min(start.y, end.y), Math.max(start.y, end.y));
  return outsideX > outsideY ? Math.PI / 2 : 0;
}

/** Distance from a point to a segment — the basis of every stroke hit test. */
function distanceToSegment(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (length2 < 1e-12) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** True when the point lies inside the ellipse — its own frame, so rotation is undone. */
export function pointInEllipse(point: Vec2, e: Extract<Entity, { type: 'ellipse' }>): boolean {
  const dx = point.x - e.center.x, dy = point.y - e.center.y;
  const cos = Math.cos(-e.rotation), sin = Math.sin(-e.rotation);
  const x = dx * cos - dy * sin;
  const y = dx * sin + dy * cos;
  if (e.radiusX < 1e-12 || e.radiusY < 1e-12) return false;
  return (x / e.radiusX) ** 2 + (y / e.radiusY) ** 2 <= 1;
}

/** True when the point is within tolerance of any segment of the chain. */
function hitsChain(point: Vec2, vertices: Vec2[], tolerance: number): boolean {
  for (let i = 1; i < vertices.length; i++) {
    if (distanceToSegment(point, vertices[i - 1], vertices[i]) <= tolerance) return true;
  }
  return false;
}

export function hitTestEntity(entities: Entity[], point: Vec2, tolerance = 0.5): Entity | null {
  for (let i = entities.length - 1; i >= 0; i--) {
    const e = entities[i];
    switch (e.type) {
      case 'line': {
        if (distanceToSegment(point, e.start, e.end) <= tolerance) return e;
        break;
      }
      case 'circle': {
        const d = Math.hypot(point.x - e.center.x, point.y - e.center.y);
        if (Math.abs(d - e.radius) <= tolerance || d <= e.radius) return e;
        break;
      }
      case 'ellipse': {
        // Inside counts, as it does for a circle; otherwise test the outline.
        if (pointInEllipse(point, e) || hitsChain(point, ellipsePoints(e, 64), tolerance)) return e;
        break;
      }
      case 'rectangle': {
        const minX = Math.min(e.first.x, e.opposite.x);
        const maxX = Math.max(e.first.x, e.opposite.x);
        const minY = Math.min(e.first.y, e.opposite.y);
        const maxY = Math.max(e.first.y, e.opposite.y);
        if (point.x >= minX - tolerance && point.x <= maxX + tolerance && point.y >= minY - tolerance && point.y <= maxY + tolerance) return e;
        break;
      }
      case 'octagon':
      case 'polyline': {
        // Test the strokes, the way the renderer draws them. Testing only the
        // vertices made a polyline pickable at its corners and nowhere else.
        const closed = e.type === 'octagon' || e.closed;
        if (hitsChain(point, closed ? closePolyline(e.vertices) : e.vertices, tolerance)) return e;
        break;
      }
      case 'arc':
      case 'bezier': {
        if (hitsChain(point, curvePoints(e), tolerance)) return e;
        break;
      }
      case 'text':
      case 'dimension': {
        const b = entityBounds(e);
        if (point.x >= b.min.x - tolerance && point.x <= b.max.x + tolerance && point.y >= b.min.y - tolerance && point.y <= b.max.y + tolerance) return e;
        break;
      }
    }
  }
  return null;
}
