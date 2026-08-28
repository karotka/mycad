import { closedVertices, getEntityPoints, type BooleanFeature, type Entity, type ExtrusionFeature, type PressPullFeature, type PrimitiveFeature, type Solid, type SolidEdgeSelection, type SolidFaceRegion, type SolidFaceSelection, type SolidFeature, type SolidMesh, type SweepFeature } from '../entities/types';
import { localToWorld, WORLD_WORK_PLANE, type WorkPlane } from '../../math/workplane';
import { OpenCascadeKernel, type OpenCascadeSolid } from './OpenCascadeKernel';
import { openCascadeKernel } from './OpenCascadeRuntime';
import type { AffineTransform3, Point3, SweepPathSegment3, SweepProfile3 } from './GeometryKernel';
import { runBooleanJob, type BooleanOperand } from './booleanJob';

export interface ExactSolidResult {
  mesh: SolidMesh;
  exact: NonNullable<Solid['exact']>;
}

export function hasCurrentExactGeometry(solid: Solid): boolean {
  return solid.exact?.kernel === 'opencascade' && solid.exact.revision === solid.revision;
}

/** Upgrades an old feature/mesh solid to the exact kernel without changing its revision. */
export async function promoteSolidToExact(solid: Solid): Promise<boolean> {
  if (hasCurrentExactGeometry(solid)) return true;
  try {
    const rebuilt = await buildExactFeature(solid.feature, solid.revision);
    if (rebuilt) {
      solid.mesh = rebuilt.mesh;
      solid.exact = rebuilt.exact;
      return true;
    }
    const kernel = await openCascadeKernel();
    const faceted = kernel.fromMesh(solid.mesh.positions, solid.mesh.indices);
    let healed: OpenCascadeSolid | null = null;
    try {
      healed = kernel.heal(faceted);
      const exact = exactResult(kernel, healed, solid.revision);
      solid.mesh = exact.mesh;
      solid.exact = exact.exact;
      return true;
    } finally {
      healed?.dispose();
      faceted.dispose();
    }
  } catch {
    return false;
  }
}

export async function buildExactBox(feature: PrimitiveFeature, revision = 0): Promise<ExactSolidResult> {
  if (feature.primitive !== 'box') throw new Error('Exact box builder requires a box feature.');
  const result = await buildExactFeature(feature, revision);
  if (!result) throw new Error('Exact box feature could not be built.');
  return result;
}

/** Builds the exact subset of the feature tree currently supported in production. */
export async function buildExactFeature(feature: SolidFeature, revision = 0): Promise<ExactSolidResult | null> {
  const kernel = await openCascadeKernel();
  const shape = exactShapeFromFeature(feature, kernel);
  if (!shape) return null;
  try {
    return exactResult(kernel, shape, revision);
  } finally {
    shape.dispose();
  }
}

function exactShapeFromFeature(feature: SolidFeature, kernel: OpenCascadeKernel): OpenCascadeSolid | null {
  if (feature.kind === 'primitive') return exactPrimitiveShape(feature, kernel);
  if (feature.kind === 'extrusion') return exactExtrusionShape(feature, kernel);
  if (feature.kind === 'sweep') return exactSweepShape(feature, kernel);
  if (feature.kind === 'presspull-region') return exactPressPullShape(feature, kernel);
  if (feature.kind === 'edge-modification') return exactEdgeModificationShape(feature, kernel);
  if (feature.kind !== 'boolean' || feature.operands.length === 0) return null;

  const operands: OpenCascadeSolid[] = [];
  try {
    for (const operand of feature.operands) {
      const shape = exactShapeFromFeature(operand, kernel);
      if (!shape) return null;
      operands.push(shape);
    }
    if (feature.operation !== 'union' && operands.length < 2) return null;
    const combined = feature.operation === 'union'
      ? kernel.union(operands)
      : feature.operation === 'subtract'
        ? kernel.subtract(operands[0], operands.slice(1))
        : kernel.intersect(operands);
    try {
      return kernel.heal(combined);
    } finally {
      combined.dispose();
    }
  } finally {
    operands.forEach((operand) => operand.dispose());
  }
}

