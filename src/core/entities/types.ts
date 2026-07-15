import type { Vec2, Vec3 } from '../../math/geometry';
import type { WorkPlane } from '../../math/workplane';

export type EntityType = 'line' | 'circle' | 'rectangle' | 'octagon' | 'polyline' | 'arc' | 'bezier' | 'text';

export interface EntityBase {
  id: string;
  type: EntityType;
  layer: string;
  color: number;
  selected: boolean;
  workPlane?: WorkPlane;
}

export interface LineEntity extends EntityBase {
  type: 'line';
  start: Vec2;
  end: Vec2;
}

export interface CircleEntity extends EntityBase {
  type: 'circle';
  center: Vec2;
  radius: number;
}

export interface RectangleEntity extends EntityBase {
  type: 'rectangle';
  first: Vec2;
  opposite: Vec2;
}

export interface OctagonEntity extends EntityBase {
  type: 'octagon';
  center: Vec2;
  radius: number;
  vertices: Vec2[];
}

export interface PolylineEntity extends EntityBase {
  type: 'polyline';
  vertices: Vec2[];
  closed: boolean;
}
export interface ArcEntity extends EntityBase { type: 'arc'; center: Vec2; radius: number; startAngle: number; sweepAngle: number; }
export interface BezierEntity extends EntityBase { type: 'bezier'; start: Vec2; control1: Vec2; control2: Vec2; end: Vec2; }
export interface TextEntity extends EntityBase { type: 'text'; position: Vec2; text: string; height: number; font?: string; rotation?: number; }

export type Entity = LineEntity | CircleEntity | RectangleEntity | OctagonEntity | PolylineEntity | ArcEntity | BezierEntity | TextEntity;

export function curvePoints(e: ArcEntity | BezierEntity, segments = 64): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    if (e.type === 'arc') {
      const a = e.startAngle + e.sweepAngle * t;
      points.push({ x: e.center.x + Math.cos(a) * e.radius, y: e.center.y + Math.sin(a) * e.radius });
    } else {
      const u = 1 - t;
      points.push({ x: u ** 3 * e.start.x + 3 * u ** 2 * t * e.control1.x + 3 * u * t ** 2 * e.control2.x + t ** 3 * e.end.x, y: u ** 3 * e.start.y + 3 * u ** 2 * t * e.control1.y + 3 * u * t ** 2 * e.control2.y + t ** 3 * e.end.y });
    }
  }
  return points;
}

export interface SolidMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface SolidFaceSelection {
  solidId: string;
  vertexIndices: number[];
  normal: Vec3;
}

export interface SolidEdgeSelection {
  solidId: string;
  start: Vec3;
  end: Vec3;
  normalA: Vec3;
  normalB: Vec3;
}

export interface ExtrusionFeature {
  kind: 'extrusion';
  profile: Entity;
  height: number;
  workPlane?: WorkPlane;
  transform: {
    translateX: number;
    translateY: number;
    scaleX: number;
    scaleY: number;
    translateZ?: number;
  };
}

export interface BooleanFeature {
  kind: 'boolean';
  operation: 'union' | 'subtract';
  operands: SolidFeature[];
}

export interface MeshFeature {
  kind: 'mesh';
}

export type SolidFeature = ExtrusionFeature | BooleanFeature | MeshFeature;

export interface Solid {
  id: string;
  name: string;
  layer: string;
  mesh: SolidMesh;
  color: number;
  selected: boolean;
  height: number;
  sourceEntityIds: string[];
  feature: SolidFeature;
  revision: number;
}

let nextId = 1;
export function genId(prefix = 'e'): string {
  return `${prefix}_${nextId++}`;
}

export function resetIdCounter(): void {
  nextId = 1;
}

export function cloneEntity(e: Entity): Entity {
  return JSON.parse(JSON.stringify(e));
}

