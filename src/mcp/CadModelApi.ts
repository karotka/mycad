import { Document } from '../core/Document';
import { cloneEntity, entityBounds, isSweepProfileEntity, type Entity, type PrimitiveFeature, type Solid, type SolidEdgeSelection, type SolidFeature, type SolidMesh } from '../core/entities/types';
import { CommandHistory } from '../core/history/CommandHistory';
import { AddEntitiesEdit, cloneSolid, ReplaceObjectsEdit, UpdateSolidEdit } from '../core/history/edits';
import { featureRemovalForPoint } from '../core/solids/featureRemoval';
import { extrusionFeature } from '../core/solids/extrusion';
import { translatedFeature } from '../core/solids/featureTransform';
import { solidPlanarFaces, solidCircularEdges, planarFaceRegionAt, type PlanarFace } from '../core/solids/SolidTopology';
import { rotateSolidAroundPlane, scaleSolid } from '../core/commands/steps/transform';
import { booleanExactSolids, buildExactFeature, exactResult, modifyExactSolidEdge, openExactShape, pressPullExactSolid, promoteSolidToExact } from '../core/geometry/ExactSolid';
import { openCascadeKernel } from '../core/geometry/OpenCascadeRuntime';
import { preserveExactTransform, translationAffine } from '../core/geometry/ExactTransform';
import { exportAsciiStl } from '../io/ProjectIO';
import type { Vec3 } from '../math/geometry';
import { cloneWorkPlane, localToWorld, WORLD_WORK_PLANE, workPlaneFromXAxis, workPlaneFromXYAxes, worldToLocal, type WorkPlane } from '../math/workplane';

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

export interface TransformInput {
  ids: string[];
  /** World-space translation. */
  translate?: { x: number; y: number; z: number };
  /** Rotation in degrees about `axis` (default world Z) through `center` (default each solid's own centre). */
  rotate?: { angle: number; axis?: Vec3; center?: Vec3 };
  /** Uniform scale about `center` (default each solid's own centre). */
  scale?: { factor: number; center?: Vec3 };
}

export interface PressPullInput {
  solidId: string;
  /** World point on the planar face to push or pull. */
  point: Vec3;
  /** Outward world normal of that face. */
  normal: Vec3;
  /** Signed distance in mm; positive pulls out along the normal, negative pushes in. */
  distance: number;
}

export interface EdgeModifyInput {
  solidId: string;
  /** The two world-space endpoints of the edge to fillet/chamfer. */
  edgeStart: Vec3;
  edgeEnd: Vec3;
  /** Fillet radius, or chamfer setback. */
  amount: number;
  /** Chamfer's second setback (defaults to `amount`). Ignored for fillet. */
  amount2?: number;
}

export interface SliceInput {
  solidId: string;
  /** A world point on the cutting plane. */
  planeOrigin: Vec3;
  /** The cutting plane's world normal. */
  planeNormal: Vec3;
}

export interface UcsInput {
  origin: Vec3;
  /** A point on the positive X axis. */
  xPoint: Vec3;
  /** A point on the positive Y side (defines the plane). */
  yPoint: Vec3;
  name?: string;
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

  /**
   * A read of a solid's real geometry — planar faces (each as a world-space
   * outline plus any holes) and circular edges (hole and rim centres/radii). This
   * is what lets an agent measure a part without exporting STL and parsing it.
   */
  describeSolid(id: string): Record<string, unknown> {
    const solid = this.documentValue.getSolid(id);
    if (!solid) throw new Error(`Solid ${id} does not exist.`);
    const faces = solidPlanarFaces(solid.mesh).map((face) => ({
      normal: { ...face.normal },
      origin: { ...face.plane.origin },
      area: faceArea(face),
      outline: (face.loops[0] ?? []).map((point) => localToWorld(face.plane, point, 0)),
      holes: face.loops.slice(1).map((loop) => loop.map((point) => localToWorld(face.plane, point, 0))),
    }));
    const circularEdges = solidCircularEdges(solid.mesh).map((edge) => ({
      center: { ...edge.center }, normal: { ...edge.normal }, radius: edge.radius,
    }));
    return { ...solidSummary(solid), faces, circularEdges };
  }