function exactEdgeModificationShape(
  feature: Extract<SolidFeature, { kind: 'edge-modification' }>,
  kernel: OpenCascadeKernel,
): OpenCascadeSolid | null {
  const source = exactFeatureSource(feature.source, feature.sourceMesh, kernel);
  if (!source) return null;
  try {
    const tessellation = kernel.tessellate(source);
    const faceIds = feature.edge.topologyFaceIds ?? topologyFaceIdsNearEdge({
      positions: tessellation.positions,
      indices: tessellation.indices,
      triangleFaceIds: tessellation.triangleFaceIds,
    }, feature.edge);
    if (!faceIds) return null;
    const reference = { faceIds };
    return feature.operation === 'fillet'
      ? kernel.fillet(source, reference, feature.amount)
      : kernel.chamfer(source, reference, feature.amount, feature.amount2 ?? feature.amount);
  } finally {
    source.dispose();
  }
}

function exactPressPullShape(feature: PressPullFeature, kernel: OpenCascadeKernel): OpenCascadeSolid | null {
  const source = exactFeatureSource(feature.source, feature.sourceMesh, kernel);
  if (!source) return null;
  try {
    return pressPullShape(kernel, source, feature.region, feature.distance);
  } finally {
    source.dispose();
  }
}

/** A recorded legacy mesh is promoted only at the boundary of its exact child feature. */
function exactFeatureSource(
  feature: SolidFeature,
  sourceMesh: { positions: number[]; indices: number[] } | undefined,
  kernel: OpenCascadeKernel,
): OpenCascadeSolid | null {
  const rebuilt = exactShapeFromFeature(feature, kernel);
  if (rebuilt || !sourceMesh) return rebuilt;
  const faceted = kernel.fromMesh(sourceMesh.positions, sourceMesh.indices);
  try {
    return kernel.heal(faceted);
  } finally {
    faceted.dispose();
  }
}

function pressPullShape(
  kernel: OpenCascadeKernel,
  source: OpenCascadeSolid,
  region: SolidFaceRegion,
  distance: number,
): OpenCascadeSolid {
  if (!Number.isFinite(distance) || Math.abs(distance) < 1e-9 || region.loops.length === 0) {
    throw new Error('PressPull requires a non-zero distance and a bounded region.');
  }
  const bounds = kernel.inspect(source).bounds;
  const extent = Math.max(
    1,
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  );
  const overlap = Math.max(1e-7, extent * 1e-8);
  const localOffset = distance > 0 ? -overlap : distance;
  const height = Math.abs(distance) + overlap;
  const loops = region.loops.map((loop) => loop.map((point) => localToWorld(region.plane, point, localOffset)));
  const vector = {
    x: region.plane.zAxis.x * height,
    y: region.plane.zAxis.y * height,
    z: region.plane.zAxis.z * height,
  };
  const tool = kernel.extrudeRegion(loops, vector);
  let combined: OpenCascadeSolid | null = null;
  try {
    combined = distance > 0 ? kernel.union([source, tool]) : kernel.subtract(source, [tool]);
    return kernel.heal(combined);
  } finally {
    combined?.dispose();
    tool.dispose();
  }
}

function exactSweepShape(feature: SweepFeature, kernel: OpenCascadeKernel): OpenCascadeSolid | null {
  const pathPlane = feature.path.workPlane ?? feature.workPlane ?? WORLD_WORK_PLANE;
  const startAndTangent = pathStartAndTangent(feature.path);
  if (!startAndTangent) return null;
  const pathStart = localToWorld(pathPlane, startAndTangent.start);
  const tangent = planeDirection(pathPlane, startAndTangent.tangent);
  const crossX = planeDirection(pathPlane, {
    x: -startAndTangent.tangent.y,
    y: startAndTangent.tangent.x,
  });
  const crossPlane: WorkPlane = {
    origin: pathStart,
    xAxis: crossX,
    yAxis: { ...pathPlane.zAxis },
    zAxis: tangent,
  };
  const profile = exactSweepProfile(feature.profile, crossPlane);
  const path = exactSweepPath(feature.path, pathPlane);
  return profile && path ? kernel.sweep(profile, path) : null;
}

function exactSweepProfile(profile: Entity, plane: WorkPlane): SweepProfile3 | null {
  if (profile.type === 'circle') {
    return {
      kind: 'circle',
      center: localToWorld(plane, profile.center),
      normal: { ...plane.zAxis },
      xAxis: { ...plane.xAxis },
      radius: profile.radius,
    };
  }
  const vertices = closedVertices(profile);
  return vertices && vertices.length >= 3
    ? { kind: 'polygon', points: vertices.map((point) => localToWorld(plane, point)) }
    : null;
}

