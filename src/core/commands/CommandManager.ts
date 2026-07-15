import type { Document } from '../Document';
import type { Vec2, Vec3 } from '../../math/geometry';
import { dist2, dist3, formatPoint, midpoint2, mirrorPoint2 } from '../../math/geometry';
import { workPlaneFromXYAxes } from '../../math/workplane';
import { transformMeshByWorkPlane, transformMeshIndicesByWorkPlane, WORLD_WORK_PLANE } from '../../math/workplane';
import { cloneEntity, curvePoints, entityBounds, genId, getEntityPoints, transformEntityPoints, type Entity, type SolidEdgeSelection, type SolidFaceSelection } from '../entities/types';
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
  pressPullSolid,
  pressPullFace,
  modifySolidEdge,
  regenerateSolidFeature,
} from '../solids/ManifoldEngine';

export type CommandName =
  | 'LINE'
  | 'CIRCLE'
  | 'RECTANGLE'
  | 'OCTAGON'
  | 'POLYGON'
  | 'ARC' | 'BEZIER' | 'TEXT'
  | 'EXTRUDE'
  | 'SUBTRACT'
  | 'UNION'
  | 'MIRROR'
  | 'JOIN'
  | 'EXTEND'
  | 'TRIM'
  | 'OFFSET'
  | 'CHAMFER'
  | 'FILLET'
  | 'MOVE'
  | 'ROTATE'
  | 'PRESSPULL'
  | 'MEASURE'
  | 'UCS'
  | 'SELECT'
  | 'ERASE'
  | 'VIEW2D'
  | 'VIEW3D'
  | 'ZOOM'
  | 'GRID'
  | 'SNAP'
  | 'UNDO'
  | 'REDO'
  | 'HELP';

export interface CommandContext {
  doc: Document;
  log: (msg: string) => void;
  prompt: (msg: string) => void;
  getCursor: () => Vec2;
  redraw: () => void;
  history: CommandHistory;
  moveObject: (object: Entity | string, screenDelta: Vec2, worldDelta?: Vec3) => void;
  workPlaneChanged?: () => void;
}

export type CommandStep =
  | { kind: 'point'; label: string; optional?: boolean }
  | { kind: 'number'; label: string; optional?: boolean }
  | { kind: 'entity'; label: string; optional?: boolean }
  | { kind: 'solid'; label: string; optional?: boolean }
  | { kind: 'edge'; label: string; optional?: boolean }
  | { kind: 'text'; label: string; optional?: boolean }
  | { kind: 'done' };

export interface ActiveCommand {
  name: CommandName;
  steps: CommandStep[];
  stepIndex: number;
  data: Record<string, unknown>;
  preview?: (cursor: Vec2) => void;
  cancel?: () => void;
}

const COMMAND_ALIASES: Record<string, CommandName> = {
  L: 'LINE',
  LINE: 'LINE',
  C: 'CIRCLE',
  CIRCLE: 'CIRCLE',
  R: 'RECTANGLE',
  REC: 'RECTANGLE',
  RECTANGLE: 'RECTANGLE',
  OCT: 'OCTAGON',
  OCTAGON: 'OCTAGON',
  POL: 'POLYGON',
  POLYGON: 'POLYGON',
  A: 'ARC', ARC: 'ARC', B: 'BEZIER', BEZIER: 'BEZIER', T: 'TEXT', TEXT: 'TEXT',
  E: 'EXTRUDE',
  EXT: 'EXTRUDE',
  EXTRUDE: 'EXTRUDE',
  SUB: 'SUBTRACT',
  SUBTRACT: 'SUBTRACT',
  SUBSTRACT: 'SUBTRACT',
  S: 'SUBTRACT',
  UNI: 'UNION',
  UNION: 'UNION',
  U: 'UNION',
  MI: 'MIRROR',
  MIRROR: 'MIRROR',
  J: 'JOIN',
  JOIN: 'JOIN',
  EX: 'EXTEND',
  EXTEND: 'EXTEND',
  TR: 'TRIM',
  TRIM: 'TRIM',
  O: 'OFFSET',
  OFFSET: 'OFFSET',
  EQUID: 'OFFSET',
  EKVID: 'OFFSET',
  CHA: 'CHAMFER',
  CHAMFER: 'CHAMFER',
  F: 'FILLET',
  FILLET: 'FILLET',
  MOVE: 'MOVE',
  RO: 'ROTATE',
  ROTATE: 'ROTATE',
  PP: 'PRESSPULL',
  PRESSPULL: 'PRESSPULL',
  DI: 'MEASURE',
  MEASURE: 'MEASURE',
  UCS: 'UCS',
  ERASE: 'ERASE',
  V2: 'VIEW2D',
  VIEW2D: 'VIEW2D',
  V3: 'VIEW3D',
  VIEW3D: 'VIEW3D',
  Z: 'ZOOM',
  ZOOM: 'ZOOM',
  GR: 'GRID',
  GRID: 'GRID',
  SN: 'SNAP',
  SNAP: 'SNAP',
  UNDO: 'UNDO',
  REDO: 'REDO',
  H: 'HELP',
  HELP: 'HELP',
};

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