  /** Move, rotate and/or scale solids in place as one undoable edit, keeping their recipe. */
  transformSolids(input: TransformInput): Array<Record<string, unknown>> {
    const ids = [...new Set(input.ids)];
    if (ids.length === 0) throw new Error('At least one solid ID is required.');
    if (!input.translate && !input.rotate && !input.scale) throw new Error('Provide translate, rotate and/or scale.');
    const before = ids.map((id) => {
      const solid = this.documentValue.getSolid(id);
      if (!solid) throw new Error(`Unknown solid ID: ${id}.`);
      return solid;
    });
    const after = before.map((solid) => {
      const result = transformSolidInPlace(solid, input);
      result.id = solid.id;
      result.name = solid.name;
      result.selected = true;
      return result;
    });
    this.historyValue.execute(new ReplaceObjectsEdit('MCP transform', [], before, [], after));
    this.selectObjects(after.map((solid) => solid.id));
    return after.map((solid) => solidSummary(this.documentValue.getSolid(solid.id)!));
  }

  /**
   * Push or pull a planar face along its normal (AutoCAD's PRESSPULL). Runs OCCT
   * on the calling thread, unlike boolean_solids — a pathological solid could make
   * it slow; rebuild the messy body first if so.
   */
  async pressPull(input: PressPullInput): Promise<Record<string, unknown>> {
    const solid = this.documentValue.getSolid(input.solidId);
    if (!solid) throw new Error(`Solid ${input.solidId} does not exist.`);
    if (!Number.isFinite(input.distance) || Math.abs(input.distance) < 1e-6) throw new Error('distance must be non-zero.');
    const region = this.faceRegionAt(solid, input.point, input.normal);
    if (!region) throw new Error('No bounded planar face found at that point with that normal.');
    const before = cloneSolid(solid);
    const exact = await pressPullExactSolid(solid, region, input.distance, solid.revision + 1);
    if (!exact) throw new Error('PressPull failed — try a smaller distance or a different face.');
    const after = cloneSolid(before);
    after.feature = {
      kind: 'presspull-region',
      source: cloneFeature(before.feature),
      region: JSON.parse(JSON.stringify(region)),
      distance: input.distance,
      sourceMesh: { positions: Array.from(before.mesh.positions), indices: Array.from(before.mesh.indices) },
    };
    after.mesh = exact.mesh;
    after.exact = exact.exact;
    after.height = meshHeight(exact.mesh);
    after.revision = solid.revision + 1;
    this.historyValue.execute(new UpdateSolidEdit('MCP press/pull', before, after));
    this.selectObjects([after.id]);
    return solidSummary(this.documentValue.getSolid(after.id)!);
  }

  /** Round (fillet) or bevel (chamfer) the edge whose two endpoints are given. */
  async modifyEdge(input: EdgeModifyInput, rounded: boolean): Promise<Record<string, unknown>> {
    const solid = this.documentValue.getSolid(input.solidId);
    if (!solid) throw new Error(`Solid ${input.solidId} does not exist.`);
    if (!(input.amount > 0)) throw new Error('amount must be greater than zero.');
    const edge: SolidEdgeSelection = {
      solidId: solid.id,
      start: input.edgeStart,
      end: input.edgeEnd,
      normalA: { x: 0, y: 0, z: 0 },
      normalB: { x: 0, y: 0, z: 0 },
    };
    const before = cloneSolid(solid);
    const exact = await modifyExactSolidEdge(solid, edge, input.amount, rounded, input.amount2 ?? input.amount, solid.revision + 1);
    if (!exact) throw new Error(`${rounded ? 'Fillet' : 'Chamfer'} failed — no edge was found between those endpoints, or the amount is too large.`);
    const after = cloneSolid(before);
    after.feature = {
      kind: 'edge-modification',
      source: cloneFeature(before.feature),
      edge: JSON.parse(JSON.stringify(edge)),
      operation: rounded ? 'fillet' : 'chamfer',
      amount: input.amount,
      ...(rounded ? {} : { amount2: input.amount2 ?? input.amount }),
      sourceMesh: { positions: Array.from(before.mesh.positions), indices: Array.from(before.mesh.indices) },
    };
    after.mesh = exact.mesh;
    after.exact = exact.exact;
    after.height = meshHeight(exact.mesh);
    after.revision = solid.revision + 1;
    this.historyValue.execute(new UpdateSolidEdit(`MCP ${rounded ? 'fillet' : 'chamfer'}`, before, after));
    this.selectObjects([after.id]);
    return solidSummary(this.documentValue.getSolid(after.id)!);
  }