function exactSweepPath(path: Entity, plane: WorkPlane): SweepPathSegment3[] | null {
  switch (path.type) {
    case 'line':
      return [{ kind: 'line', start: localToWorld(plane, path.start), end: localToWorld(plane, path.end) }];
    case 'polyline': {
      if (path.vertices.length < 2) return null;
      const segments: SweepPathSegment3[] = [];
      const count = path.closed ? path.vertices.length : path.vertices.length - 1;
      for (let index = 0; index < count; index++) {
        const start = path.vertices[index];
        const end = path.vertices[(index + 1) % path.vertices.length];
        if (Math.hypot(end.x - start.x, end.y - start.y) <= 1e-9) continue;
        segments.push({ kind: 'line', start: localToWorld(plane, start), end: localToWorld(plane, end) });
      }
      return segments.length > 0 ? segments : null;
    }
    case 'arc':
      return [{
        kind: 'arc',
        center: localToWorld(plane, path.center),
        normal: { ...plane.zAxis },
        xAxis: { ...plane.xAxis },
        radius: path.radius,
        startAngle: path.startAngle,
        sweepAngle: path.sweepAngle,
      }];
    case 'circle':
      return [{
        kind: 'arc',
        center: localToWorld(plane, path.center),
        normal: { ...plane.zAxis },
        xAxis: { ...plane.xAxis },
        radius: path.radius,
        startAngle: 0,
        sweepAngle: Math.PI * 2,
      }];
    case 'bezier': {
      let segmentStart = path.start;
      return path.segments.map((segment) => {
        const poles: SweepPathSegment3 = {
          kind: 'bezier',
          poles: [segmentStart, segment.control1, segment.control2, segment.end].map((point) => localToWorld(plane, point)),
        };
        segmentStart = segment.end;
        return poles;
      });
    }
    default:
      return null;
  }
}

function pathStartAndTangent(path: Entity): { start: { x: number; y: number }; tangent: { x: number; y: number } } | null {
  let start: { x: number; y: number };
  let tangent: { x: number; y: number };
  switch (path.type) {
    case 'line':
      start = path.start;
      tangent = { x: path.end.x - path.start.x, y: path.end.y - path.start.y };
      break;
    case 'polyline': {
      if (path.vertices.length < 2) return null;
      start = path.vertices[0];
      const next = path.vertices.find((point, index) => index > 0 && Math.hypot(point.x - start.x, point.y - start.y) > 1e-9);
      if (!next) return null;
      tangent = { x: next.x - start.x, y: next.y - start.y };
      break;
    }
    case 'arc': {
      start = {
        x: path.center.x + Math.cos(path.startAngle) * path.radius,
        y: path.center.y + Math.sin(path.startAngle) * path.radius,
      };
      const sign = path.sweepAngle < 0 ? -1 : 1;
      tangent = { x: -Math.sin(path.startAngle) * sign, y: Math.cos(path.startAngle) * sign };
      break;
    }
    case 'circle':
      start = { x: path.center.x + path.radius, y: path.center.y };
      tangent = { x: 0, y: 1 };
      break;
    case 'bezier': {
      start = path.start;
      const first = path.segments[0];
      tangent = { x: first.control1.x - path.start.x, y: first.control1.y - path.start.y };
      if (Math.hypot(tangent.x, tangent.y) <= 1e-9) {
        tangent = { x: first.control2.x - path.start.x, y: first.control2.y - path.start.y };
      }
      if (Math.hypot(tangent.x, tangent.y) <= 1e-9) {
        tangent = { x: first.end.x - path.start.x, y: first.end.y - path.start.y };
      }
      break;
    }
    default:
      return null;
  }
  const length = Math.hypot(tangent.x, tangent.y);
  return length > 1e-9
    ? { start, tangent: { x: tangent.x / length, y: tangent.y / length } }
    : null;
}

function planeDirection(plane: WorkPlane, vector: { x: number; y: number }): Point3 {
  return {
    x: plane.xAxis.x * vector.x + plane.yAxis.x * vector.y,
    y: plane.xAxis.y * vector.x + plane.yAxis.y * vector.y,
    z: plane.xAxis.z * vector.x + plane.yAxis.z * vector.y,
  };
}

