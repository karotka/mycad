import { Document } from '../core/Document';
import { entityBounds, isSweepProfileEntity, type Entity, type PrimitiveFeature, type Solid, type SolidFeature, type SolidMesh } from '../core/entities/types';
import { CommandHistory } from '../core/history/CommandHistory';
import { AddEntitiesEdit, cloneSolid, ReplaceObjectsEdit, UpdateSolidEdit } from '../core/history/edits';
import { featureRemovalForPoint } from '../core/solids/featureRemoval';
import { extrusionFeature } from '../core/solids/extrusion';
import { booleanExactSolids, buildExactFeature } from '../core/geometry/ExactSolid';
import { exportAsciiStl } from '../io/ProjectIO';
import type { Vec3 } from '../math/geometry';
import { cloneWorkPlane, localToWorld, workPlaneFromXAxis } from '../math/workplane';

export type McpPrimitive = PrimitiveFeature['primitive'];
export type SelectionMode = 'replace' | 'add' | 'remove';

export interface PrimitiveInput {
  primitive: McpPrimitive;
  center: { x: number; y: number; z?: number };
  name?: string;
  width?: number;
  depth?: number;
  height?: number;
  radius?: number;
  radiusTop?: number;
  tubeRadius?: number;
}

export interface LineSegmentInput {
  start: { x: number; y: number; z?: number };
  end: { x: number; y: number; z?: number };
}

export interface ExtrudeInput {
  /** Extrude an existing closed profile entity by ID. */
  profileId?: string;
  /** Or build a closed outline in the active UCS from these vertices, then extrude it. */
  points?: Array<{ x: number; y: number; z?: number }>;
  /** Signed distance in mm along the active UCS Z axis; negative extrudes downward. */
  height: number;
  name?: string;
}

export interface DocumentSummary {
  projectPath: string | null;
  units: 'mm';
  viewMode: '2d' | '3d';
  currentLayer: string;
  entityCount: number;
  solidCount: number;
  selectedEntityIds: string[];
  selectedSolidIds: string[];
  activeUcs: {
    name: string;
    origin: Vec3;
    xAxis: Vec3;
    yAxis: Vec3;
    zAxis: Vec3;
  };
  canUndo: boolean;
  canRedo: boolean;
}

export interface StlExport {
  content: string;
  solidIds: string[];
}

const finite = (value: number | undefined, label: string): number => {
  if (value === undefined || !Number.isFinite(value)) throw new Error(`${label} is required and must be finite.`);
  return value;
};

const positive = (value: number | undefined, label: string): number => {
  const result = finite(value, label);
  if (result <= 0) throw new Error(`${label} must be greater than zero.`);
  return result;
};

const cloneFeature = (feature: SolidFeature): SolidFeature => JSON.parse(JSON.stringify(feature)) as SolidFeature;

function meshBounds(mesh: SolidMesh): { min: Vec3; max: Vec3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let index = 0; index < mesh.positions.length; index += 3) {
    min.x = Math.min(min.x, mesh.positions[index]);
    min.y = Math.min(min.y, mesh.positions[index + 1]);
    min.z = Math.min(min.z, mesh.positions[index + 2]);
    max.x = Math.max(max.x, mesh.positions[index]);
    max.y = Math.max(max.y, mesh.positions[index + 1]);
    max.z = Math.max(max.z, mesh.positions[index + 2]);
  }
  return { min, max };
}

const meshHeight = (mesh: SolidMesh): number => {
  const bounds = meshBounds(mesh);
  return Math.max(0, bounds.max.z - bounds.min.z);
};

function entitySummary(entity: Entity): Record<string, unknown> {
  return {
    kind: 'entity',
    id: entity.id,
    type: entity.type,
    layer: entity.layer,
    selected: entity.selected,
    bounds: entityBounds(entity),
  };
}

function solidSummary(solid: Solid): Record<string, unknown> {
  return {
    kind: 'solid',
    id: solid.id,
    name: solid.name,
    layer: solid.layer,
    selected: solid.selected,
    featureKind: solid.feature.kind,
    bounds: meshBounds(solid.mesh),
    vertices: solid.mesh.positions.length / 3,
    triangles: solid.mesh.indices.length / 3,
    revision: solid.revision,
  };
}

/**
 * Browser-safe modelling surface shared by the open Electron document and the
 * headless MCP session. Every mutation uses the application's normal history.
 */
export class CadModelApi {
  constructor(
    protected documentValue: Document,
    protected historyValue: CommandHistory,
    private readonly projectPathProvider: () => string | null = () => null,
  ) {}

  get document(): Document { return this.documentValue; }
  get history(): CommandHistory { return this.historyValue; }

  protected projectPath(): string | null { return this.projectPathProvider(); }