function sameWorkPlane(a: Entity, b: Entity): boolean {
  return JSON.stringify(a.workPlane ?? WORLD_WORK_PLANE) === JSON.stringify(b.workPlane ?? WORLD_WORK_PLANE);
}

function isOffsetEntity(entity: Entity): boolean {
  return entity.type === 'line' || entity.type === 'circle' || entity.type === 'rectangle'
    || entity.type === 'octagon' || (entity.type === 'polyline' && entity.closed);
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
    case 'rectangle': break;
  }
  return result;
}

export class CommandManager {
  active: ActiveCommand | null = null;
  history: string[] = [];
  historyIndex = -1;

  constructor(private ctx: CommandContext) {}

  updateContext(ctx: Partial<CommandContext>): void {
    Object.assign(this.ctx, ctx);
  }

  resolveAlias(input: string): CommandName | null {
    const key = input.trim().toUpperCase();
    return COMMAND_ALIASES[key] ?? null;
  }

  commandSuggestions(input: string): CommandName[] {
    const prefix = input.trim().toUpperCase();
    if (!prefix) return [];
    const commands: CommandName[] = [
      'LINE', 'RECTANGLE', 'CIRCLE', 'POLYGON', 'ARC', 'BEZIER', 'TEXT', 'MEASURE', 'MOVE', 'ROTATE', 'MIRROR', 'JOIN', 'EXTEND', 'TRIM', 'OFFSET', 'CHAMFER', 'FILLET',
      'EXTRUDE', 'PRESSPULL', 'UNION', 'SUBTRACT',
      'UCS',
    ];
    return commands.filter((command) => command.startsWith(prefix));
  }