function exactExtrusionShape(feature: ExtrusionFeature, kernel: OpenCascadeKernel): OpenCascadeSolid | null {
  const transform = feature.transform;
  // The profile keeps the elevation it was drawn at as a local z on its points
  // (a snap onto something above the UCS rides its height along). Start the prism
  // there, not at the work-plane origin, or a rectangle drawn on top of a box
  // extrudes up from Z=0 instead of from where it sits.
  const z = (transform.translateZ ?? 0) + profileElevation(feature.profile);
  const taperAngle = feature.taperAngle ?? 0;
  if (feature.direction && Math.abs(taperAngle) > 1e-12) return null;
  const vector = feature.direction
    ? { ...feature.direction }
    : { x: 0, y: 0, z: feature.height };
  let local: OpenCascadeSolid;
  if (feature.profile.type === 'circle') {
    if (Math.abs(Math.abs(transform.scaleX) - Math.abs(transform.scaleY)) > 1e-12) return null;
    const radius = feature.profile.radius * Math.abs(transform.scaleX);
    const center = {
      x: feature.profile.center.x * transform.scaleX + transform.translateX,
      y: feature.profile.center.y * transform.scaleY + transform.translateY,
      z,
    };
    if (Math.abs(taperAngle) <= 1e-12) local = kernel.extrudeCircle(radius, center, vector);
    else {
      const farRadius = taperedLength(radius, feature.height, taperAngle);
      if (farRadius === null) return null;
      local = feature.reverse
        ? kernel.makeCone(farRadius, radius, feature.height, center)
        : kernel.makeCone(radius, farRadius, feature.height, center);
    }
  } else {
    const vertices = closedVertices(feature.profile);
    if (!vertices || vertices.length < 3) return null;
    const profile = vertices.map((point) => ({
      x: point.x * transform.scaleX + transform.translateX,
      y: point.y * transform.scaleY + transform.translateY,
      z,
    }));
    if (Math.abs(taperAngle) <= 1e-12) local = kernel.extrudePolygon(profile, vector);
    else {
      const xs = profile.map((point) => point.x), ys = profile.map((point) => point.y);
      const center = {
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        y: (Math.min(...ys) + Math.max(...ys)) / 2,
      };
      const halfX = (Math.max(...xs) - Math.min(...xs)) / 2;
      const halfY = (Math.max(...ys) - Math.min(...ys)) / 2;
      if (halfX <= 1e-9 || halfY <= 1e-9) return null;
      const farHalfX = taperedLength(halfX, feature.height, taperAngle);
      const farHalfY = taperedLength(halfY, feature.height, taperAngle);
      if (farHalfX === null || farHalfY === null) return null;
      const scaled = profile.map((point) => ({
        x: center.x + (point.x - center.x) * farHalfX / halfX,
        y: center.y + (point.y - center.y) * farHalfY / halfY,
        z: z + feature.height,
      }));
      const fullAtFarEnd = profile.map((point) => ({ ...point, z: z + feature.height }));
      const taperedAtStart = scaled.map((point) => ({ ...point, z }));
      local = kernel.loftPolygons(feature.reverse
        ? [taperedAtStart, fullAtFarEnd]
        : [profile, scaled]);
    }
  }
  const placement = workPlanePlacement(feature.workPlane ?? feature.profile.workPlane ?? WORLD_WORK_PLANE);
  if (isIdentity(placement)) return local;
  try {
    return kernel.transform(local, placement);
  } finally {
    local.dispose();
  }
}

/**
 * How far the profile sits off its own work plane, read from the first vertex
 * that carries a local z. A profile that never left the plane returns 0, so an
 * ordinary ground-level extrusion is unaffected.
 */
function profileElevation(profile: Entity): number {
  for (const point of getEntityPoints(profile)) {
    const pz = (point as { z?: number }).z;
    if (typeof pz === 'number' && Number.isFinite(pz)) return pz;
  }
  return 0;
}

function taperedLength(base: number, height: number, angleDegrees: number): number | null {
  const offset = height * Math.tan(Math.abs(angleDegrees) * Math.PI / 180);
  const result = base + (angleDegrees > 0 ? -offset : offset);
  return Number.isFinite(result) && result > 1e-9 ? result : null;
}