  protected replaceDocument(document: Document): void {
    this.documentValue = document;
    this.historyValue = new CommandHistory(document);
  }

  summary(): DocumentSummary {
    const doc = this.documentValue;
    const named = doc.namedWorkPlanes.find((plane) => plane.id === doc.activeNamedWorkPlaneId);
    return {
      projectPath: this.projectPath(),
      units: 'mm',
      viewMode: doc.viewMode,
      currentLayer: doc.currentLayer,
      entityCount: doc.entities.length,
      solidCount: doc.solids.length,
      selectedEntityIds: [...doc.selectedEntityIds],
      selectedSolidIds: [...doc.selectedSolidIds],
      activeUcs: {
        name: named?.name ?? 'WCS',
        origin: { ...doc.activeWorkPlane.origin },
        xAxis: { ...doc.activeWorkPlane.xAxis },
        yAxis: { ...doc.activeWorkPlane.yAxis },
        zAxis: { ...doc.activeWorkPlane.zAxis },
      },
      canUndo: this.historyValue.canUndo,
      canRedo: this.historyValue.canRedo,
    };
  }

  listObjects(selectedOnly = false): Array<Record<string, unknown>> {
    const doc = this.documentValue;
    const entities = selectedOnly ? doc.getSelectedEntities() : doc.entities;
    const solids = selectedOnly ? doc.getSelectedSolids() : doc.solids;
    return [...entities.map(entitySummary), ...solids.map(solidSummary)];
  }

  getObject(id: string): Record<string, unknown> {
    const entity = this.documentValue.getEntity(id);
    if (entity) return { ...entitySummary(entity), entity };
    const solid = this.documentValue.getSolid(id);
    if (solid) return { ...solidSummary(solid), feature: cloneFeature(solid.feature), sourceEntityIds: [...solid.sourceEntityIds] };
    throw new Error(`Object ${id} does not exist.`);
  }