  startCommand(name: CommandName): void {
    this.cancelActive();
    switch (name) {
      case 'LINE':
        this.active = {
          name,
          steps: [
            { kind: 'point', label: 'Specify first point:' },
            { kind: 'point', label: 'Specify second point:' },
            { kind: 'done' },
          ],
          stepIndex: 0,
          data: {},
        };
        break;
      case 'CIRCLE':
        this.active = {
          name,
          steps: [
            { kind: 'point', label: 'Specify circle center:' },
            { kind: 'point', label: 'Specify radius or point on circumference:' },
            { kind: 'done' },
          ],
          stepIndex: 0,
          data: {},
        };
        break;
      case 'RECTANGLE':
        this.active = {
          name,
          steps: [
            { kind: 'point', label: 'Specify first rectangle corner:' },
            { kind: 'point', label: 'Specify opposite corner:' },
            { kind: 'done' },
          ],
          stepIndex: 0,
          data: {},
        };
        break;
      case 'OCTAGON':
        this.active = {
          name,
          steps: [
            { kind: 'point', label: 'Specify octagon center:' },
            { kind: 'point', label: 'Specify radius (point on circumference):' },
            { kind: 'done' },
          ],
          stepIndex: 0,
          data: {},
        };
        break;
      case 'POLYGON':
        this.active = {
          name,
          steps: [
            { kind: 'point', label: 'Specify polygon center:' },
            { kind: 'number', label: 'Enter number of sides:' },
            { kind: 'point', label: 'Specify perpendicular distance to side:' },
            { kind: 'done' },
          ],
          stepIndex: 0,
          data: {},
        };
        break;
      case 'ARC': this.active = { name, steps: [{ kind: 'point', label: 'Specify arc center:' }, { kind: 'point', label: 'Specify start point:' }, { kind: 'point', label: 'Specify end point or angle:' }, { kind: 'done' }], stepIndex: 0, data: {} }; break;
      case 'BEZIER': this.active = { name, steps: [{ kind: 'point', label: 'Specify start point:' }, { kind: 'point', label: 'Specify first control point:' }, { kind: 'point', label: 'Specify second control point:' }, { kind: 'point', label: 'Specify end point:' }, { kind: 'done' }], stepIndex: 0, data: {} }; break;
      case 'TEXT': this.active = {
        name,
        steps: [
          { kind: 'text', label: 'Select font:' },
          { kind: 'number', label: 'Enter text height in mm:' },
          { kind: 'point', label: 'Specify text insertion point:' },
          { kind: 'text', label: 'Enter text:' },
          { kind: 'done' },
        ],
        stepIndex: 0,
        data: {},
      }; break;
      case 'EXTRUDE':
        {
        const selectedProfile = this.ctx.doc.getSelectedEntities()[0]
          ?? this.ctx.doc.entities.find((entity) => entity.selected);
        this.active = {
          name,
          steps: [
            { kind: 'entity', label: 'Select a closed 2D profile:' },
            { kind: 'number', label: 'Enter extrusion height:' },
            { kind: 'done' },
          ],
          stepIndex: selectedProfile ? 1 : 0,
          data: { entities: selectedProfile ? [selectedProfile] : [] as Entity[] },
        };
        break;
        }
      case 'SUBTRACT':
        this.active = {
          name,
          steps: [
            { kind: 'solid', label: 'Select base solid:' },
            { kind: 'solid', label: 'Select solid to subtract:' },
            { kind: 'done' },
          ],
          stepIndex: 0,
          data: {},
        };
        break;
      case 'UNION':
        this.active = {
          name,
          steps: [
            { kind: 'solid', label: 'Select first solid:' },
            { kind: 'solid', label: 'Select second solid:' },
            { kind: 'done' },
          ],
          stepIndex: 0,
          data: { solids: [] as string[] },
        };
        break;
      case 'MIRROR':
        this.active = {
          name,
          steps: [
            { kind: 'entity', label: 'Select object(s) — click, then Enter to continue:' },
            { kind: 'point', label: 'Specify first mirror-axis point:' },
            { kind: 'point', label: 'Specify second mirror-axis point:' },
            { kind: 'done' },
          ],
          stepIndex: 0,
          data: { entities: [] as Entity[] },
        };
        break;
      case 'JOIN': {
        const selectedLines = this.ctx.doc.getSelectedEntities().filter((entity) => entity.type === 'line' || entity.type === 'arc' || entity.type === 'bezier');
        this.active = {
          name,
          steps: [
            { kind: 'entity', label: 'Select connected lines or curves, then press Enter:' },
            { kind: 'done' },
          ],
          stepIndex: 0,
          data: { entities: selectedLines },
        };
        if (selectedLines.length > 0) this.ctx.log(`${selectedLines.length} preselected object(s). Press Enter to join.`);
        break;
      }
      case 'EXTEND':
      case 'TRIM': {
        const selectedLine = this.ctx.doc.getSelectedEntities().find((entity) => entity.type === 'line');
        this.active = {
          name,
          steps: [
            { kind: 'entity', label: `Select ${name === 'EXTEND' ? 'boundary' : 'cutting'} line:` },
            { kind: 'entity', label: `Select line to ${name === 'EXTEND' ? 'extend' : 'trim'}:` },
            { kind: 'done' },
          ],
          stepIndex: selectedLine ? 1 : 0,
          data: { boundary: selectedLine },
        };
        if (selectedLine) this.ctx.log(`${name === 'EXTEND' ? 'Boundary' : 'Cutting'} line preselected.`);
        break;
      }
      case 'OFFSET': {
        const selectedLine = this.ctx.doc.getSelectedEntities().find(isOffsetEntity);
        this.active = {
          name,
          steps: [
            { kind: 'entity', label: 'Select line or closed 2D object to offset:' },
            { kind: 'number', label: 'Enter offset distance:' },
            { kind: 'point', label: 'Specify side for offset:' },
            { kind: 'done' },
          ],
          stepIndex: selectedLine ? 1 : 0,
          data: { entity: selectedLine },
        };
        if (selectedLine) this.ctx.log('Object preselected. Enter offset distance.');
        break;
      }
      case 'CHAMFER':
      case 'FILLET':
        this.active = {
          name,
          steps: [
            { kind: 'edge', label: `Select solid edge to ${name === 'CHAMFER' ? 'chamfer' : 'fillet'}:` },
            { kind: 'number', label: `Enter ${name === 'CHAMFER' ? 'chamfer distance' : 'fillet radius'}:` },
            { kind: 'done' },
          ],
          stepIndex: 0,
          data: {},
        };
        break;
      case 'MOVE':
        this.active = {
          name,
          steps: [
            { kind: 'entity', label: 'Select object to move:' },
            { kind: 'point', label: 'Specify base point:' },
            { kind: 'point', label: 'Specify target point:' },
            { kind: 'done' },
          ],
          stepIndex: 0,
          data: {},
        };
        break;
      case 'ROTATE': {
        const selected = this.ctx.doc.getSelectedEntities();
        this.active = {
          name,
          steps: [
            { kind: 'entity', label: 'Select 2D object(s), then press Enter:' },
            { kind: 'point', label: 'Specify rotation base point:' },
            { kind: 'point', label: 'Specify rotation angle or enter degrees:' },
            { kind: 'done' },
          ],
          stepIndex: selected.length > 0 ? 1 : 0,
          data: { entities: [...selected] },
        };
        if (selected.length > 0) this.ctx.log(`${selected.length} object(s) preselected. Specify rotation base point.`);
        break;
      }
      case 'PRESSPULL':
        this.active = {
          name,
          steps: [
            { kind: 'solid', label: 'Select solid:' },
            { kind: 'number', label: 'Enter height change (+/-):' },
            { kind: 'done' },
          ],
          stepIndex: 0,
          data: {},
        };
        break;
      case 'MEASURE':
        this.active = {
          name,
          steps: [
            { kind: 'point', label: 'Select first measurement point:' },
            { kind: 'point', label: 'Select second measurement point:' },
            { kind: 'done' },
          ],
          stepIndex: 0,
          data: {},
        };
        break;
      case 'UCS':
        this.active = {
          name,
          steps: [
            { kind: 'point', label: 'Select UCS origin vertex:' },
            { kind: 'point', label: 'Select a point on the positive X axis:' },
            { kind: 'point', label: 'Select a point on the positive Y axis:' },
            { kind: 'done' },
          ],
          stepIndex: 0,
          data: {},
        };
        break;
      case 'ERASE':
        this.active = {
          name,
          steps: [
            { kind: 'entity', label: 'Select object to delete (or a 3D solid):' },
            { kind: 'done' },
          ],
          stepIndex: 0,
          data: {},
        };
        break;
      case 'VIEW2D':
        this.ctx.doc.viewMode = '2d';
        this.ctx.redraw();
        this.ctx.log('Rezim zobrazeni: 2D');
        return;
      case 'VIEW3D':
        this.ctx.doc.viewMode = '3d';
        this.ctx.redraw();
        this.ctx.log('Rezim zobrazeni: 3D');
        return;
      case 'SNAP':
        this.ctx.doc.snapEnabled = !this.ctx.doc.snapEnabled;
        this.ctx.log(`Snap: ${this.ctx.doc.snapEnabled ? 'ON' : 'OFF'}`);
        return;
      case 'ZOOM':
        this.ctx.log('Zoom extents aktivujte tlacitkem ZOOM nebo koleckem mysi.');
        return;
      case 'UNDO':
        this.ctx.log(this.ctx.history.undo() ? 'Undo complete.' : 'Nothing to undo.');
        this.ctx.redraw();
        return;
      case 'REDO':
        this.ctx.log(this.ctx.history.redo() ? 'Redo complete.' : 'Nothing to redo.');
        this.ctx.redraw();
        return;
      case 'HELP':
        this.printHelp();
        return;
      default:
        this.ctx.log(`Unknown command: ${name}`);
        return;
    }
    this.showCurrentPrompt();
  }