function exactPrimitiveShape(feature: PrimitiveFeature, kernel: OpenCascadeKernel): OpenCascadeSolid {
  const canonical = canonicalPrimitiveShape(feature, kernel);
  const transform = primitivePlacement(feature);
  if (isIdentity(transform)) return canonical;
  try {
    return kernel.transform(canonical, transform);
  } finally {
    canonical.dispose();
  }
}

function canonicalPrimitiveShape(feature: PrimitiveFeature, kernel: OpenCascadeKernel): OpenCascadeSolid {
  const center = { x: feature.center.x, y: feature.center.y, z: 0 };
  const radius = feature.radius ?? 0;
  switch (feature.primitive) {
    case 'box':
    case 'wedge': {
      const width = feature.width ?? 0;
      const depth = feature.depth ?? 0;
      const origin = { x: feature.center.x - width / 2, y: feature.center.y - depth / 2, z: 0 };
      return feature.primitive === 'box'
        ? kernel.makeBox({ x: width, y: depth, z: feature.height }, origin)
        : kernel.makeWedge({ x: width, y: depth, z: feature.height }, origin);
    }
    case 'cylinder':
      return kernel.makeCylinder(radius, feature.height, center);
    case 'cone': {
      const topRadius = feature.radiusTop ?? 0;
      return Math.abs(radius - topRadius) <= 1e-12
        ? kernel.makeCylinder(radius, feature.height, center)
        : kernel.makeCone(radius, topRadius, feature.height, center);
    }
    case 'sphere':
      return kernel.makeSphere(radius, center);
    case 'torus':
      return kernel.makeTorus(radius, feature.tubeRadius ?? 0, center);
    case 'pyramid':
      return kernel.makePyramid(radius, feature.height, center);
  }
}

function primitivePlacement(feature: PrimitiveFeature): AffineTransform3 {
  const plane = feature.workPlane ?? WORLD_WORK_PLANE;
  const scale = feature.scale ?? { x: 1, y: 1, z: 1 };
  if (Math.abs(scale.x) <= Number.EPSILON || Math.abs(scale.y) <= Number.EPSILON || Math.abs(scale.z) <= Number.EPSILON) {
    throw new Error('Primitive scale must be non-zero.');
  }
  return [
    plane.xAxis.x * scale.x, plane.yAxis.x * scale.y, plane.zAxis.x * scale.z, plane.origin.x,
    plane.xAxis.y * scale.x, plane.yAxis.y * scale.y, plane.zAxis.y * scale.z, plane.origin.y,
    plane.xAxis.z * scale.x, plane.yAxis.z * scale.y, plane.zAxis.z * scale.z, plane.origin.z,
  ];
}

function workPlanePlacement(plane: typeof WORLD_WORK_PLANE): AffineTransform3 {
  return [
    plane.xAxis.x, plane.yAxis.x, plane.zAxis.x, plane.origin.x,
    plane.xAxis.y, plane.yAxis.y, plane.zAxis.y, plane.origin.y,
    plane.xAxis.z, plane.yAxis.z, plane.zAxis.z, plane.origin.z,
  ];
}

function isIdentity(transform: AffineTransform3): boolean {
  const identity: AffineTransform3 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  return transform.every((value, index) => Math.abs(value - identity[index]) <= 1e-12);
}

export async function openExactShape(
  solid: Solid,
  kernel: OpenCascadeKernel,
): Promise<OpenCascadeSolid | null> {
  if (!hasCurrentExactGeometry(solid)) return null;
  const shape = kernel.deserialize(solid.exact!.shape);
  if (!solid.exact!.transform) return shape;
  try {
    return kernel.transform(shape, solid.exact!.transform);
  } finally {
    shape.dispose();
  }
}

/**
 * Applies a boolean to the given solids.
 *
 * Crucially this function touches OCCT not at all: it only reads data already in
 * memory (each solid's current exact B-rep, or its feature recipe and mesh) and
 * describes the operands for the worker. Every OCCT call — rebuilding an operand's
 * exact shape from its feature (which runs its own nested booleans), the fuse/cut/
 * common, the heal, the tessellation — happens in computeBooleanResult, which the
 * worker runs off the main thread. A boolean, or a feature rebuild, over a
 * pathological solid can hang OCCT with no way to interrupt a blocking WASM call,
 * so anything that could hang must be behind the worker we can `terminate()`; if
 * even the promotion ran here, the UI would still freeze. The job runner races the
 * worker against a timeout and returns a serialisable {mesh, exact}, or null if it
 * was cancelled or failed.
 */