  /** Cut a solid with a plane into its closed pieces (AutoCAD's SLICE, keeping both sides). */
  async sliceSolid(input: SliceInput): Promise<Array<Record<string, unknown>>> {
    const solid = this.documentValue.getSolid(input.solidId);
    if (!solid) throw new Error(`Solid ${input.solidId} does not exist.`);
    const normalLength = Math.hypot(input.planeNormal.x, input.planeNormal.y, input.planeNormal.z);
    if (normalLength < 1e-9) throw new Error('planeNormal must be non-zero.');
    if (!await promoteSolidToExact(solid)) throw new Error('This solid could not be prepared for slicing.');
    const kernel = await openCascadeKernel();
    const source = await openExactShape(solid, kernel);
    if (!source) throw new Error('This solid has no exact geometry to slice.');
    const plane = {
      origin: { ...input.planeOrigin },
      normal: {
        x: input.planeNormal.x / normalLength,
        y: input.planeNormal.y / normalLength,
        z: input.planeNormal.z / normalLength,
      },
    };
    const pieces: Solid[] = [];
    try {
      const exactPieces = kernel.splitByPlane(source, plane);
      try {
        if (exactPieces.length < 2) throw new Error('The plane does not pass through the solid.');
        exactPieces.forEach((pieceShape, index) => {
          const geometry = exactResult(kernel, pieceShape, 0);
          const piece = this.documentValue.createSolid(geometry.mesh, `${solid.name}_slice${index + 1}`, meshHeight(geometry.mesh), [], undefined, { kind: 'mesh' });
          piece.layer = solid.layer;
          piece.exact = geometry.exact;
          pieces.push(piece);
        });
      } finally {
        exactPieces.forEach((pieceShape) => pieceShape.dispose());
      }
    } finally {
      source.dispose();
    }
    this.historyValue.execute(new ReplaceObjectsEdit('MCP slice', [], [solid], [], pieces));
    this.selectObjects(pieces.map((piece) => piece.id));
    return pieces.map((piece) => solidSummary(this.documentValue.getSolid(piece.id)!));
  }

  /** Set the active UCS from three world points (origin, +X, +Y), as the UCS command does. */
  setUcs(input: UcsInput): DocumentSummary {
    const plane = workPlaneFromXYAxes(input.origin, input.xPoint, input.yPoint);
    const named = this.documentValue.addNamedWorkPlane(plane, input.name?.trim() || undefined);
    this.documentValue.activateNamedWorkPlane(named.id);
    this.documentValue.viewMode = '3d';
    this.documentValue.notify();
    return this.summary();
  }

  /** Restore the World Coordinate System. */
  restoreWcs(): DocumentSummary {
    this.documentValue.restoreWorldWorkPlane();
    this.documentValue.notify();
    return this.summary();
  }

  /** Create a layer (no-op if it already exists) and optionally make it current. */
  createLayer(name: string, makeCurrent = false): DocumentSummary {
    const clean = name.trim();
    if (!clean) throw new Error('A layer name is required.');
    if (!this.documentValue.layers.includes(clean)) this.documentValue.layers.push(clean);
    if (makeCurrent) this.documentValue.currentLayer = clean;
    this.documentValue.notify();
    return this.summary();
  }

  /** Make an existing layer the current one. */
  setCurrentLayer(name: string): DocumentSummary {
    if (!this.documentValue.layers.includes(name)) throw new Error(`Layer "${name}" does not exist.`);
    this.documentValue.currentLayer = name;
    this.documentValue.notify();
    return this.summary();
  }