  printHelp(): void {
    const lines = [
      '=== MyCAD — available commands ===',
      'LINE (L)       — draw line',
      'CIRCLE (C)     — draw circle',
      'RECTANGLE (R)  — draw rectangle',
      'POLYGON (P)    — draw regular polygon',
      'MEASURE (M)    — measure point to point',
      'EXTRUDE (E)    — extrude closed profile',
      'SUBTRACT (S)   — subtract solids',
      'UNION (U)      — join solids',
      'MIRROR (MI)    — mirror objects',
      'JOIN (J)       — join connected 2D lines into one polyline',
      'EXTEND (EX)    — extend a line to a boundary',
      'TRIM (TR)      — trim a line at a cutting edge',
      'OFFSET (O)     — create an equidistant parallel line',
      'CHAMFER (CHA)  — chamfer a solid edge',
      'FILLET (F)     — round a solid edge',
      'MOVE (MO)      — move in view plane',
      'PRESSPULL (PP) — modify a solid face',
      'ERASE          — delete object',
      'VIEW2D (V2)    — 2D view',
      'VIEW3D (V3)    — 3D view',
      'SNAP (SN)      — toggle snap',
      'UNDO           — undo last edit',
      'REDO           — redo last edit',
      'Command+drag = orbit 3D, wheel / trackpad = zoom',
    ];
    for (const l of lines) this.ctx.log(l);
  }