export async function booleanExactSolids(
  operation: BooleanFeature['operation'],
  solids: readonly Solid[],
  revision = 0,
): Promise<ExactSolidResult | null> {
  if (solids.length === 0 || (operation !== 'union' && solids.length < 2)) return null;
  const operands: BooleanOperand[] = solids.map((solid) => hasCurrentExactGeometry(solid)
    ? { source: 'exact', shape: solid.exact!.shape, transform: solid.exact!.transform }
    : { source: 'feature', feature: solid.feature, positions: solid.mesh.positions, indices: solid.mesh.indices });
  return runBooleanJob(operation, operands, revision);
}

/**
 * The boolean itself, over operand descriptions. This is what the worker runs (and
 * what the Node/test path calls directly): resolve each operand to a live shape —
 * deserialise its stored B-rep, or rebuild it from its feature (falling back to the
 * mesh) — combine, heal, and tessellate into a {mesh, exact} that survives
 * structured cloning back to the main thread. Kept free of any DOM/Solid dependency
 * so it can live in a worker. Throws on OCCT failure; the caller turns that into a
 * null.
 */
export function computeBooleanResult(
  kernel: OpenCascadeKernel,
  operation: BooleanFeature['operation'],
  operands: readonly BooleanOperand[],
  revision: number,
): ExactSolidResult {
  const shapes: OpenCascadeSolid[] = [];
  let combined: OpenCascadeSolid | null = null;
  let healed: OpenCascadeSolid | null = null;
  try {
    for (const operand of operands) shapes.push(resolveBooleanOperand(kernel, operand));
    combined = operation === 'union'
      ? kernel.union(shapes)
      : operation === 'subtract'
        ? kernel.subtract(shapes[0], shapes.slice(1))
        : kernel.intersect(shapes);
    healed = kernel.heal(combined);
    return exactResult(kernel, healed, revision);
  } finally {
    healed?.dispose();
    combined?.dispose();
    shapes.forEach((shape) => shape.dispose());
  }
}

/**
 * Turns one operand description into a live world-space B-rep. A current exact
 * shape is just deserialised (and re-placed by its transform, mirroring
 * openExactShape); otherwise the feature is rebuilt — the step that can run its
 * own nested booleans — and only if that yields nothing does it fall back to the
 * tessellation. Runs wherever computeBooleanResult runs, i.e. in the worker.
 */
function resolveBooleanOperand(kernel: OpenCascadeKernel, operand: BooleanOperand): OpenCascadeSolid {
  if (operand.source === 'exact') {
    const shape = kernel.deserialize(operand.shape);
    if (!operand.transform) return shape;
    try {
      return kernel.transform(shape, operand.transform);
    } finally {
      shape.dispose();
    }
  }
  const built = exactShapeFromFeature(operand.feature, kernel);
  if (built) return built;
  const faceted = kernel.fromMesh(operand.positions, operand.indices);
  try {
    return kernel.heal(faceted);
  } finally {
    faceted.dispose();
  }
}

/** Applies PRESSPULL to the stored B-rep, including baked SLICE/boolean results. */
export async function pressPullExactSolid(
  solid: Solid,
  region: SolidFaceRegion,
  distance: number,
  revision: number,
): Promise<ExactSolidResult | null> {
  if (!await promoteSolidToExact(solid)) return null;
  const kernel = await openCascadeKernel();
  const source = await openExactShape(solid, kernel);
  if (!source) return null;
  let result: OpenCascadeSolid | null = null;
  try {
    result = pressPullShape(kernel, source, region, distance);
    return exactResult(kernel, result, revision);
  } catch {
    // The analytic boolean can throw on a solid whose exact topology OCCT will not
    // fuse (many stacked holes, chamfers). Fall through to the faceted retry rather
    // than giving up — and never rethrow: the caller awaits this inside a command
    // step, where an uncaught rejection latches the step's `advancing` guard and
    // every later click and typed distance is silently dropped, so the face looks
    // stuck.
  } finally {
    result?.dispose();
    source.dispose();
  }
  return pressPullMeshFallback(kernel, solid.mesh, region, distance, revision);
}

