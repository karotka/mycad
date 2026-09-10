export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface Plane3 {
  origin: Point3;
  normal: Point3;
}

export type SweepProfile3 =
  | { kind: 'polygon'; points: readonly Point3[] }
  | { kind: 'circle'; center: Point3; normal: Point3; xAxis: Point3; radius: number }
  /** A closed loop of exact edges — the same vocabulary a sweep path uses — for
   *  a profile bounded by a mix of lines, arcs and Bezier curves rather than a
   *  straight-edged polygon. */
  | { kind: 'wire'; edges: readonly SweepPathSegment3[] };

export type SweepPathSegment3 =
  | { kind: 'line'; start: Point3; end: Point3 }
  | {
    kind: 'arc';
    center: Point3;
    normal: Point3;
    xAxis: Point3;
    radius: number;
    startAngle: number;
    sweepAngle: number;
  }
  | { kind: 'bezier'; poles: readonly Point3[] };

export interface EdgeReference3 {
  /** Zero-based indices in the kernel's stable face enumeration. */
  faceIds: readonly [number, number];
}

export interface Box3 {
  min: Point3;
  max: Point3;
}

/**
 * Row-major 3 × 4 affine transform. The final implicit row is `[0, 0, 0, 1]`.
 * It is JSON-safe so a B-rep can keep an exact placement without loading OCCT
 * merely because the user moved it.
 */
export type AffineTransform3 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

/**
 * An owning handle to exact solid geometry.
 *
 * Kernel solids are intentionally opaque. Rendering meshes are derived data and
 * must never become the source geometry again.
 */
export interface KernelSolid {
  readonly kernel: string;
  dispose(): void;
}

export interface SolidInspection {
  bounds: Box3;
  faceCount: number;
  solidCount: number;
  volume: number;
  valid: boolean;
}

export interface TessellationOptions {
  /** Maximum chordal deviation in model units. */
  linearDeflection?: number;
  /** Maximum angular deviation in radians. */
  angularDeflection?: number;
}

/**
 * Disposable-free rendering data derived from an exact solid.
 * `triangleFaceIds[n]` identifies the B-rep face behind triangle `n`.
 */
export interface KernelTessellation {
  positions: Float32Array;
  indices: Uint32Array;
  triangleFaceIds: Uint32Array;
}

/** JSON-safe exact geometry stored in a MyCAD project. */
export interface SerializedKernelSolid {
  format: 'occt-brep-v1';
  data: string;
}

/** Minimum exact-kernel contract used by the first migration proof. */
export interface GeometryKernel<Solid extends KernelSolid = KernelSolid> {
  makeBox(size: Point3, origin?: Point3): Solid;
  makeOrientedBox(size: Point3, origin: Point3, xAxis: Point3, zAxis: Point3): Solid;
  makeCylinder(radius: number, height: number, origin?: Point3): Solid;
  makeCone(baseRadius: number, topRadius: number, height: number, origin?: Point3): Solid;
  makeSphere(radius: number, center?: Point3): Solid;
  makeTorus(majorRadius: number, tubeRadius: number, center?: Point3): Solid;
  makeWedge(size: Point3, origin?: Point3): Solid;
  makePyramid(radius: number, height: number, center?: Point3): Solid;
  fromMesh(positions: ArrayLike<number>, indices: ArrayLike<number>): Solid;
  extrudePolygon(profile: readonly Point3[], vector: Point3): Solid;
  extrudeWire(edges: readonly SweepPathSegment3[], vector: Point3): Solid;
  extrudeRegion(loops: readonly (readonly Point3[])[], vector: Point3): Solid;
  extrudeCircle(radius: number, center: Point3, vector: Point3): Solid;
  loftPolygons(sections: readonly (readonly Point3[])[]): Solid;
  /** Each section a circle, a closed Bezier wire, or a straight-edged polygon. */
  loftProfiles(sections: readonly SweepProfile3[]): Solid;
  /** AutoCAD LOFT's "Path" option — sections ride along a guide curve instead
   *  of straight-interpolating between each other. */
  loftAlongPath(
    sections: readonly SweepProfile3[],
    path: readonly SweepPathSegment3[],
    fixedOrientation?: { origin: Point3; normal: Point3; xAxis: Point3 },
  ): Solid;
  /**
   * AutoCAD LOFT's "Guides" option: two open rails plus one or more open
   * guide curves, each touching both rails once, steering the loft's local
   * shape at that point instead of straight-interpolating there. Produces
   * the bent surface only — the caller thickens it into a solid separately
   * (e.g. via `shell(surface, null, thickness)`), the same way AutoCAD's own
   * open-cross-section loft yields a surface, not a solid.
   */
  loftGuidedSurface(
    rail1: readonly SweepPathSegment3[],
    rail2: readonly SweepPathSegment3[],
    guides: readonly (readonly SweepPathSegment3[])[],
  ): Solid;
  sweep(profile: SweepProfile3, path: readonly SweepPathSegment3[]): Solid;
  fillet(solid: Solid, edge: EdgeReference3, radius: number): Solid;
  chamfer(solid: Solid, edge: EdgeReference3, distance1: number, distance2: number): Solid;
  deleteFaces(solid: Solid, faceIds: readonly number[]): Solid;
  /** null faceId hollows the solid completely closed; a given face opens as
   *  the shell's mouth. thickness always hollows inward. */
  shell(solid: Solid, faceId: number | null, thickness: number): Solid;
  /** Same shape, every face orientation flipped — see OpenCascadeKernel's
   *  own doc comment for why a caller would want this. */
  reversed(solid: Solid): Solid;
  /** Pull direction is always the neutral plane's own normal. */
  draft(solid: Solid, faceIds: readonly number[], neutralPlane: Plane3, angleRadians: number): Solid;
  splitByPlane(solid: Solid, plane: Plane3): Solid[];
  union(solids: readonly Solid[]): Solid;
  subtract(base: Solid, tools: readonly Solid[]): Solid;
  intersect(solids: readonly Solid[]): Solid;
  heal(solid: Solid): Solid;
  transform(solid: Solid, transform: AffineTransform3): Solid;
  inspect(solid: Solid): SolidInspection;
  tessellate(solid: Solid, options?: TessellationOptions): KernelTessellation;
  serialize(solid: Solid): SerializedKernelSolid;
  deserialize(serialized: SerializedKernelSolid): Solid;
  /** ISO-10303-21 STEP text for every given solid, in one file — the exchange
   *  format another CAD program reads back as real B-rep, not a mesh. */
  writeStep(shapes: readonly Solid[]): string;
  /** Every top-level shape found in a STEP file, each its own solid handle —
   *  a STEP file can hold more than one part. */
  readStep(text: string): Solid[];
}