  selectObjects(ids: readonly string[], mode: SelectionMode = 'replace'): DocumentSummary {
    const doc = this.documentValue;
    const known = new Set([...doc.entities.map((entity) => entity.id), ...doc.solids.map((solid) => solid.id)]);
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length > 0) throw new Error(`Unknown object ID(s): ${missing.join(', ')}.`);
    doc.transaction(() => {
      if (mode === 'replace') {
        doc.selectedEntityIds.clear();
        doc.selectedSolidIds.clear();
      }
      for (const id of ids) {
        const target = doc.getEntity(id) ? doc.selectedEntityIds : doc.selectedSolidIds;
        if (mode === 'remove') target.delete(id);
        else target.add(id);
      }
      doc.pruneSelection();
      doc.notify();
    });
    return this.summary();
  }

  async createPrimitive(input: PrimitiveInput): Promise<Record<string, unknown>> {
    const centerX = finite(input.center.x, 'center.x');
    const centerY = finite(input.center.y, 'center.y');
    const z = input.center.z === undefined ? 0 : finite(input.center.z, 'center.z');
    const plane = cloneWorkPlane(this.documentValue.activeWorkPlane);
    plane.origin = {
      x: plane.origin.x + plane.zAxis.x * z,
      y: plane.origin.y + plane.zAxis.y * z,
      z: plane.origin.z + plane.zAxis.z * z,
    };
    const feature: PrimitiveFeature = {
      kind: 'primitive',
      primitive: input.primitive,
      center: { x: centerX, y: centerY },
      height: 0,
      workPlane: plane,
    };
    if (input.primitive === 'box' || input.primitive === 'wedge') {
      feature.width = positive(input.width, 'width');
      feature.depth = positive(input.depth, 'depth');
      feature.height = positive(input.height, 'height');
    } else if (input.primitive === 'sphere') {
      feature.radius = positive(input.radius, 'radius');
      feature.height = feature.radius * 2;
    } else if (input.primitive === 'torus') {
      feature.radius = positive(input.radius, 'radius');
      feature.tubeRadius = positive(input.tubeRadius, 'tubeRadius');
      if (feature.tubeRadius >= feature.radius) throw new Error('tubeRadius must be smaller than radius.');
      feature.height = feature.tubeRadius * 2;
    } else {
      feature.radius = positive(input.radius, 'radius');
      feature.height = positive(input.height, 'height');
      if (input.primitive === 'cone' && input.radiusTop !== undefined) {
        feature.radiusTop = finite(input.radiusTop, 'radiusTop');
        if (feature.radiusTop < 0) throw new Error('radiusTop must be zero or greater.');
      }
    }
    const defaultName = input.primitive[0].toUpperCase() + input.primitive.slice(1);
    const geometry = await buildExactFeature(feature);
    if (!geometry) throw new Error(`OpenCascade cannot build the ${input.primitive} primitive.`);
    const solid = this.documentValue.createSolid(
      geometry.mesh,
      input.name?.trim() || defaultName,
      feature.height,
      [],
      undefined,
      feature,
    );
    solid.exact = geometry.exact;
    this.historyValue.execute(new ReplaceObjectsEdit(`MCP create ${defaultName}`, [], [], [], [solid]));
    this.documentValue.viewMode = '3d';
    this.selectObjects([solid.id]);
    return solidSummary(this.documentValue.getSolid(solid.id)!);
  }

  createLines(segments: readonly LineSegmentInput[]): Array<Record<string, unknown>> {
    if (segments.length === 0) throw new Error('At least one line segment is required.');
    const activePlane = this.documentValue.activeWorkPlane;
    const lines = segments.map((segment, index) => {
      const start = localToWorld(activePlane, {
        x: finite(segment.start.x, `segments[${index}].start.x`),
        y: finite(segment.start.y, `segments[${index}].start.y`),
      }, segment.start.z === undefined ? 0 : finite(segment.start.z, `segments[${index}].start.z`));
      const end = localToWorld(activePlane, {
        x: finite(segment.end.x, `segments[${index}].end.x`),
        y: finite(segment.end.y, `segments[${index}].end.y`),
      }, segment.end.z === undefined ? 0 : finite(segment.end.z, `segments[${index}].end.z`));
      const direction = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
      const length = Math.hypot(direction.x, direction.y, direction.z);
      if (length < 1e-9) throw new Error(`segments[${index}] has identical endpoints.`);
      const reference = Math.abs(direction.z / length) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
      const normal = {
        x: direction.y * reference.z - direction.z * reference.y,
        y: direction.z * reference.x - direction.x * reference.z,
        z: direction.x * reference.y - direction.y * reference.x,
      };
      const line = this.documentValue.createLine({ x: 0, y: 0 }, { x: length, y: 0 });
      line.workPlane = workPlaneFromXAxis(start, end, normal);
      return line;
    });
    this.historyValue.execute(new AddEntitiesEdit(`MCP create ${lines.length} line(s)`, lines));
    this.selectObjects(lines.map((line) => line.id));
    this.documentValue.viewMode = '3d';
    this.documentValue.notify();
    return lines.map((line) => entitySummary(this.documentValue.getEntity(line.id)!));
  }

  /**
   * Extrude a closed profile into a solid along the active UCS Z axis. The profile
   * is either an existing closed entity (consumed by the extrusion, as in the
   * EXTRUDE command) or an outline built here from points in the active UCS. Points
   * may carry a z, so an outline traced at a height extrudes from that height.
   */
  async extrude(input: ExtrudeInput): Promise<Record<string, unknown>> {
    const height = finite(input.height, 'height');
    if (Math.abs(height) < 1e-9) throw new Error('height must be non-zero.');
    const hasProfile = typeof input.profileId === 'string' && input.profileId.length > 0;
    const hasPoints = Array.isArray(input.points) && input.points.length > 0;
    if (hasProfile === hasPoints) throw new Error('Provide either profileId or points, but not both.');

    let profile: Entity;
    let consumed: Entity[] = [];
    if (hasProfile) {
      const entity = this.documentValue.getEntity(input.profileId!);
      if (!entity) throw new Error(`Entity ${input.profileId} does not exist.`);
      if (!isSweepProfileEntity(entity)) {
        throw new Error('The profile must be a closed circle, rectangle, octagon or closed polyline.');
      }
      profile = entity;
      consumed = [entity]; // replaced by the new solid, as the EXTRUDE command does
    } else {
      const points = input.points!;
      if (points.length < 3) throw new Error('At least three points are needed to form a closed outline.');
      const vertices = points.map((point, index) => ({
        x: finite(point.x, `points[${index}].x`),
        y: finite(point.y, `points[${index}].y`),
        ...(point.z === undefined ? {} : { z: finite(point.z, `points[${index}].z`) }),
      }));
      // Built in the active UCS but not added to the document — the extrusion is the
      // object the caller wanted, so only the solid is committed to history.
      profile = this.documentValue.createPolyline(vertices, true);
    }

    const feature = extrusionFeature(profile, height);
    const geometry = await buildExactFeature(feature);
    if (!geometry) {
      throw new Error('OpenCascade could not extrude this profile — check that the outline is closed and does not self-intersect.');
    }
    const solid = this.documentValue.createSolid(
      geometry.mesh,
      input.name?.trim() || 'Extrusion',
      feature.height,
      [profile.id],
      undefined,
      feature,
    );
    solid.exact = geometry.exact;
    this.historyValue.execute(new ReplaceObjectsEdit('MCP extrude', consumed, [], [], [solid]));
    this.documentValue.viewMode = '3d';
    this.selectObjects([solid.id]);
    return solidSummary(this.documentValue.getSolid(solid.id)!);
  }

  async booleanOperation(operation: 'union' | 'subtract' | 'intersect', solidIds: readonly string[], name?: string): Promise<Record<string, unknown>> {
    const ids = [...new Set(solidIds)];
    if (ids.length < 2) throw new Error(`${operation} requires at least two solid IDs.`);
    const solids = ids.map((id) => this.documentValue.getSolid(id));
    const missing = ids.filter((_, index) => !solids[index]);
    if (missing.length > 0) throw new Error(`Unknown solid ID(s): ${missing.join(', ')}.`);
    const sources = solids as Solid[];
    let feature: SolidFeature;
    if (operation === 'union') {
      feature = { kind: 'boolean', operation: 'union', operands: sources.map((solid) => cloneFeature(solid.feature)) };
    } else if (operation === 'intersect') {
      feature = { kind: 'boolean', operation: 'intersect', operands: sources.map((solid) => cloneFeature(solid.feature)) };
    } else {
      feature = cloneFeature(sources[0].feature);
      for (const cutter of sources.slice(1)) {
        feature = { kind: 'boolean', operation: 'subtract', operands: [feature, cloneFeature(cutter.feature)] };
      }
    }
    const exact = await booleanExactSolids(operation, sources);
    if (!exact || exact.mesh.indices.length === 0) throw new Error(`${operation} did not produce a valid exact solid — it failed or was cancelled after running too long. If a body is a sliced mesh remnant, rebuild it as a clean parametric solid first.`);
    const result = this.documentValue.createSolid(
      exact.mesh,
      name?.trim() || (operation === 'union' ? 'Union' : operation === 'subtract' ? 'Subtract' : 'Intersect'),
      meshHeight(exact.mesh),
      [],
      undefined,
      feature,
    );
    result.exact = exact.exact;
    this.historyValue.execute(new ReplaceObjectsEdit(`MCP ${operation}`, [], sources, [], [result]));
    this.selectObjects([result.id]);
    return solidSummary(this.documentValue.getSolid(result.id)!);
  }

  async deleteFeature(solidId: string, point: Vec3, normal: Vec3): Promise<Record<string, unknown>> {
    const solid = this.documentValue.getSolid(solidId);
    if (!solid) throw new Error(`Solid ${solidId} does not exist.`);
    const removal = await featureRemovalForPoint(solid, point, normal);
    if (!removal) throw new Error('No removable feature matches that oriented surface point.');
    const before = cloneSolid(solid);
    const after = cloneSolid(solid);
    after.feature = removal.feature;
    after.mesh = removal.mesh;
    after.height = meshHeight(removal.mesh);
    after.revision++;
    this.historyValue.execute(new UpdateSolidEdit('MCP delete feature', before, after));
    this.selectObjects([after.id]);
    return solidSummary(this.documentValue.getSolid(after.id)!);
  }

  deleteObjects(ids: readonly string[]): DocumentSummary {
    const unique = [...new Set(ids)];
    const entities = unique.map((id) => this.documentValue.getEntity(id)).filter((value): value is Entity => Boolean(value));
    const solids = unique.map((id) => this.documentValue.getSolid(id)).filter((value): value is Solid => Boolean(value));
    if (entities.length + solids.length !== unique.length) {
      const found = new Set([...entities.map((entity) => entity.id), ...solids.map((solid) => solid.id)]);
      throw new Error(`Unknown object ID(s): ${unique.filter((id) => !found.has(id)).join(', ')}.`);
    }
    if (unique.length === 0) throw new Error('At least one object ID is required.');
    this.historyValue.execute(new ReplaceObjectsEdit('MCP delete objects', entities, solids, [], []));
    return this.summary();
  }

  undo(): DocumentSummary {
    if (!this.historyValue.undo()) throw new Error('There is nothing to undo.');
    return this.summary();
  }

  redo(): DocumentSummary {
    if (!this.historyValue.redo()) throw new Error('There is nothing to redo.');
    return this.summary();
  }

  exportStlContent(solidIds?: readonly string[]): StlExport {
    const ids = solidIds && solidIds.length > 0 ? [...new Set(solidIds)] : [...this.documentValue.selectedSolidIds];
    if (ids.length === 0) throw new Error('Select solids or pass solidIds before exporting STL.');
    const solids = ids.map((id) => this.documentValue.getSolid(id));
    const missing = ids.filter((_, index) => !solids[index]);
    if (missing.length > 0) throw new Error(`Unknown solid ID(s): ${missing.join(', ')}.`);
    return { content: exportAsciiStl(solids as Solid[]), solidIds: ids };
  }
}