/**
 * The same press/pull done on the solid's tessellation instead of its analytic
 * B-rep. A faceted shape has none of the tangencies and slivers that make OCCT
 * refuse the exact fuse, so a face that would not move on the exact solid usually
 * moves here — at the cost of turning the result faceted, which is the honest
 * trade for getting the edit at all. Returns null (never throws) if even this
 * fails.
 */
function pressPullMeshFallback(
  kernel: OpenCascadeKernel,
  mesh: SolidMesh,
  region: SolidFaceRegion,
  distance: number,
  revision: number,
): ExactSolidResult | null {
  const faceted = kernel.fromMesh(mesh.positions, mesh.indices);
  let source: OpenCascadeSolid | null = null;
  let result: OpenCascadeSolid | null = null;
  try {
    source = kernel.heal(faceted);
    result = pressPullShape(kernel, source, region, distance);
    return exactResult(kernel, result, revision);
  } catch {
    return null;
  } finally {
    result?.dispose();
    source?.dispose();
    faceted.dispose();
  }
}

/** Modifies the selected common B-rep edge, identified by its two support faces. */
export async function modifyExactSolidEdge(
  solid: Solid,
  edge: SolidEdgeSelection,
  amount: number,
  rounded: boolean,
  amount2: number,
  revision: number,
): Promise<ExactSolidResult | null> {
  if (!await promoteSolidToExact(solid)) return null;
  edge.topologyFaceIds ??= topologyFaceIdsNearEdge(solid.mesh, edge);
  if (!edge.topologyFaceIds) return null;
  const kernel = await openCascadeKernel();
  const source = await openExactShape(solid, kernel);
  if (!source) return null;
  let modified: OpenCascadeSolid | null = null;
  try {
    const reference = { faceIds: edge.topologyFaceIds };
    modified = rounded
      ? kernel.fillet(source, reference, amount)
      : kernel.chamfer(source, reference, amount, amount2);
    return exactResult(kernel, modified, revision);
  } catch {
    return null;
  } finally {
    modified?.dispose();
    source.dispose();
  }
}

/** Removes an exact face and lets OCCT extend/heal its neighbouring surfaces. */
export async function deleteExactSolidFace(
  solid: Solid,
  selection: SolidFaceSelection,
  revision: number,
): Promise<ExactSolidResult | null> {
  if (!await promoteSolidToExact(solid)) return null;
  const faceId = selection.topologyFaceId ?? topologyFaceIdAtPoint(solid.mesh, selection);
  if (faceId === undefined) return null;
  selection.topologyFaceId = faceId;
  const kernel = await openCascadeKernel();
  const source = await openExactShape(solid, kernel);
  if (!source) return null;
  let result: OpenCascadeSolid | null = null;
  try {
    result = kernel.deleteFaces(source, [faceId]);
    return exactResult(kernel, result, revision);
  } catch {
    return null;
  } finally {
    result?.dispose();
    source.dispose();
  }
}

function topologyFaceIdsNearEdge(mesh: SolidMesh, selection: SolidEdgeSelection): [number, number] | undefined {
  if (!mesh.triangleFaceIds) return undefined;
  const records = new Map<string, { a: number; b: number; faces: Set<number> }>();
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const ids = [mesh.indices[offset], mesh.indices[offset + 1], mesh.indices[offset + 2]];
    for (let index = 0; index < 3; index++) {
      const a = ids[index], b = ids[(index + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const record = records.get(key) ?? { a, b, faces: new Set<number>() };
      record.faces.add(mesh.triangleFaceIds[offset / 3]);
      records.set(key, record);
    }
  }
  const midpoint = {
    x: (selection.start.x + selection.end.x) / 2,
    y: (selection.start.y + selection.end.y) / 2,
    z: (selection.start.z + selection.end.z) / 2,
  };
  let best: { ids: [number, number]; distance: number } | null = null;
  for (const record of records.values()) {
    if (record.faces.size !== 2) continue;
    const start = meshPoint(mesh, record.a), end = meshPoint(mesh, record.b);
    const distance = pointSegmentDistance(midpoint, start, end);
    if (!best || distance < best.distance) best = { ids: [...record.faces] as [number, number], distance };
  }
  return best?.ids;
}

function topologyFaceIdAtPoint(mesh: SolidMesh, selection: SolidFaceSelection): number | undefined {
  if (!mesh.triangleFaceIds || !selection.hitPoint) return undefined;
  const selectedVertices = new Set(selection.vertexIndices);
  if (selectedVertices.size > 0) {
    const counts = new Map<number, number>();
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      if (!selectedVertices.has(mesh.indices[offset])
        || !selectedVertices.has(mesh.indices[offset + 1])
        || !selectedVertices.has(mesh.indices[offset + 2])) continue;
      const faceId = mesh.triangleFaceIds[offset / 3];
      counts.set(faceId, (counts.get(faceId) ?? 0) + 1);
    }
    const selected = [...counts.entries()].sort((first, second) => second[1] - first[1])[0];
    if (selected) return selected[0];
  }
  let best: { faceId: number; distance: number } | null = null;
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const a = meshPoint(mesh, mesh.indices[offset]);
    const b = meshPoint(mesh, mesh.indices[offset + 1]);
    const c = meshPoint(mesh, mesh.indices[offset + 2]);
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    const agreement = (nx * selection.normal.x + ny * selection.normal.y + nz * selection.normal.z) / length;
    if (agreement < 0.5) continue;
    const distance = pointTriangleDistance(selection.hitPoint, a, b, c);
    if (!best || distance < best.distance) best = { faceId: mesh.triangleFaceIds[offset / 3], distance };
  }
  return best?.faceId;
}