  /** Move objects onto a layer as one undoable edit. */
  setObjectLayer(ids: readonly string[], layer: string): DocumentSummary {
    if (!this.documentValue.layers.includes(layer)) throw new Error(`Layer "${layer}" does not exist.`);
    const unique = [...new Set(ids)];
    const entities = unique.map((id) => this.documentValue.getEntity(id)).filter((value): value is Entity => Boolean(value));
    const solids = unique.map((id) => this.documentValue.getSolid(id)).filter((value): value is Solid => Boolean(value));
    if (entities.length + solids.length !== unique.length) {
      const found = new Set([...entities.map((entity) => entity.id), ...solids.map((solid) => solid.id)]);
      throw new Error(`Unknown object ID(s): ${unique.filter((id) => !found.has(id)).join(', ')}.`);
    }
    const afterEntities = entities.map((entity) => ({ ...cloneEntity(entity), layer }));
    const afterSolids = solids.map((solid) => ({ ...cloneSolid(solid), layer }));
    this.historyValue.execute(new ReplaceObjectsEdit('MCP set layer', entities, solids, afterEntities, afterSolids));
    this.documentValue.recolour();
    this.documentValue.notify();
    return this.summary();
  }

  /** The bounded planar-face region at a point with a matching outward normal. */
  private faceRegionAt(solid: Solid, point: Vec3, normal: Vec3): ReturnType<typeof planarFaceRegionAt> {
    const length = Math.hypot(normal.x, normal.y, normal.z) || 1;
    const unit = { x: normal.x / length, y: normal.y / length, z: normal.z / length };
    for (const face of solidPlanarFaces(solid.mesh)) {
      if (dot3(face.normal, unit) < 0.9) continue;
      const region = planarFaceRegionAt(face, this.documentValue.entities, point);
      if (region) return region;
    }
    return null;
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

const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** Net area of a planar face: its outer loop minus its holes, in the face plane. */
function faceArea(face: PlanarFace): number {
  const loopArea = (loop: { x: number; y: number }[]): number => {
    let area = 0;
    for (let index = 0; index < loop.length; index++) {
      const p = loop[index];
      const q = loop[(index + 1) % loop.length];
      area += p.x * q.y - q.x * p.y;
    }
    return Math.abs(area) / 2;
  };
  return face.loops.reduce((sum, loop, index) => sum + (index === 0 ? 1 : -1) * loopArea(loop), 0);
}

/** The centre of a solid's bounding box, the default pivot for rotate and scale. */
function solidCenter(solid: Solid): Vec3 {
  const bounds = meshBounds(solid.mesh);
  return {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  };
}

/** A work plane whose Z axis is `normal`, so a rotation about it is a rotation about that axis. */
function planeFromNormal(origin: Vec3, normal: Vec3): WorkPlane {
  const length = Math.hypot(normal.x, normal.y, normal.z) || 1;
  const z = { x: normal.x / length, y: normal.y / length, z: normal.z / length };
  const reference = Math.abs(z.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  let x = {
    x: reference.y * z.z - reference.z * z.y,
    y: reference.z * z.x - reference.x * z.z,
    z: reference.x * z.y - reference.y * z.x,
  };
  const xLength = Math.hypot(x.x, x.y, x.z) || 1;
  x = { x: x.x / xLength, y: x.y / xLength, z: x.z / xLength };
  const y = { x: z.y * x.z - z.z * x.y, y: z.z * x.x - z.x * x.z, z: z.x * x.y - z.y * x.x };
  return { origin: { ...origin }, xAxis: x, yAxis: y, zAxis: z };
}

/** Apply translate, then rotate, then scale to a solid, keeping its feature recipe. */
function transformSolidInPlace(solid: Solid, input: TransformInput): Solid {
  let current = solid;
  if (input.translate) {
    const delta = input.translate;
    const moved = cloneSolid(current);
    for (let index = 0; index < moved.mesh.positions.length; index += 3) {
      moved.mesh.positions[index] += delta.x;
      moved.mesh.positions[index + 1] += delta.y;
      moved.mesh.positions[index + 2] += delta.z;
    }
    moved.feature = translatedFeature(moved.feature, delta) ?? { kind: 'mesh' };
    preserveExactTransform(moved, translationAffine(delta));
    moved.revision++;
    current = moved;
  }
  if (input.rotate) {
    const center = input.rotate.center ?? solidCenter(current);
    const plane = planeFromNormal(center, input.rotate.axis ?? { x: 0, y: 0, z: 1 });
    current = rotateSolidAroundPlane(current, worldToLocal(plane, center), (input.rotate.angle * Math.PI) / 180, plane);
  }
  if (input.scale) {
    if (!(input.scale.factor > 0)) throw new Error('scale.factor must be greater than zero.');
    current = scaleSolid(current, input.scale.center ?? solidCenter(current), input.scale.factor);
  }
  return current;
}