  cancelActive(): void {
    if (this.active?.cancel) this.active.cancel();
    this.active = null;
  }

  currentPrompt(): string {
    if (!this.active) return 'Enter command:';
    const step = this.active.steps[this.active.stepIndex];
    if (step.kind === 'done') return 'Enter command:';
    return step.label;
  }

  showCurrentPrompt(): void {
    this.ctx.prompt(this.currentPrompt());
  }

  async submitInput(input: string): Promise<void> {
    const trimmed = input.trim();

    if (!this.active) {
      if (!trimmed) return;
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
      if ((this.active.name === 'MIRROR' || this.active.name === 'JOIN' || this.active.name === 'ROTATE')
        && step.kind === 'entity' && (this.active.data.entities as Entity[]).length > 0) {
        await this.advanceStep(null);
        return;
      }
      this.cancelActive();
      this.ctx.log('Command canceled.');
      this.ctx.prompt('Enter command:');
      return;
    }

    await this.processStepInput(trimmed, step);
  }

  async handleClick(world: Vec2 | Vec3, pickEntity?: Entity, pickSolidId?: string, pickFace?: SolidFaceSelection, pickEdge?: SolidEdgeSelection): Promise<void> {
    if (!this.active) return;
    const step = this.active.steps[this.active.stepIndex];

    if (step.kind === 'point') {
      await this.advanceStep(world);
    } else if (step.kind === 'entity' && pickEntity) {
      const additive = this.active.stepIndex === 0 && ['MIRROR', 'JOIN', 'ROTATE'].includes(this.active.name);
      this.ctx.doc.selectEntity(pickEntity.id, additive);
      if (this.active.name === 'TRIM' && this.active.stepIndex === 1) this.active.data.targetPickPoint = world;
      await this.advanceStep(pickEntity);
    } else if (step.kind === 'edge' && pickEdge) {
      this.ctx.doc.selectSolid(pickEdge.solidId);
      await this.advanceStep(pickEdge);
    } else if (this.active.name === 'MOVE' && step.kind === 'entity' && pickSolidId) {
      this.ctx.doc.selectSolid(pickSolidId);
      await this.advanceStep(pickSolidId);
    } else if (this.active.name === 'ERASE' && step.kind === 'entity' && pickSolidId) {
      this.ctx.doc.selectSolid(pickSolidId);
      await this.advanceStep(pickSolidId);
    } else if (step.kind === 'solid' && (pickSolidId || pickFace)) {
      const solidId = pickFace?.solidId ?? pickSolidId!;
      const additive = ['UNION', 'SUBTRACT'].includes(this.active.name);
      this.ctx.doc.selectSolid(solidId, additive);
      await this.advanceStep(this.active.name === 'PRESSPULL' && pickFace ? pickFace : pickSolidId);
    }
  }