function meshPoint(mesh: SolidMesh, index: number): Point3 {
  return { x: mesh.positions[index * 3], y: mesh.positions[index * 3 + 1], z: mesh.positions[index * 3 + 2] };
}

function pointSegmentDistance(point: Point3, start: Point3, end: Point3): number {
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  const t = lengthSquared <= 1e-20 ? 0 : Math.max(0, Math.min(1, (
    (point.x - start.x) * dx + (point.y - start.y) * dy + (point.z - start.z) * dz
  ) / lengthSquared));
  return Math.hypot(point.x - start.x - dx * t, point.y - start.y - dy * t, point.z - start.z - dz * t);
}

function pointTriangleDistance(point: Point3, a: Point3, b: Point3, c: Point3): number {
  const edgeDistance = Math.min(
    pointSegmentDistance(point, a, b),
    pointSegmentDistance(point, b, c),
    pointSegmentDistance(point, c, a),
  );
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const ap = { x: point.x - a.x, y: point.y - a.y, z: point.z - a.z };
  const d00 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  const d01 = ab.x * ac.x + ab.y * ac.y + ab.z * ac.z;
  const d11 = ac.x * ac.x + ac.y * ac.y + ac.z * ac.z;
  const d20 = ap.x * ab.x + ap.y * ab.y + ap.z * ab.z;
  const d21 = ap.x * ac.x + ap.y * ac.y + ap.z * ac.z;
  const denominator = d00 * d11 - d01 * d01;
  if (Math.abs(denominator) <= 1e-20) return edgeDistance;
  const v = (d11 * d20 - d01 * d21) / denominator;
  const w = (d00 * d21 - d01 * d20) / denominator;
  if (v < 0 || w < 0 || v + w > 1) return edgeDistance;
  const projection = {
    x: a.x + ab.x * v + ac.x * w,
    y: a.y + ab.y * v + ac.y * w,
    z: a.z + ab.z * v + ac.z * w,
  };
  return Math.hypot(point.x - projection.x, point.y - projection.y, point.z - projection.z);
}

export function exactResult(
  kernel: OpenCascadeKernel,
  shape: OpenCascadeSolid,
  revision: number,
): ExactSolidResult {
  const inspection = kernel.inspect(shape);
  if (!inspection.valid || inspection.solidCount < 1) {
    throw new Error('OpenCascade produced an invalid or empty exact solid.');
  }
  const serialized = kernel.serialize(shape);
  // Validate the persisted representation, not only the maker's transient
  // in-memory result. This catches incomplete pcurves/tolerances before a bad
  // exact body can enter a project file.
  const persisted = kernel.deserialize(serialized);
  try {
    const tessellation = kernel.tessellate(persisted);
    return {
      mesh: {
        positions: tessellation.positions,
        indices: tessellation.indices,
        triangleFaceIds: tessellation.triangleFaceIds,
      },
      exact: {
        kernel: 'opencascade',
        revision,
        shape: serialized,
      },
    };
  } finally {
    persisted.dispose();
  }
}
