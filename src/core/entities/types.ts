import type { Vec2, Vec3 } from '../../math/geometry';
import type { WorkPlane } from '../../math/workplane';

export type EntityType = 'line' | 'circle' | 'rectangle' | 'octagon' | 'polyline';

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

export type Entity = LineEntity | CircleEntity | RectangleEntity | OctagonEntity | PolylineEntity;

export interface SolidMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface SolidFaceSelection {
  solidId: string;
  vertexIndices: number[];
  normal: Vec3;
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
  }
  return copy;
}