export function entityBounds(e: Entity): { min: Vec2; max: Vec2 } {
  switch (e.type) {
    case 'line':
      return {
        min: { x: Math.min(e.start.x, e.end.x), y: Math.min(e.start.y, e.end.y) },
        max: { x: Math.max(e.start.x, e.end.x), y: Math.max(e.start.y, e.end.y) },
      };
    case 'circle':
      return {
        min: { x: e.center.x - e.radius, y: e.center.y - e.radius },
        max: { x: e.center.x + e.radius, y: e.center.y + e.radius },
      };
    case 'rectangle':
      return {
        min: { x: Math.min(e.first.x, e.opposite.x), y: Math.min(e.first.y, e.opposite.y) },
        max: { x: Math.max(e.first.x, e.opposite.x), y: Math.max(e.first.y, e.opposite.y) },
      };
    case 'octagon': {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const v of e.vertices) {
        minX = Math.min(minX, v.x);
        minY = Math.min(minY, v.y);
        maxX = Math.max(maxX, v.x);
        maxY = Math.max(maxY, v.y);
      }
      return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
    }
    case 'polyline': {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const v of e.vertices) {
        minX = Math.min(minX, v.x);
        minY = Math.min(minY, v.y);
        maxX = Math.max(maxX, v.x);
        maxY = Math.max(maxY, v.y);
      }
      return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
    }
    case 'arc':
    case 'bezier': { const p = curvePoints(e); return { min: { x: Math.min(...p.map(v => v.x)), y: Math.min(...p.map(v => v.y)) }, max: { x: Math.max(...p.map(v => v.x)), y: Math.max(...p.map(v => v.y)) } }; }
    case 'text': {
      const width = e.text.length * e.height * .62;
      const angle = e.rotation ?? 0;
      const rotate = (point: Vec2): Vec2 => ({
        x: e.position.x + point.x * Math.cos(angle) - point.y * Math.sin(angle),
        y: e.position.y + point.x * Math.sin(angle) + point.y * Math.cos(angle),
      });
      const points = [rotate({ x: 0, y: 0 }), rotate({ x: width, y: 0 }), rotate({ x: width, y: e.height }), rotate({ x: 0, y: e.height })];
      return {
        min: { x: Math.min(...points.map((point) => point.x)), y: Math.min(...points.map((point) => point.y)) },
        max: { x: Math.max(...points.map((point) => point.x)), y: Math.max(...points.map((point) => point.y)) },
      };
    }
  }
}

export function getEntityPoints(e: Entity): Vec2[] {
  switch (e.type) {
    case 'line':
      return [e.start, e.end];
    case 'circle':
      return [e.center];
    case 'rectangle':
      return [
        e.first,
        { x: e.opposite.x, y: e.first.y },
        e.opposite,
        { x: e.first.x, y: e.opposite.y },
      ];
    case 'octagon':
      return e.vertices;
    case 'polyline':
      return e.vertices;
    case 'arc': return [e.center, ...curvePoints(e, 2)];
    case 'bezier': return [e.start, e.control1, e.control2, e.end];
    case 'text': return [e.position];
  }
}

export function transformEntityPoints(e: Entity, fn: (p: Vec2) => Vec2): Entity {
  const copy = cloneEntity(e);
  switch (copy.type) {
    case 'line':
      copy.start = fn(copy.start);
      copy.end = fn(copy.end);
      break;
    case 'circle':
      copy.center = fn(copy.center);
      break;
    case 'rectangle':
      copy.first = fn(copy.first);
      copy.opposite = fn(copy.opposite);
      break;
    case 'octagon':
      copy.center = fn(copy.center);
      copy.vertices = copy.vertices.map(fn);
      break;
    case 'polyline':
      copy.vertices = copy.vertices.map(fn);
      break;
    case 'arc': copy.center = fn(copy.center); break;
    case 'bezier': copy.start = fn(copy.start); copy.control1 = fn(copy.control1); copy.control2 = fn(copy.control2); copy.end = fn(copy.end); break;
    case 'text': copy.position = fn(copy.position); break;
  }
  return copy;
}