  async handlePreview(cursor: Vec2): Promise<void> {
    if (this.active?.preview) this.active.preview(cursor);
  }

  private async processStepInput(input: string, step: CommandStep): Promise<void> {
    switch (step.kind) {
      case 'point': {
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
        if (this.active?.name === 'CIRCLE' && this.active.stepIndex === 1) {
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
      case 'LINE':
        if (this.active.stepIndex === 0) data.start = value;
        else if (this.active.stepIndex === 1) {
          const line = this.ctx.doc.createLine(data.start as Vec2, value as Vec2);
          this.ctx.history.execute(new AddEntityEdit('Line', line));
          this.ctx.log(`Line created: ${formatPoint(data.start as Vec2)} -> ${formatPoint(value as Vec2)}`);
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

      case 'EXTRUDE':
        if (step.kind === 'entity' && value) {
          (data.entities as Entity[]).push(value as Entity);
          this.ctx.log(`Profile added: ${(value as Entity).type} (${(value as Entity).id})`);
          // Allow selecting one profile then height
          this.active.stepIndex = 1;
          this.showCurrentPrompt();
          return;
        } else if (step.kind === 'number') {
          // EXTRUDE is directional along the active UCS positive Z axis. The
          // entered/picked value represents a distance, not a signed offset.
          const height = Math.abs(value as number);
          const entities = data.entities as Entity[];
          if (entities.length === 0) {
            this.ctx.log('No profile selected.');
            break;
          }
          if (height < 1e-9) {
            this.ctx.log('Extrusion height must be greater than zero.');
            this.showCurrentPrompt();
            return;
          }
          this.ctx.log('Extruding…');
          const localMesh = await extrudeProfile(entities, height);
          const plane = entities[0].workPlane ?? WORLD_WORK_PLANE;
          const mesh = localMesh ? {
            ...localMesh,
            positions: transformMeshByWorkPlane(localMesh.positions, plane),
            indices: transformMeshIndicesByWorkPlane(localMesh.indices, plane),
          } : null;
          if (mesh) {
            const solid = this.ctx.doc.createSolid(
              mesh,
              `Extrusion_${entities.map((e) => e.id).join('_')}`,
              height,
              entities.map((e) => e.id),
              undefined,
              {
                kind: 'extrusion',
                profile: cloneEntity(entities[0]),
                height,
                workPlane: plane,
                transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
              }
            );
            this.ctx.history.execute(new ReplaceObjectsEdit('Extrude', entities, [], [], [solid]));
            this.ctx.doc.viewMode = '3d';
            this.ctx.log(`Extrusion complete, height=${height}`);
          } else {
            this.ctx.log('Extrusion failed — select a closed profile.');
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
          if (entity.type !== 'line' && entity.type !== 'arc' && entity.type !== 'bezier') {
            this.ctx.log('JOIN accepts line, arc, and Bezier objects.');
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
          const lines = (data.entities as Entity[]).filter((entity) => entity.type === 'line' || entity.type === 'arc' || entity.type === 'bezier');
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
            : entity.type === 'arc' || entity.type === 'bezier' ? curvePoints(entity, 48) : [];
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
        }
        break;

      case 'EXTEND':
        if (this.active.stepIndex === 0) {
          const boundary = value as Entity;
          if (boundary.type !== 'line') { this.ctx.log('EXTEND boundary must be a line.'); return; }
          data.boundary = boundary;
          this.ctx.doc.selectEntity(boundary.id);
        } else {
          const boundary = data.boundary as Entity;
          const target = value as Entity;
          if (boundary.type !== 'line' || target.type !== 'line' || boundary.id === target.id) {
            this.ctx.log('Select a different line to extend.'); return;
          }
          if (!sameWorkPlane(boundary, target)) { this.ctx.log('Both lines must be on the same work plane.'); return; }
          const hit = lineIntersectionParameters(target.start, target.end, boundary.start, boundary.end);
          if (!hit || hit.u < -1e-8 || hit.u > 1 + 1e-8 || (hit.t >= -1e-8 && hit.t <= 1 + 1e-8)) {
            this.ctx.log('EXTEND failed: the boundary does not intersect an extension of this line.'); return;
          }
          const updated = cloneEntity(target);
          if (updated.type !== 'line') return;
          if (hit.t < 0) updated.start = hit.point;
          else updated.end = hit.point;
          this.ctx.history.execute(new UpdateEntityEdit('Extend', target, updated));
          this.ctx.doc.selectEntity(updated.id);
          this.ctx.log(`Line extended by ${Math.min(dist2(hit.point, target.start), dist2(hit.point, target.end)).toFixed(3)} mm.`);
        }
        break;

      case 'TRIM':
        if (this.active.stepIndex === 0) {
          const boundary = value as Entity;
          if (boundary.type !== 'line') { this.ctx.log('TRIM cutting edge must be a line.'); return; }
          data.boundary = boundary;
          this.ctx.doc.selectEntity(boundary.id);
        } else {
          const boundary = data.boundary as Entity;
          const target = value as Entity;
          if (boundary.type !== 'line' || target.type !== 'line' || boundary.id === target.id) {
            this.ctx.log('Select a different line to trim.'); return;
          }
          if (!sameWorkPlane(boundary, target)) { this.ctx.log('Both lines must be on the same work plane.'); return; }
          const hit = lineIntersectionParameters(target.start, target.end, boundary.start, boundary.end);
          if (!hit || hit.t <= 1e-8 || hit.t >= 1 - 1e-8 || hit.u < -1e-8 || hit.u > 1 + 1e-8) {
            this.ctx.log('TRIM failed: the lines do not cross within their lengths.'); return;
          }
          const click = data.targetPickPoint as Vec2 | undefined;
          const dx = target.end.x - target.start.x;
          const dy = target.end.y - target.start.y;
          const lengthSquared = dx * dx + dy * dy;
          const clickT = click && lengthSquared > 1e-12
            ? ((click.x - target.start.x) * dx + (click.y - target.start.y) * dy) / lengthSquared
            : 1;
          const updated = cloneEntity(target);
          if (updated.type !== 'line') return;
          if (clickT < hit.t) updated.start = hit.point;
          else updated.end = hit.point;
          this.ctx.history.execute(new UpdateEntityEdit('Trim', target, updated));
          this.ctx.doc.selectEntity(updated.id);
          this.ctx.log('Line trimmed at cutting edge.');
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
        if (this.active.stepIndex === 0) data.object = value;
        else if (this.active.stepIndex === 1) {
          data.basePoint = value;
          data.baseWorldPoint = data.pendingMoveWorldPoint;
          delete data.pendingMoveWorldPoint;
        }
        else if (this.active.stepIndex === 2) {
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
          if (worldDelta) this.ctx.moveObject(data.object as Entity | string, delta, worldDelta);
          else this.ctx.moveObject(data.object as Entity | string, delta);
          delete data.pendingMoveWorldPoint;
          this.ctx.log(`Object moved by ${formatPoint(delta)}`);
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
          const rotated = originals.map((entity) => rotateEntity(entity, base, angle, this.ctx.doc));
          this.ctx.history.execute(new ReplaceObjectsEdit('Rotate', originals, [], rotated, []));
          rotated.forEach((entity, index) => this.ctx.doc.selectEntity(entity.id, index > 0));
          this.ctx.log(`Rotated ${rotated.length} object(s) by ${(angle * 180 / Math.PI).toFixed(3)}°.`);
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

      case 'MEASURE':
        if (this.active.stepIndex === 0) data.start = value;
        else {
          const start = data.start as Vec2 | Vec3;
          const end = value as Vec2 | Vec3;
          const a: Vec3 = { x: start.x, y: start.y, z: 'z' in start ? start.z : 0 };
          const b: Vec3 = { x: end.x, y: end.y, z: 'z' in end ? end.z : 0 };
          this.ctx.log(`Distance: ${dist3(a, b).toFixed(3)} mm (${formatPoint(a)} -> ${formatPoint(b)})`);
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

      case 'ERASE':
        if (value && typeof value === 'object' && 'type' in (value as Entity)) {
          const e = value as Entity;
          this.ctx.history.execute(new RemoveEntityEdit('Delete object', e));
          this.ctx.log(`Deleted: ${e.type} ${e.id}`);
        }
        else if (typeof value === 'string') {
          const solid = this.ctx.doc.getSolid(value);
          if (solid) this.ctx.history.execute(new RemoveSolidEdit('Delete solid', solid));
          this.ctx.log(`Deleted solid: ${value}`);
        }
        break;
    }

    this.active.stepIndex++;
    while (this.active && this.active.steps[this.active.stepIndex]?.kind === 'done') {
      if (['LINE','CIRCLE','RECTANGLE','POLYGON','ARC','BEZIER','TEXT','MEASURE'].includes(this.active.name)) {
        // Drawing tools stay active until Escape or another command is chosen.
        this.active.stepIndex = 0;
        this.active.data = {};
      } else {
        this.active = null;
      }
      break;
    }

    if (this.active) {
      this.showCurrentPrompt();
    } else {
      this.ctx.prompt('Enter command:');
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

export function hitTestEntity(entities: Entity[], point: Vec2, tolerance = 0.5): Entity | null {
  for (let i = entities.length - 1; i >= 0; i--) {
    const e = entities[i];
    switch (e.type) {
      case 'line': {
        const dx = e.end.x - e.start.x;
        const dy = e.end.y - e.start.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-12) continue;
        const t = Math.max(0, Math.min(1, ((point.x - e.start.x) * dx + (point.y - e.start.y) * dy) / len2));
        const px = e.start.x + t * dx;
        const py = e.start.y + t * dy;
        const d = Math.sqrt((point.x - px) ** 2 + (point.y - py) ** 2);
        if (d <= tolerance) return e;
        break;
      }
      case 'circle': {
        const d = Math.sqrt((point.x - e.center.x) ** 2 + (point.y - e.center.y) ** 2);
        if (Math.abs(d - e.radius) <= tolerance || d <= e.radius) return e;
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
        const pts = getEntityPoints(e);
        for (const p of pts) {
          if (Math.sqrt((point.x - p.x) ** 2 + (point.y - p.y) ** 2) <= tolerance * 2) return e;
        }
        break;
      }
      case 'arc':
      case 'bezier': { const pts=curvePoints(e); for(let j=1;j<pts.length;j++){const a=pts[j-1],b=pts[j],dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy;const t=Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/(l||1)));if(Math.hypot(point.x-(a.x+t*dx),point.y-(a.y+t*dy))<=tolerance)return e;} break; }
      case 'text': { const b=entityBounds(e); if(point.x>=b.min.x-tolerance&&point.x<=b.max.x+tolerance&&point.y>=b.min.y-tolerance&&point.y<=b.max.y+tolerance)return e; break; }
    }
  }
  return null;
}
