import type {
  OpenCascadeInstance,
  BRepOffset_Mode,
  ChFi3d_FilletShape,
  Convert_ParameterisationType,
  GeomAbs_JoinType,
  GeomFill_FillingStyle,
  gp_Ax2,
  gp_Pnt,
  Handle_Geom_BSplineCurve,
  IFSelect_ReturnStatus,
  STEPControl_StepModelType,
  TopAbs_ShapeEnum,
  TopTools_FormatVersion,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
  TopoDS_Wire,
} from 'opencascade.js';
import type {
  GeometryKernel,
  EdgeReference3,
  AffineTransform3,
  KernelTessellation,
  KernelSolid,
  Plane3,
  Point3,
  SerializedKernelSolid,
  SolidInspection,
  SweepPathSegment3,
  SweepProfile3,
  TessellationOptions,
} from './GeometryKernel';

const ZERO: Point3 = { x: 0, y: 0, z: 0 };

export class OpenCascadeSolid implements KernelSolid {
  readonly kernel = 'opencascade';
  private disposed = false;

  constructor(
    private readonly owner: OpenCascadeKernel,
    private shapeValue: TopoDS_Shape,
  ) {}

  shape(requester: OpenCascadeKernel): TopoDS_Shape {
    if (requester !== this.owner) {
      throw new Error('OpenCascade solid belongs to a different kernel instance.');
    }
    if (this.disposed) throw new Error('OpenCascade solid has already been disposed.');
    return this.shapeValue;
  }

  dispose(): void {
    if (this.disposed) return;
    this.shapeValue.delete();
    this.disposed = true;
  }
}

/** Exact B-rep modelling kernel; meshes exposed by it are derived render data. */
export class OpenCascadeKernel implements GeometryKernel<OpenCascadeSolid> {
  private temporaryFileSequence = 0;

  constructor(private readonly oc: OpenCascadeInstance) {}

  makeBox(size: Point3, origin: Point3 = ZERO): OpenCascadeSolid {
    return this.makeOrientedBox(
      size,
      origin,
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
    );
  }

  makeOrientedBox(
    size: Point3,
    origin: Point3,
    xAxis: Point3,
    zAxis: Point3,
  ): OpenCascadeSolid {
    if (size.x <= 0 || size.y <= 0 || size.z <= 0) {
      throw new Error('Box dimensions must be positive.');
    }

    const point = new this.oc.gp_Pnt_3(origin.x, origin.y, origin.z);
    const xDirection = new this.oc.gp_Dir_4(xAxis.x, xAxis.y, xAxis.z);
    const zDirection = new this.oc.gp_Dir_4(zAxis.x, zAxis.y, zAxis.z);
    const axes = new this.oc.gp_Ax2_2(point, zDirection, xDirection);
    const maker = new this.oc.BRepPrimAPI_MakeBox_5(axes, size.x, size.y, size.z);
    const shape = maker.Shape();
    maker.delete();
    axes.delete();
    zDirection.delete();
    xDirection.delete();
    point.delete();
    return this.wrap(shape);
  }

  makeCylinder(radius: number, height: number, origin: Point3 = ZERO): OpenCascadeSolid {
    this.validateRadialPrimitive(radius, height, 'Cylinder');
    return this.makeWithAxes(origin, (axes) => {
      const maker = new this.oc.BRepPrimAPI_MakeCylinder_3(axes, radius, height);
      const shape = maker.Shape();
      maker.delete();
      return shape;
    });
  }

  makeCone(baseRadius: number, topRadius: number, height: number, origin: Point3 = ZERO): OpenCascadeSolid {
    if (baseRadius <= 0 || topRadius < 0 || height <= 0 || Math.abs(baseRadius - topRadius) <= Number.EPSILON) {
      throw new Error('Cone radii and height must define a non-cylindrical positive solid.');
    }
    return this.makeWithAxes(origin, (axes) => {
      const maker = new this.oc.BRepPrimAPI_MakeCone_3(axes, baseRadius, topRadius, height);
      const shape = maker.Shape();
      maker.delete();
      return shape;
    });
  }

  makeSphere(radius: number, center: Point3 = ZERO): OpenCascadeSolid {
    if (radius <= 0) throw new Error('Sphere radius must be positive.');
    return this.makeWithAxes(center, (axes) => {
      const maker = new this.oc.BRepPrimAPI_MakeSphere_9(axes, radius);
      const shape = maker.Shape();
      maker.delete();
      return shape;
    });
  }

  makeTorus(majorRadius: number, tubeRadius: number, center: Point3 = ZERO): OpenCascadeSolid {
    if (majorRadius <= 0 || tubeRadius <= 0 || tubeRadius >= majorRadius) {
      throw new Error('Torus radii must be positive and the tube radius smaller than the major radius.');
    }
    return this.makeWithAxes(center, (axes) => {
      const maker = new this.oc.BRepPrimAPI_MakeTorus_5(axes, majorRadius, tubeRadius);
      const shape = maker.Shape();
      maker.delete();
      return shape;
    });
  }

  makeWedge(size: Point3, origin: Point3 = ZERO): OpenCascadeSolid {
    if (size.x <= 0 || size.y <= 0 || size.z <= 0) throw new Error('Wedge dimensions must be positive.');
    return this.makeWithAxes(origin, (axes) => {
      // A zero top X length is the triangular prism used by MyCAD's WEDGE.
      const maker = new this.oc.BRepPrimAPI_MakeWedge_2(axes, size.x, size.y, size.z, 0);
      const shape = maker.Shape();
      maker.delete();
      return shape;
    });
  }

  makePyramid(radius: number, height: number, center: Point3 = ZERO): OpenCascadeSolid {
    this.validateRadialPrimitive(radius, height, 'Pyramid');
    const points = Array.from({ length: 4 }, (_unused, index) => {
      const angle = Math.PI / 4 + index * Math.PI / 2;
      return new this.oc.gp_Pnt_3(
        center.x + Math.cos(angle) * radius,
        center.y + Math.sin(angle) * radius,
        center.z,
      );
    });
    const polygon = new this.oc.BRepBuilderAPI_MakePolygon_4(
      points[0], points[1], points[2], points[3], true,
    );
    const wire = polygon.Wire();
    const apexPoint = new this.oc.gp_Pnt_3(center.x, center.y, center.z + height);
    const apexMaker = new this.oc.BRepBuilderAPI_MakeVertex(apexPoint);
    const apex = apexMaker.Vertex();
    const loft = new this.oc.BRepOffsetAPI_ThruSections(true, true, 1e-7);
    loft.CheckCompatibility(false);
    loft.AddWire(wire);
    loft.AddVertex(apex);
    const progress = new this.oc.Message_ProgressRange_1();
    loft.Build(progress);
    progress.delete();
    const shape = loft.Shape();

    loft.delete();
    apex.delete();
    apexMaker.delete();
    apexPoint.delete();
    wire.delete();
    polygon.delete();
    points.forEach((point) => point.delete());
    if (shape.IsNull()) {
      shape.delete();
      throw new Error('OpenCascade failed to create the pyramid.');
    }
    return this.wrap(shape);
  }

  fromMesh(positions: ArrayLike<number>, indices: ArrayLike<number>): OpenCascadeSolid {
    if (positions.length < 12 || positions.length % 3 !== 0 || indices.length < 12 || indices.length % 3 !== 0) {
      throw new Error('A faceted solid requires a non-empty triangle mesh.');
    }
    let extent = 1;
    for (let index = 0; index < positions.length; index++) extent = Math.max(extent, Math.abs(positions[index]));
    const sewing = new this.oc.BRepBuilderAPI_Sewing(extent * 1e-7, true, true, true, false);
    const points: InstanceType<typeof this.oc.gp_Pnt_3>[] = [];
    const polygons: InstanceType<typeof this.oc.BRepBuilderAPI_MakePolygon_3>[] = [];
    const wires: ReturnType<InstanceType<typeof this.oc.BRepBuilderAPI_MakePolygon_3>['Wire']>[] = [];
    const faceMakers: InstanceType<typeof this.oc.BRepBuilderAPI_MakeFace_15>[] = [];
    const faces: ReturnType<InstanceType<typeof this.oc.BRepBuilderAPI_MakeFace_15>['Face']>[] = [];
    let progress: InstanceType<typeof this.oc.Message_ProgressRange_1> | null = null;
    let sewed: TopoDS_Shape | null = null;
    const shells: TopoDS_Shape[] = [];
    const typedShells: ReturnType<typeof this.oc.TopoDS.Shell_1>[] = [];
    let solidMaker: InstanceType<typeof this.oc.BRepBuilderAPI_MakeSolid_1> | null = null;
    let solid: ReturnType<InstanceType<typeof this.oc.BRepBuilderAPI_MakeSolid_1>['Solid']> | null = null;
    try {
      for (let offset = 0; offset < indices.length; offset += 3) {
        const vertexIds = [indices[offset], indices[offset + 1], indices[offset + 2]];
        if (vertexIds.some((id) => !Number.isInteger(id) || id < 0 || id * 3 + 2 >= positions.length)) {
          throw new Error('Triangle mesh contains an invalid vertex index.');
        }
        const trianglePoints = vertexIds.map((id) => {
          const point = new this.oc.gp_Pnt_3(positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]);
          points.push(point);
          return point;
        });
        const polygon = new this.oc.BRepBuilderAPI_MakePolygon_3(
          trianglePoints[0], trianglePoints[1], trianglePoints[2], true,
        );
        polygons.push(polygon);
        if (!polygon.IsDone()) throw new Error('OpenCascade could not build a mesh triangle.');
        const wire = polygon.Wire();
        wires.push(wire);
        const faceMaker = new this.oc.BRepBuilderAPI_MakeFace_15(wire, true);
        faceMakers.push(faceMaker);
        if (!faceMaker.IsDone()) throw new Error('OpenCascade could not build a mesh face.');
        const face = faceMaker.Face();
        faces.push(face);
        sewing.Add(face);
      }
      progress = new this.oc.Message_ProgressRange_1();
      sewing.Perform(progress);
      if (sewing.NbFreeEdges() !== 0 || sewing.NbMultipleEdges() !== 0) {
        throw new Error('Triangle mesh is not a closed two-manifold body.');
      }
      sewed = sewing.SewedShape();
      if (sewed.IsNull()) throw new Error('OpenCascade could not sew the triangle mesh.');
      if (sewed.ShapeType() === this.oc.TopAbs_ShapeEnum.TopAbs_SHELL as unknown as TopAbs_ShapeEnum) {
        shells.push(this.copyShape(sewed));
      } else {
        shells.push(...this.subShapes(sewed, this.oc.TopAbs_ShapeEnum.TopAbs_SHELL));
      }
      if (shells.length === 0) throw new Error('The sewn mesh contains no closed shell.');
      solidMaker = new this.oc.BRepBuilderAPI_MakeSolid_1();
      for (const shellShape of shells) {
        const shell = this.oc.TopoDS.Shell_1(shellShape);
        typedShells.push(shell);
        solidMaker.Add(shell);
      }
      if (!solidMaker.IsDone()) throw new Error('OpenCascade could not make a solid from the sewn mesh.');
      solid = solidMaker.Solid();
      this.oc.BRepLib.OrientClosedSolid(solid);
      const analyzer = new this.oc.BRepCheck_Analyzer(solid, true, false);
      const valid = analyzer.IsValid_2();
      analyzer.delete();
      if (!valid) throw new Error('The faceted B-rep converted from the mesh is invalid.');
      const result = this.copyShape(solid);
      return this.wrap(result);
    } finally {
      solid?.delete();
      solidMaker?.delete();
      typedShells.forEach((shell) => shell.delete());
      shells.forEach((shell) => shell.delete());
      sewed?.delete();
      progress?.delete();
      sewing.delete();
      faces.forEach((face) => face.delete());
      faceMakers.forEach((maker) => maker.delete());
      wires.forEach((wire) => wire.delete());
      polygons.forEach((polygon) => polygon.delete());
      points.forEach((point) => point.delete());
    }
  }

  extrudePolygon(profile: readonly Point3[], vector: Point3): OpenCascadeSolid {
    if (profile.length < 3) throw new Error('Extrusion profile requires at least three points.');
    this.validateVector(vector, 'Extrusion');
    const points = profile.map((point) => new this.oc.gp_Pnt_3(point.x, point.y, point.z));
    const polygon = new this.oc.BRepBuilderAPI_MakePolygon_1();
    let wire: ReturnType<typeof polygon.Wire> | null = null;
    let faceMaker: InstanceType<typeof this.oc.BRepBuilderAPI_MakeFace_15> | null = null;
    let face: ReturnType<InstanceType<typeof this.oc.BRepBuilderAPI_MakeFace_15>['Face']> | null = null;
    let prismVector: InstanceType<typeof this.oc.gp_Vec_4> | null = null;
    let prism: InstanceType<typeof this.oc.BRepPrimAPI_MakePrism_1> | null = null;
    try {
      points.forEach((point) => polygon.Add_1(point));
      polygon.Close();
      if (!polygon.IsDone()) throw new Error('OpenCascade could not close the extrusion profile.');
      wire = polygon.Wire();
      faceMaker = new this.oc.BRepBuilderAPI_MakeFace_15(wire, true);
      if (!faceMaker.IsDone()) throw new Error('OpenCascade could not create the extrusion face.');
      face = faceMaker.Face();
      prismVector = new this.oc.gp_Vec_4(vector.x, vector.y, vector.z);
      prism = new this.oc.BRepPrimAPI_MakePrism_1(face, prismVector, true, true);
      const shape = prism.Shape();
      if (shape.IsNull()) {
        shape.delete();
        throw new Error('OpenCascade failed to extrude the polygon.');
      }
      return this.wrap(shape);
    } finally {
      prism?.delete();
      prismVector?.delete();
      face?.delete();
      faceMaker?.delete();
      wire?.delete();
      polygon.delete();
      points.forEach((point) => point.delete());
    }
  }

  /** Extrudes a closed loop of exact edges — lines, arcs, Bezier curves, any mix
   *  — the same way `extrudePolygon` extrudes a straight-edged one, so a closed
   *  spline profile keeps its true curved boundary instead of being faceted. */
  extrudeWire(edges: readonly SweepPathSegment3[], vector: Point3): OpenCascadeSolid {
    if (edges.length === 0) throw new Error('Extrusion profile requires at least one edge.');
    this.validateVector(vector, 'Extrusion');
    const owned: Array<{ delete(): void }> = [];
    let wire: TopoDS_Wire | null = null;
    let faceMaker: InstanceType<typeof this.oc.BRepBuilderAPI_MakeFace_15> | null = null;
    let face: ReturnType<InstanceType<typeof this.oc.BRepBuilderAPI_MakeFace_15>['Face']> | null = null;
    let prismVector: InstanceType<typeof this.oc.gp_Vec_4> | null = null;
    let prism: InstanceType<typeof this.oc.BRepPrimAPI_MakePrism_1> | null = null;
    try {
      wire = this.buildWireFromEdges(edges, owned, 'OpenCascade could not close the extrusion profile.');
      faceMaker = new this.oc.BRepBuilderAPI_MakeFace_15(wire, true);
      if (!faceMaker.IsDone()) throw new Error('OpenCascade could not create the extrusion face.');
      face = faceMaker.Face();
      prismVector = new this.oc.gp_Vec_4(vector.x, vector.y, vector.z);
      prism = new this.oc.BRepPrimAPI_MakePrism_1(face, prismVector, true, true);
      const shape = prism.Shape();
      if (shape.IsNull() || !this.hasSolid(shape)) {
        shape.delete();
        throw new Error('OpenCascade failed to extrude the wire profile.');
      }
      return this.wrap(shape);
    } finally {
      prism?.delete();
      prismVector?.delete();
      face?.delete();
      faceMaker?.delete();
      wire?.delete();
      for (let index = owned.length - 1; index >= 0; index--) owned[index].delete();
    }
  }

  extrudeRegion(loops: readonly (readonly Point3[])[], vector: Point3): OpenCascadeSolid {
    if (loops.length === 0 || loops.some((loop) => loop.length < 3)) {
      throw new Error('Extrusion region requires one outer loop and valid optional holes.');
    }
    this.validateVector(vector, 'Extrusion');
    const points: InstanceType<typeof this.oc.gp_Pnt_3>[] = [];
    const polygons: InstanceType<typeof this.oc.BRepBuilderAPI_MakePolygon_1>[] = [];
    const wires: ReturnType<InstanceType<typeof this.oc.BRepBuilderAPI_MakePolygon_1>['Wire']>[] = [];
    let faceMaker: InstanceType<typeof this.oc.BRepBuilderAPI_MakeFace_15> | null = null;
    let face: ReturnType<InstanceType<typeof this.oc.BRepBuilderAPI_MakeFace_15>['Face']> | null = null;
    let prismVector: InstanceType<typeof this.oc.gp_Vec_4> | null = null;
    let prism: InstanceType<typeof this.oc.BRepPrimAPI_MakePrism_1> | null = null;
    try {
      for (const loop of loops) {
        const polygon = new this.oc.BRepBuilderAPI_MakePolygon_1();
        polygons.push(polygon);
        for (const value of loop) {
          const point = new this.oc.gp_Pnt_3(value.x, value.y, value.z);
          points.push(point);
          polygon.Add_1(point);
        }
        polygon.Close();
        if (!polygon.IsDone()) throw new Error('OpenCascade could not close an extrusion-region loop.');
        wires.push(polygon.Wire());
      }
      faceMaker = new this.oc.BRepBuilderAPI_MakeFace_15(wires[0], true);
      for (let index = 1; index < wires.length; index++) faceMaker.Add(wires[index]);
      if (!faceMaker.IsDone()) throw new Error('OpenCascade could not create the extrusion region.');
      face = faceMaker.Face();
      prismVector = new this.oc.gp_Vec_4(vector.x, vector.y, vector.z);
      prism = new this.oc.BRepPrimAPI_MakePrism_1(face, prismVector, true, true);
      const shape = prism.Shape();
      if (shape.IsNull() || !this.hasSolid(shape)) {
        shape.delete();
        throw new Error('OpenCascade failed to extrude the region.');
      }
      return this.wrap(shape);
    } finally {
      prism?.delete();
      prismVector?.delete();
      face?.delete();
      faceMaker?.delete();
      wires.forEach((wire) => wire.delete());
      polygons.forEach((polygon) => polygon.delete());
      points.forEach((point) => point.delete());
    }
  }

  extrudeCircle(radius: number, center: Point3, vector: Point3): OpenCascadeSolid {
    if (radius <= 0) throw new Error('Circle extrusion radius must be positive.');
    this.validateVector(vector, 'Extrusion');
    const point = new this.oc.gp_Pnt_3(center.x, center.y, center.z);
    const normal = new this.oc.gp_Dir_4(0, 0, 1);
    const xDirection = new this.oc.gp_Dir_4(1, 0, 0);
    const axes = new this.oc.gp_Ax2_2(point, normal, xDirection);
    const circle = new this.oc.gp_Circ_2(axes, radius);
    const edgeMaker = new this.oc.BRepBuilderAPI_MakeEdge_8(circle);
    const edge = edgeMaker.Edge();
    const wireMaker = new this.oc.BRepBuilderAPI_MakeWire_2(edge);
    const wire = wireMaker.Wire();
    const faceMaker = new this.oc.BRepBuilderAPI_MakeFace_15(wire, true);
    const face = faceMaker.Face();
    const prismVector = new this.oc.gp_Vec_4(vector.x, vector.y, vector.z);
    const prism = new this.oc.BRepPrimAPI_MakePrism_1(face, prismVector, true, true);
    const shape = prism.Shape();

    prism.delete();
    prismVector.delete();
    face.delete();
    faceMaker.delete();
    wire.delete();
    wireMaker.delete();
    edge.delete();
    edgeMaker.delete();
    circle.delete();
    axes.delete();
    xDirection.delete();
    normal.delete();
    point.delete();
    if (shape.IsNull()) {
      shape.delete();
      throw new Error('OpenCascade failed to extrude the circle.');
    }
    return this.wrap(shape);
  }

  loftPolygons(sections: readonly (readonly Point3[])[]): OpenCascadeSolid {
    if (sections.length < 2 || sections.some((section) => section.length < 3)) {
      throw new Error('Loft requires at least two polygon sections.');
    }
    const points: InstanceType<typeof this.oc.gp_Pnt_3>[] = [];
    const polygons: InstanceType<typeof this.oc.BRepBuilderAPI_MakePolygon_1>[] = [];
    const wires: ReturnType<InstanceType<typeof this.oc.BRepBuilderAPI_MakePolygon_1>['Wire']>[] = [];
    const loft = new this.oc.BRepOffsetAPI_ThruSections(true, true, 1e-7);
    let progress: InstanceType<typeof this.oc.Message_ProgressRange_1> | null = null;
    try {
      loft.CheckCompatibility(true);
      for (const section of sections) {
        const polygon = new this.oc.BRepBuilderAPI_MakePolygon_1();
        polygons.push(polygon);
        for (const value of section) {
          const point = new this.oc.gp_Pnt_3(value.x, value.y, value.z);
          points.push(point);
          polygon.Add_1(point);
        }
        polygon.Close();
        if (!polygon.IsDone()) throw new Error('OpenCascade could not close a loft section.');
        const wire = polygon.Wire();
        wires.push(wire);
        loft.AddWire(wire);
      }
      progress = new this.oc.Message_ProgressRange_1();
      loft.Build(progress);
      const shape = loft.Shape();
      if (shape.IsNull()) {
        shape.delete();
        throw new Error('OpenCascade failed to loft the polygon sections.');
      }
      return this.wrap(shape);
    } finally {
      progress?.delete();
      loft.delete();
      wires.forEach((wire) => wire.delete());
      polygons.forEach((polygon) => polygon.delete());
      points.forEach((point) => point.delete());
    }
  }

  /**
   * The general LOFT: each section can be a circle or a closed Bezier wire,
   * not only a straight-edged polygon — `makeSweepProfileWire` already knows
   * how to build all three, since SWEEP's own profile needed exactly that.
   */
  loftProfiles(sections: readonly SweepProfile3[]): OpenCascadeSolid {
    if (sections.length < 2) throw new Error('Loft requires at least two sections.');
    const owned: Array<{ delete(): void }> = [];
    const wires: TopoDS_Wire[] = [];
    const loft = new this.oc.BRepOffsetAPI_ThruSections(true, true, 1e-7);
    let progress: InstanceType<typeof this.oc.Message_ProgressRange_1> | null = null;
    try {
      loft.CheckCompatibility(true);
      for (const section of sections) {
        const wire = this.makeSweepProfileWire(section, owned);
        wires.push(wire);
        loft.AddWire(wire);
      }
      progress = new this.oc.Message_ProgressRange_1();
      loft.Build(progress);
      const shape = loft.Shape();
      if (shape.IsNull()) {
        shape.delete();
        throw new Error('OpenCascade failed to loft the sections.');
      }
      return this.wrap(shape);
    } finally {
      progress?.delete();
      loft.delete();
      // Deliberately not disposing `owned` here, unlike every other builder
      // in this file: a ThruSections result — unique among them — keeps live
      // references into a Bezier/arc section's own curve objects (not just
      // their pole values), so deleting `owned` right after `Build()` leaves
      // the returned shape holding a dangling reference. Confirmed directly:
      // the very same section wires, lofted the very same way, only crash
      // (an embind "table index is out of bounds"/"function signature
      // mismatch" inside later OCCT calls like inspect()'s bounding box) once
      // `owned` is disposed — never while it is kept alive. A polygon or
      // circle section never touches this path (their edges don't hold onto
      // a separate curve object the way a Bezier/arc one does), which is why
      // this went unnoticed until LOFT's own Bezier profiles became
      // reachable. The leak this trades for — a handful of small point/curve
      // objects per LOFT call — is a better trade than crashing.
    }
  }

  /**
   * AutoCAD LOFT's "Path" option: instead of straight-interpolating between
   * sections (loftProfiles/ThruSections), each section rides along one guide
   * curve — a shape that morphs from the first cross-section to the last as
   * it follows the path, same underlying operation SWEEP's own single-profile
   * pipe is a special case of.
   */
  loftAlongPath(
    sections: readonly SweepProfile3[],
    path: readonly SweepPathSegment3[],
    fixedOrientation?: { origin: Point3; normal: Point3; xAxis: Point3 },
  ): OpenCascadeSolid {
    // A single section is a real case, not a degenerate one: a single closed
    // profile bent along a path (confirmed directly — MakePipeShell handles
    // one profile natively; the two-or-more requirement only ever applied to
    // straight-interpolating loftProfiles/ThruSections).
    if (sections.length < 1) throw new Error('Loft along a path requires at least one section.');
    if (path.length === 0) throw new Error('Loft path requires at least one segment.');

    const owned: Array<{ delete(): void }> = [];
    const wires: TopoDS_Wire[] = [];
    let spine: TopoDS_Wire | null = null;
    let maker: InstanceType<typeof this.oc.BRepOffsetAPI_MakePipeShell> | null = null;
    let progress: InstanceType<typeof this.oc.Message_ProgressRange_1> | null = null;
    try {
      spine = this.buildWireFromEdges(path, owned, 'OpenCascade could not join the loft path.');
      maker = new this.oc.BRepOffsetAPI_MakePipeShell(spine);
      if (fixedOrientation) {
        // The default (Frenet-tracking) mode rotates the section to follow
        // the spine's own tangent at every point — right for a pipe, wrong
        // for bending a flat silhouette that is meant to keep roughly its
        // own orientation throughout. Confirmed directly: the default mode
        // let a gently-curved path balloon a profile's own bounding box by
        // tens of units past its flat original size, in both the sweep
        // direction and out of plane; pinning the section's frame to its own
        // original plane instead keeps the result close to that original
        // size, only genuinely bent by the path.
        const origin = new this.oc.gp_Pnt_3(fixedOrientation.origin.x, fixedOrientation.origin.y, fixedOrientation.origin.z);
        const mainDir = new this.oc.gp_Dir_4(fixedOrientation.normal.x, fixedOrientation.normal.y, fixedOrientation.normal.z);
        const xDir = new this.oc.gp_Dir_4(fixedOrientation.xAxis.x, fixedOrientation.xAxis.y, fixedOrientation.xAxis.z);
        const axis = new this.oc.gp_Ax2_2(origin, mainDir, xDir);
        maker.SetMode_2(axis);
        owned.push(origin, mainDir, xDir, axis);
      }
      for (const section of sections) {
        const wire = this.makeSweepProfileWire(section, owned);
        wires.push(wire);
        maker.Add_1(wire, false, false);
      }
      progress = new this.oc.Message_ProgressRange_1();
      maker.Build(progress);
      if (!maker.IsReady()) throw new Error('OpenCascade could not build the guided loft.');
      maker.MakeSolid();
      const shape = maker.Shape();
      if (shape.IsNull() || !this.hasSolid(shape)) {
        shape.delete();
        throw new Error('The guided loft did not produce a solid.');
      }
      return this.wrap(shape);
    } finally {
      progress?.delete();
      maker?.delete();
      wires.forEach((wire) => wire.delete());
      spine?.delete();
      owned.reverse().forEach((item) => item.delete());
    }
  }

  /**
   * AutoCAD LOFT's "Guides" option — see GeometryKernel.loftGuidedSurface's
   * own doc comment for the shape of the problem this solves. Builds one
   * Coons-style surface patch per strip between consecutive guide touch
   * points (plus the two end strips against each rail's own true corner),
   * and sews all patches into one open shell.
   *
   * OCCT's own loft (BRepOffsetAPI_ThruSections, used by loftProfiles/
   * loftAlongPath) has no guide-curve support at all — confirmed directly
   * against the bound API surface, not just its docs — so this is built
   * from GeomFill_BSplineCurves (a Coons-style 2/3/4-boundary-curve surface
   * fill) instead, one strip at a time. A guide only ever touches each rail
   * at ONE point (the middle of both curves, not their shared corner), so
   * each strip is filled between whichever of: the two rails' own true
   * corner (no guide there), or a guide (touching both rails once).
   */
  loftGuidedSurface(
    rail1: readonly SweepPathSegment3[],
    rail2: readonly SweepPathSegment3[],
    guides: readonly (readonly SweepPathSegment3[])[],
  ): OpenCascadeSolid {
    if (rail1.length === 0 || rail2.length === 0) throw new Error('Loft with guides requires two open rail curves.');
    const owned: Array<{ delete(): void }> = [];
    let sewing: InstanceType<typeof this.oc.BRepBuilderAPI_Sewing> | null = null;
    let progress: InstanceType<typeof this.oc.Message_ProgressRange_1> | null = null;
    try {
      const rail1Wire = this.buildWireFromEdges(rail1, owned, 'OpenCascade could not join the first guided-loft rail.');
      const rail2Wire = this.buildWireFromEdges(rail2, owned, 'OpenCascade could not join the second guided-loft rail.');
      const c1 = this.wireToCompositeBSpline(rail1Wire, owned);
      const c2 = this.wireToCompositeBSpline(rail2Wire, owned);
      const c1Curve = c1.get();
      const c2Curve = c2.get();
      const c1Start = c1Curve.StartPoint();
      const c1End = c1Curve.EndPoint();
      const c2Start = c2Curve.StartPoint();
      const c2End = c2Curve.EndPoint();

      // Coincidence tolerance between the two rails' own endpoints — looser
      // than GeomFill's own internal tolerance (which the later per-strip
      // pole-snap satisfies exactly), just to detect which of the two rails'
      // ends correspond to each other at all.
      const CORNER_TOLERANCE = 1e-2;
      const distance = (a: gp_Pnt, b: gp_Pnt): number => Math.hypot(a.X() - b.X(), a.Y() - b.Y(), a.Z() - b.Z());

      type Boundary = {
        u1: number;
        u2: number;
        snap1: gp_Pnt;
        snap2: gp_Pnt;
        // Oriented rail1-side -> rail2-side; null at the rails' own true
        // corners, where there is no guide to fill that gap.
        guide: Handle_Geom_BSplineCurve | null;
      };

      const sameDirection = distance(c1Start, c2Start) <= CORNER_TOLERANCE && distance(c1End, c2End) <= CORNER_TOLERANCE;
      const crossDirection = distance(c1Start, c2End) <= CORNER_TOLERANCE && distance(c1End, c2Start) <= CORNER_TOLERANCE;
      if (!sameDirection && !crossDirection) {
        throw new Error('Loft with guides requires two rails that share both their own endpoints (e.g. one curve mirrored into the other).');
      }
      const u2AtRailStart = sameDirection ? c2Curve.FirstParameter() : c2Curve.LastParameter();
      const u2AtRailEnd = sameDirection ? c2Curve.LastParameter() : c2Curve.FirstParameter();

      const boundaries: Boundary[] = [
        { u1: c1Curve.FirstParameter(), u2: u2AtRailStart, snap1: c1Start, snap2: c1Start, guide: null },
        { u1: c1Curve.LastParameter(), u2: u2AtRailEnd, snap1: c1End, snap2: c1End, guide: null },
      ];

      for (const guideEdges of guides) {
        if (guideEdges.length === 0) continue;
        const guideWire = this.buildWireFromEdges(guideEdges, owned, 'OpenCascade could not join a loft guide curve.');
        const guideComposite = this.wireToCompositeBSpline(guideWire, owned);
        const guideCurve = guideComposite.get();
        const guideStart = guideCurve.StartPoint();
        const guideEnd = guideCurve.EndPoint();
        // Which end of the guide touches rail1 vs rail2 -- by nearest
        // distance, not an assumed order (a hand-drawn guide can run either way).
        const startNearRail1 = Math.min(distance(guideStart, c1Start), distance(guideStart, c1End))
          <= Math.min(distance(guideEnd, c1Start), distance(guideEnd, c1End));
        const rail1Point = startNearRail1 ? guideStart : guideEnd;
        const rail2Point = startNearRail1 ? guideEnd : guideStart;
        const u1 = this.projectPointParam(c1, rail1Point);
        const u2 = this.projectPointParam(c2, rail2Point);
        const orientedGuide = this.trimBSplineBetween(guideComposite, guideCurve.FirstParameter(), guideCurve.LastParameter(), startNearRail1);
        boundaries.push({ u1, u2, snap1: rail1Point, snap2: rail2Point, guide: orientedGuide });
      }
      boundaries.sort((a, b) => a.u1 - b.u1);

      const faces: TopoDS_Face[] = [];
      for (let index = 0; index + 1 < boundaries.length; index++) {
        const a = boundaries[index];
        const b = boundaries[index + 1];
        const rail1Seg = this.trimBSplineBetween(c1, a.u1, b.u1, true);
        this.snapPole(rail1Seg, true, a.snap1);
        this.snapPole(rail1Seg, false, b.snap1);
        const rail2Lo = Math.min(a.u2, b.u2);
        const rail2Hi = Math.max(a.u2, b.u2);
        // Start at whichever end is boundary b's own touch point, so the
        // strip's four sides connect tip-to-tail all the way around.
        const rail2Sense = b.u2 < a.u2;
        const rail2Seg = this.trimBSplineBetween(c2, rail2Lo, rail2Hi, rail2Sense);
        this.snapPole(rail2Seg, true, b.snap2);
        this.snapPole(rail2Seg, false, a.snap2);

        const style = this.oc.GeomFill_FillingStyle.GeomFill_CoonsStyle as unknown as GeomFill_FillingStyle;
        let surface: ReturnType<InstanceType<typeof this.oc.GeomFill_BSplineCurves>['Surface']>;
        if (!a.guide && !b.guide) {
          const filler = new this.oc.GeomFill_BSplineCurves_4(rail1Seg, rail2Seg, style);
          owned.push(filler);
          surface = filler.Surface();
        } else if (a.guide && b.guide) {
          const aGuideReversed = this.reverseBSpline(a.guide);
          const filler = new this.oc.GeomFill_BSplineCurves_2(rail1Seg, b.guide, rail2Seg, aGuideReversed, style);
          owned.push(filler);
          surface = filler.Surface();
        } else if (b.guide) {
          // Corner at a, guide at b: the guide already runs rail1-touch ->
          // rail2-touch, sitting naturally between rail1Seg's end and
          // rail2Seg's start.
          const filler = new this.oc.GeomFill_BSplineCurves_3(rail1Seg, b.guide, rail2Seg, style);
          owned.push(filler);
          surface = filler.Surface();
        } else {
          // Guide at a, corner at b: there is no boundary curve between
          // rail1Seg's end and rail2Seg's start (both land on the same true
          // corner point already) — the guide instead closes the LAST gap,
          // from rail2Seg's end back to rail1Seg's start, so it needs to run
          // rail2-touch -> rail1-touch: the reverse of its own orientation.
          const oriented = this.reverseBSpline(a.guide!);
          const filler = new this.oc.GeomFill_BSplineCurves_3(rail1Seg, rail2Seg, oriented, style);
          owned.push(filler);
          surface = filler.Surface();
        }
        if (surface.IsNull()) throw new Error('OpenCascade could not fill a guided-loft patch.');
        const surfaceBase = new this.oc.Handle_Geom_Surface_2(surface.get());
        const faceMaker = new this.oc.BRepBuilderAPI_MakeFace_8(surfaceBase, 1e-6);
        owned.push(surfaceBase, faceMaker);
        const face = faceMaker.Face();
        if (face.IsNull()) throw new Error('OpenCascade could not build a guided-loft patch face.');
        faces.push(face);
      }

      sewing = new this.oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false);
      progress = new this.oc.Message_ProgressRange_1();
      for (const face of faces) sewing.Add(face);
      sewing.Perform(progress);
      const shape = sewing.SewedShape();
      if (shape.IsNull()) {
        shape.delete();
        throw new Error('OpenCascade could not stitch the guided-loft patches together.');
      }
      return this.wrap(shape);
    } finally {
      progress?.delete();
      sewing?.delete();
      // Same deliberate small leak as loftProfiles, and for the same reason:
      // the composite/trimmed curve objects built above keep live references
      // into the wires' own edge curves, so disposing `owned` here risks the
      // exact "dangling reference" crash documented on loftProfiles.
    }
  }

  /** Joins a wire's chain of edges (line/arc/Bezier, any mix) into one
   *  composite Geom_BSplineCurve, so it can be projected onto, trimmed, or
   *  fed into a GeomFill surface builder as a single curve. */
  private wireToCompositeBSpline(wire: TopoDS_Wire, owned: Array<{ delete(): void }>): Handle_Geom_BSplineCurve {
    const explorer = new this.oc.TopExp_Explorer_2(
      wire,
      this.oc.TopAbs_ShapeEnum.TopAbs_EDGE as unknown as TopAbs_ShapeEnum,
      this.oc.TopAbs_ShapeEnum.TopAbs_SHAPE as unknown as TopAbs_ShapeEnum,
    );
    owned.push(explorer);
    let composite: InstanceType<typeof this.oc.GeomConvert_CompCurveToBSplineCurve_2> | null = null;
    while (explorer.More()) {
      const edge = this.oc.TopoDS.Edge_1(explorer.Current());
      const first = { current: 0 };
      const last = { current: 0 };
      // BRep_Tool.Curve_2 returns the edge's UNDERLYING curve at full extent
      // (e.g. a whole circle for one arc edge) plus the edge's own [first,
      // last] trim range as out-params — trimming explicitly here is what
      // keeps a single-edge arc guide from silently becoming a full circle.
      // opencascade.js types these out-params as plain numbers although the
      // binding actually mutates a passed-in ref object at runtime — same
      // embind/`.d.ts` mismatch as the TopAbs_ShapeEnum casts above.
      const curveHandle = this.oc.BRep_Tool.Curve_2(edge, first as unknown as number, last as unknown as number);
      const trimmedHandle = new this.oc.Handle_Geom_Curve_2(new this.oc.Geom_TrimmedCurve(curveHandle, first.current, last.current, true, true));
      const bspline = this.oc.GeomConvert.CurveToBSplineCurve(
        trimmedHandle,
        this.oc.Convert_ParameterisationType.Convert_QuasiAngular as unknown as Convert_ParameterisationType,
      );
      const bounded = new this.oc.Handle_Geom_BoundedCurve_2(bspline.get());
      owned.push(edge, trimmedHandle, bspline, bounded);
      if (!composite) {
        composite = new this.oc.GeomConvert_CompCurveToBSplineCurve_2(
          bounded,
          this.oc.Convert_ParameterisationType.Convert_QuasiAngular as unknown as Convert_ParameterisationType,
        );
      } else composite.Add_1(bounded, 1e-4, true, false, 1);
      explorer.Next();
    }
    if (!composite) throw new Error('OpenCascade found no edges in a guided-loft curve.');
    owned.push(composite);
    return composite.BSplineCurve();
  }

  /** The parameter on `curveHandle` nearest `point` — used to find where a
   *  guide curve actually touches a rail. */
  private projectPointParam(curveHandle: Handle_Geom_BSplineCurve, point: gp_Pnt): number {
    const asCurve = new this.oc.Handle_Geom_Curve_2(curveHandle.get());
    const projector = new this.oc.GeomAPI_ProjectPointOnCurve_2(point, asCurve);
    return projector.LowerDistanceParameter();
  }

  /** `curveHandle` trimmed to [u1, u2] (u1 <= u2) and re-expressed as its own
   *  Geom_BSplineCurve, traversed low-to-high when `sense` or high-to-low
   *  otherwise — the building block both a rail's own sub-segment and a
   *  guide's oriented copy are built from. */
  private trimBSplineBetween(curveHandle: Handle_Geom_BSplineCurve, u1: number, u2: number, sense: boolean): Handle_Geom_BSplineCurve {
    const asCurve = new this.oc.Handle_Geom_Curve_2(curveHandle.get());
    const trimmedCurve = new this.oc.Geom_TrimmedCurve(asCurve, u1, u2, sense, true);
    const asTrimmedCurve = new this.oc.Handle_Geom_Curve_2(trimmedCurve);
    return this.oc.GeomConvert.CurveToBSplineCurve(
      asTrimmedCurve,
      this.oc.Convert_ParameterisationType.Convert_QuasiAngular as unknown as Convert_ParameterisationType,
    );
  }

  private reverseBSpline(curveHandle: Handle_Geom_BSplineCurve): Handle_Geom_BSplineCurve {
    const curve = curveHandle.get();
    return this.trimBSplineBetween(curveHandle, curve.FirstParameter(), curve.LastParameter(), false);
  }

  /** Moves a BSpline's own start or end pole exactly onto `target` — real
   *  hand-drawn geometry only has a guide touching a rail at its NEAREST
   *  point, not bit-identical to it, which is well within a real part's own
   *  tolerance but not within GeomFill_BSplineCurves' much tighter internal
   *  coincidence check ("Courbes non jointives" otherwise). */
  private snapPole(curveHandle: Handle_Geom_BSplineCurve, atStart: boolean, target: gp_Pnt): void {
    const curve = curveHandle.get();
    const index = atStart ? 1 : curve.NbPoles();
    curve.SetPole_1(index, target);
  }

  sweep(profile: SweepProfile3, path: readonly SweepPathSegment3[]): OpenCascadeSolid {
    if (path.length === 0) throw new Error('Sweep path requires at least one segment.');

    const owned: Array<{ delete(): void }> = [];
    let spine: TopoDS_Wire | null = null;
    let profileWire: TopoDS_Wire | null = null;
    let profileFaceMaker: InstanceType<typeof this.oc.BRepBuilderAPI_MakeFace_15> | null = null;
    let profileFace: ReturnType<InstanceType<typeof this.oc.BRepBuilderAPI_MakeFace_15>['Face']> | null = null;
    let pipe: InstanceType<typeof this.oc.BRepOffsetAPI_MakePipe_1> | null = null;
    let progress: InstanceType<typeof this.oc.Message_ProgressRange_1> | null = null;
    try {
      spine = this.buildWireFromEdges(path, owned, 'OpenCascade could not join the sweep path.');

      profileWire = this.makeSweepProfileWire(profile, owned);
      profileFaceMaker = new this.oc.BRepBuilderAPI_MakeFace_15(profileWire, true);
      if (!profileFaceMaker.IsDone()) throw new Error('OpenCascade could not create the sweep profile face.');
      profileFace = profileFaceMaker.Face();

      pipe = new this.oc.BRepOffsetAPI_MakePipe_1(spine, profileFace);
      progress = new this.oc.Message_ProgressRange_1();
      pipe.Build(progress);
      if (!pipe.IsDone()) throw new Error('OpenCascade failed to sweep the profile along the path.');
      const shape = pipe.Shape();
      if (shape.IsNull() || !this.hasSolid(shape)) {
        shape.delete();
        throw new Error('The sweep did not produce a solid.');
      }
      return this.wrap(shape);
    } finally {
      progress?.delete();
      pipe?.delete();
      profileFace?.delete();
      profileFaceMaker?.delete();
      profileWire?.delete();
      spine?.delete();
      for (let index = owned.length - 1; index >= 0; index--) owned[index].delete();
    }
  }

  fillet(solid: OpenCascadeSolid, reference: EdgeReference3, radius: number): OpenCascadeSolid {
    if (!Number.isFinite(radius) || radius <= 0) throw new Error('Fillet radius must be positive.');
    const selected = this.edgeByFaces(solid.shape(this), reference);
    const maker = new this.oc.BRepFilletAPI_MakeFillet(
      solid.shape(this),
      this.oc.ChFi3d_FilletShape.ChFi3d_Rational as unknown as ChFi3d_FilletShape,
    );
    const progress = new this.oc.Message_ProgressRange_1();
    try {
      maker.Add_2(radius, selected.edge);
      maker.Build(progress);
      if (!maker.IsDone()) throw new Error('OpenCascade failed to fillet the selected edge.');
      const shape = maker.Shape();
      if (shape.IsNull() || !this.hasSolid(shape)) {
        shape.delete();
        throw new Error('Fillet did not produce a solid.');
      }
      const repaired = this.repairShape(shape, 'Fillet');
      shape.delete();
      return this.wrap(repaired);
    } finally {
      progress.delete();
      maker.delete();
      selected.dispose();
    }
  }

  chamfer(
    solid: OpenCascadeSolid,
    reference: EdgeReference3,
    distance1: number,
    distance2: number,
  ): OpenCascadeSolid {
    if (![distance1, distance2].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error('Chamfer distances must be positive.');
    }
    const selected = this.edgeByFaces(solid.shape(this), reference);
    const maker = new this.oc.BRepFilletAPI_MakeChamfer(solid.shape(this));
    const progress = new this.oc.Message_ProgressRange_1();
    try {
      maker.Add_3(distance1, distance2, selected.edge, selected.face);
      maker.Build(progress);
      if (!maker.IsDone()) throw new Error('OpenCascade failed to chamfer the selected edge.');
      const shape = maker.Shape();
      if (shape.IsNull() || !this.hasSolid(shape)) {
        shape.delete();
        throw new Error('Chamfer did not produce a solid.');
      }
      const repaired = this.repairShape(shape, 'Chamfer');
      shape.delete();
      return this.wrap(repaired);
    } finally {
      progress.delete();
      maker.delete();
      selected.dispose();
    }
  }

  deleteFaces(solid: OpenCascadeSolid, faceIds: readonly number[]): OpenCascadeSolid {
    if (faceIds.length === 0) throw new Error('Delete Face requires at least one B-rep face.');
    const faces = this.subShapes(solid.shape(this), this.oc.TopAbs_ShapeEnum.TopAbs_FACE);
    const unique = [...new Set(faceIds)];
    if (unique.some((faceId) => !Number.isInteger(faceId) || faceId < 0 || faceId >= faces.length)) {
      faces.forEach((face) => face.delete());
      throw new Error('Delete Face refers to an invalid B-rep face.');
    }
    const defeaturing = new this.oc.BRepAlgoAPI_Defeaturing();
    const progress = new this.oc.Message_ProgressRange_1();
    try {
      defeaturing.SetShape(solid.shape(this));
      unique.forEach((faceId) => defeaturing.AddFaceToRemove(faces[faceId]));
      defeaturing.Build(progress);
      if (defeaturing.HasErrors()) throw new Error('OpenCascade could not heal the removed face.');
      const shape = defeaturing.Shape();
      if (shape.IsNull() || !this.hasSolid(shape)) {
        shape.delete();
        throw new Error('Delete Face did not produce a closed solid.');
      }
      const analyzer = new this.oc.BRepCheck_Analyzer(shape, true, false);
      const valid = analyzer.IsValid_2();
      analyzer.delete();
      if (!valid) {
        shape.delete();
        throw new Error('Delete Face produced an invalid solid.');
      }
      return this.wrap(shape);
    } finally {
      progress.delete();
      defeaturing.delete();
      faces.forEach((face) => face.delete());
    }
  }

  /**
   * `faceId === null` hollows the solid out completely (`MakeThickSolidBySimple`
   * — a closed cavity, no opening); a given face is removed and the rest
   * thickened into a shell that stays joined at that opening
   * (`MakeThickSolidByJoin`, the closing-faces idiom every "Shell" tool in
   * mainstream CAD uses). `thickness` always hollows inward — OCCT's own
   * sign convention for this offset — never grows the solid outward.
   */
  shell(solid: OpenCascadeSolid, faceId: number | null, thickness: number): OpenCascadeSolid {
    const offset = -Math.abs(thickness);
    const faces = faceId === null ? [] : this.subShapes(solid.shape(this), this.oc.TopAbs_ShapeEnum.TopAbs_FACE);
    if (faceId !== null && (!Number.isInteger(faceId) || faceId < 0 || faceId >= faces.length)) {
      faces.forEach((face) => face.delete());
      throw new Error('Shell refers to an invalid B-rep face.');
    }
    const maker = new this.oc.BRepOffsetAPI_MakeThickSolid();
    const progress = new this.oc.Message_ProgressRange_1();
    let closingFaces: InstanceType<typeof this.oc.TopTools_ListOfShape_1> | null = null;
    try {
      if (faceId === null) {
        maker.MakeThickSolidBySimple(solid.shape(this), offset);
      } else {
        closingFaces = new this.oc.TopTools_ListOfShape_1();
        closingFaces.Append_1(faces[faceId]);
        maker.MakeThickSolidByJoin(
          solid.shape(this), closingFaces, offset, 1e-3,
          this.oc.BRepOffset_Mode.BRepOffset_Skin as unknown as BRepOffset_Mode, false, false,
          this.oc.GeomAbs_JoinType.GeomAbs_Arc as unknown as GeomAbs_JoinType, false, progress,
        );
      }
      maker.Build(progress);
      const shape = maker.Shape();
      if (shape.IsNull()) {
        shape.delete();
        throw new Error('OpenCascade failed to shell the solid.');
      }
      return this.wrap(shape);
    } finally {
      progress.delete();
      maker.delete();
      closingFaces?.delete();
      faces.forEach((face) => face.delete());
    }
  }

  /**
   * Tapers each face in `faceIds` by `angleRadians` about `neutralPlane` —
   * the plane pivots the face and stays undeformed itself, the rest of the
   * face tilts away from it. Pull direction is always the neutral plane's
   * own normal (no separate direction the caller can override yet).
   */
  draft(solid: OpenCascadeSolid, faceIds: readonly number[], neutralPlane: Plane3, angleRadians: number): OpenCascadeSolid {
    if (faceIds.length === 0) throw new Error('Draft requires at least one B-rep face.');
    const normalLength = Math.hypot(neutralPlane.normal.x, neutralPlane.normal.y, neutralPlane.normal.z);
    if (normalLength <= Number.EPSILON) throw new Error('Draft neutral plane normal must be non-zero.');
    const faces = this.subShapes(solid.shape(this), this.oc.TopAbs_ShapeEnum.TopAbs_FACE);
    const unique = [...new Set(faceIds)];
    if (unique.some((faceId) => !Number.isInteger(faceId) || faceId < 0 || faceId >= faces.length)) {
      faces.forEach((face) => face.delete());
      throw new Error('Draft refers to an invalid B-rep face.');
    }
    const point = new this.oc.gp_Pnt_3(neutralPlane.origin.x, neutralPlane.origin.y, neutralPlane.origin.z);
    const direction = new this.oc.gp_Dir_4(
      neutralPlane.normal.x / normalLength,
      neutralPlane.normal.y / normalLength,
      neutralPlane.normal.z / normalLength,
    );
    const plane = new this.oc.gp_Pln_3(point, direction);
    const maker = new this.oc.BRepOffsetAPI_DraftAngle_2(solid.shape(this));
    const progress = new this.oc.Message_ProgressRange_1();
    try {
      unique.forEach((faceId) => maker.Add(this.oc.TopoDS.Face_1(faces[faceId]), direction, angleRadians, plane, false));
      if (!maker.AddDone()) throw new Error('OpenCascade could not add every face to the draft.');
      maker.Build(progress);
      const shape = maker.Shape();
      if (shape.IsNull()) {
        shape.delete();
        throw new Error('OpenCascade failed to draft the solid.');
      }
      return this.wrap(shape);
    } finally {
      progress.delete();
      maker.delete();
      plane.delete();
      direction.delete();
      point.delete();
      faces.forEach((face) => face.delete());
    }
  }

  splitByPlane(solid: OpenCascadeSolid, plane: Plane3): OpenCascadeSolid[] {
    const normalLength = Math.hypot(plane.normal.x, plane.normal.y, plane.normal.z);
    if (normalLength <= Number.EPSILON) throw new Error('Slice plane normal must be non-zero.');

    const point = new this.oc.gp_Pnt_3(plane.origin.x, plane.origin.y, plane.origin.z);
    const direction = new this.oc.gp_Dir_4(
      plane.normal.x / normalLength,
      plane.normal.y / normalLength,
      plane.normal.z / normalLength,
    );
    const ocPlane = new this.oc.gp_Pln_3(point, direction);
    const faceMaker = new this.oc.BRepBuilderAPI_MakeFace_3(ocPlane);
    const cuttingFace = faceMaker.Face();
    const argumentsList = new this.oc.TopTools_ListOfShape_1();
    const toolsList = new this.oc.TopTools_ListOfShape_1();
    argumentsList.Append_1(solid.shape(this));
    toolsList.Append_1(cuttingFace);

    const splitter = new this.oc.BRepAlgoAPI_Splitter_1();
    splitter.SetArguments(argumentsList);
    splitter.SetTools(toolsList);
    const progress = new this.oc.Message_ProgressRange_1();
    splitter.Build(progress);
    progress.delete();
    if (splitter.HasErrors()) {
      splitter.delete();
      toolsList.delete();
      argumentsList.delete();
      cuttingFace.delete();
      faceMaker.delete();
      ocPlane.delete();
      direction.delete();
      point.delete();
      throw new Error('OpenCascade failed to split the solid by the plane.');
    }

    const result = splitter.Shape();
    const pieces = this.subShapes(result, this.oc.TopAbs_ShapeEnum.TopAbs_SOLID);

    result.delete();
    splitter.delete();
    toolsList.delete();
    argumentsList.delete();
    cuttingFace.delete();
    faceMaker.delete();
    ocPlane.delete();
    direction.delete();
    point.delete();

    return pieces.map((shape) => this.wrap(shape));
  }

  union(solids: readonly OpenCascadeSolid[]): OpenCascadeSolid {
    if (solids.length === 0) throw new Error('Union requires at least one solid.');
    if (solids.length === 1) return this.wrap(this.copyShape(solids[0].shape(this)));

    let result = this.copyShape(solids[0].shape(this));
    for (let index = 1; index < solids.length; index++) {
      const progress = new this.oc.Message_ProgressRange_1();
      const fuse = new this.oc.BRepAlgoAPI_Fuse_3(
        result,
        solids[index].shape(this),
        progress,
      );
      fuse.Build(progress);
      progress.delete();
      if (fuse.HasErrors()) {
        fuse.delete();
        result.delete();
        throw new Error('OpenCascade failed to unite the solids.');
      }
      const next = fuse.Shape();
      fuse.delete();
      result.delete();
      result = next;
    }
    return this.wrap(result);
  }

  subtract(base: OpenCascadeSolid, tools: readonly OpenCascadeSolid[]): OpenCascadeSolid {
    if (tools.length === 0) return this.wrap(this.copyShape(base.shape(this)));
    let result = this.copyShape(base.shape(this));
    for (const tool of tools) {
      const progress = new this.oc.Message_ProgressRange_1();
      const cut = new this.oc.BRepAlgoAPI_Cut_3(result, tool.shape(this), progress);
      cut.Build(progress);
      progress.delete();
      if (cut.HasErrors()) {
        cut.delete();
        result.delete();
        throw new Error('OpenCascade failed to subtract the solids.');
      }
      const next = cut.Shape();
      cut.delete();
      result.delete();
      result = next;
      if (!this.hasSolid(result)) {
        result.delete();
        throw new Error('Subtract removed the complete base solid.');
      }
    }
    return this.wrap(result);
  }

  intersect(solids: readonly OpenCascadeSolid[]): OpenCascadeSolid {
    if (solids.length < 2) throw new Error('Intersect requires at least two solids.');
    let result = this.copyShape(solids[0].shape(this));
    for (let index = 1; index < solids.length; index++) {
      const progress = new this.oc.Message_ProgressRange_1();
      const common = new this.oc.BRepAlgoAPI_Common_3(result, solids[index].shape(this), progress);
      common.Build(progress);
      progress.delete();
      if (common.HasErrors()) {
        common.delete();
        result.delete();
        throw new Error('OpenCascade failed to intersect the solids.');
      }
      const next = common.Shape();
      common.delete();
      result.delete();
      result = next;
      if (!this.hasSolid(result)) {
        result.delete();
        throw new Error('The solids do not share a solid volume.');
      }
    }
    return this.wrap(result);
  }

  /**
   * A shape with every face orientation flipped — same shape, opposite sense.
   * A real solid always has an unambiguous inside; a bare open shell (a lone
   * guided-loft surface, say, before SHELL/MakeThickSolidBySimple gives it a
   * wall) does not, so which way "inward" resolves to can come out either
   * way depending on how the surface happened to be built. This is the tool
   * a caller in that position retries with when the first attempt comes back
   * invalid — see exactGuidedLoftShape's own use of it.
   */
  reversed(solid: OpenCascadeSolid): OpenCascadeSolid {
    return this.wrap(solid.shape(this).Reversed());
  }

  /**
   * SURFSCULPT: sews N open shells that together form a watertight boundary
   * (no free edges) into one closed shell, then builds a real solid from it
   * — same sewing-then-MakeSolid shape as `fromMesh`'s own per-triangle
   * version, just starting from whole surfaces instead of raw triangles.
   */
  sculptSolid(surfaces: readonly OpenCascadeSolid[]): OpenCascadeSolid {
    if (surfaces.length < 2) throw new Error('Surfsculpt requires at least two surfaces.');
    const sewing = new this.oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false);
    let progress: InstanceType<typeof this.oc.Message_ProgressRange_1> | null = null;
    let sewed: TopoDS_Shape | null = null;
    const shells: TopoDS_Shape[] = [];
    const typedShells: ReturnType<typeof this.oc.TopoDS.Shell_1>[] = [];
    let solidMaker: InstanceType<typeof this.oc.BRepBuilderAPI_MakeSolid_1> | null = null;
    let solid: ReturnType<InstanceType<typeof this.oc.BRepBuilderAPI_MakeSolid_1>['Solid']> | null = null;
    try {
      for (const surface of surfaces) sewing.Add(surface.shape(this));
      progress = new this.oc.Message_ProgressRange_1();
      sewing.Perform(progress);
      if (sewing.NbFreeEdges() !== 0) {
        throw new Error(`Surfsculpt requires a watertight network — ${sewing.NbFreeEdges()} free edge(s) remain.`);
      }
      sewed = sewing.SewedShape();
      if (sewed.IsNull()) throw new Error('OpenCascade could not sew the selected surfaces.');
      if (sewed.ShapeType() === this.oc.TopAbs_ShapeEnum.TopAbs_SHELL as unknown as TopAbs_ShapeEnum) {
        shells.push(this.copyShape(sewed));
      } else {
        shells.push(...this.subShapes(sewed, this.oc.TopAbs_ShapeEnum.TopAbs_SHELL));
      }
      if (shells.length === 0) throw new Error('The sewn surfaces contain no closed shell.');
      solidMaker = new this.oc.BRepBuilderAPI_MakeSolid_1();
      for (const shellShape of shells) {
        const shell = this.oc.TopoDS.Shell_1(shellShape);
        typedShells.push(shell);
        solidMaker.Add(shell);
      }
      if (!solidMaker.IsDone()) throw new Error('OpenCascade could not make a solid from the sewn surfaces.');
      solid = solidMaker.Solid();
      this.oc.BRepLib.OrientClosedSolid(solid);
      const analyzer = new this.oc.BRepCheck_Analyzer(solid, true, false);
      const valid = analyzer.IsValid_2();
      analyzer.delete();
      if (!valid) throw new Error('The sculpted solid is invalid.');
      return this.wrap(this.copyShape(solid));
    } finally {
      solid?.delete();
      solidMaker?.delete();
      typedShells.forEach((shell) => shell.delete());
      shells.forEach((shell) => shell.delete());
      sewed?.delete();
      progress?.delete();
      sewing.delete();
    }
  }

  heal(solid: OpenCascadeSolid): OpenCascadeSolid {
    const unifier = new this.oc.ShapeUpgrade_UnifySameDomain_2(
      solid.shape(this),
      true,
      true,
      false,
    );
    unifier.SetSafeInputMode(true);
    unifier.Build();
    const shape = unifier.Shape();
    unifier.delete();
    return this.wrap(shape);
  }

  transform(solid: OpenCascadeSolid, transform: AffineTransform3): OpenCascadeSolid {
    const shape = solid.shape(this);
    let result: TopoDS_Shape;
    if (isSimilarityTransform(transform)) {
      // gp_Trsf preserves analytic surfaces (planes remain planes, cylinders
      // remain cylinders) for translations, rotations, mirrors and uniform
      // scales — the transformations used by the standard CAD commands.
      const trsf = new this.oc.gp_Trsf_1();
      trsf.SetValues(...transform);
      const builder = new this.oc.BRepBuilderAPI_Transform_2(shape, trsf, true);
      result = builder.Shape();
      builder.delete();
      trsf.delete();
    } else {
      // Grip and property edits may stretch axes independently. OCCT's general
      // transform keeps a valid exact B-rep for those affine deformations.
      const trsf = new this.oc.gp_GTrsf_1();
      for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 4; column++) {
          trsf.SetValue(row + 1, column + 1, transform[row * 4 + column]);
        }
      }
      trsf.SetForm();
      if (trsf.IsSingular()) {
        trsf.delete();
        throw new Error('Exact solid transform must be invertible.');
      }
      const builder = new this.oc.BRepBuilderAPI_GTransform_2(shape, trsf, true);
      result = builder.Shape();
      builder.delete();
      trsf.delete();
    }
    if (result.IsNull()) {
      result.delete();
      throw new Error('OpenCascade failed to transform the solid.');
    }
    return this.wrap(result);
  }

  inspect(solid: OpenCascadeSolid): SolidInspection {
    const shape = solid.shape(this);
    const boundingBox = new this.oc.Bnd_Box_1();
    this.oc.BRepBndLib.AddOptimal(shape, boundingBox, false, false);
    const min = boundingBox.CornerMin();
    const max = boundingBox.CornerMax();

    const properties = new this.oc.GProp_GProps_1();
    // Curved surfaces produced by a general affine transform need adaptive
    // integration. The default overload is visibly less accurate for an
    // ellipsoid, while this overload lets OCCT refine the result explicitly.
    this.oc.BRepGProp.VolumeProperties_2(shape, properties, 1e-12, true, false);
    const volume = properties.Mass();

    const analyzer = new this.oc.BRepCheck_Analyzer(shape, true, false);
    const valid = analyzer.IsValid_2();

    const inspection: SolidInspection = {
      bounds: {
        min: { x: min.X(), y: min.Y(), z: min.Z() },
        max: { x: max.X(), y: max.Y(), z: max.Z() },
      },
      faceCount: this.countSubShapes(shape, this.oc.TopAbs_ShapeEnum.TopAbs_FACE),
      solidCount: this.countSubShapes(shape, this.oc.TopAbs_ShapeEnum.TopAbs_SOLID),
      volume,
      valid,
    };

    analyzer.delete();
    properties.delete();
    max.delete();
    min.delete();
    boundingBox.delete();
    return inspection;
  }

  tessellate(
    solid: OpenCascadeSolid,
    options: TessellationOptions = {},
  ): KernelTessellation {
    const linearDeflection = options.linearDeflection ?? 0.1;
    const angularDeflection = options.angularDeflection ?? 0.35;
    if (linearDeflection <= 0 || angularDeflection <= 0) {
      throw new Error('Tessellation deflections must be positive.');
    }

    const shape = solid.shape(this);
    const mesher = new this.oc.BRepMesh_IncrementalMesh_2(
      shape,
      linearDeflection,
      false,
      angularDeflection,
      false,
    );

    const positions: number[] = [];
    const indices: number[] = [];
    const triangleFaceIds: number[] = [];
    const vertices = new Map<string, number>();
    const faces = this.subShapes(shape, this.oc.TopAbs_ShapeEnum.TopAbs_FACE);

    const vertexIndex = (x: number, y: number, z: number): number => {
      // The consumer receives float32 positions. Weld by those exact values so
      // adjacent OCCT faces share indices after conversion as well as in B-rep.
      const fx = Math.fround(x), fy = Math.fround(y), fz = Math.fround(z);
      const key = `${fx}:${fy}:${fz}`;
      const existing = vertices.get(key);
      if (existing !== undefined) return existing;
      const index = positions.length / 3;
      positions.push(fx, fy, fz);
      vertices.set(key, index);
      return index;
    };

    faces.forEach((faceShape, faceId) => {
      const face = this.oc.TopoDS.Face_1(faceShape);
      faceShape.delete();
      const location = new this.oc.TopLoc_Location_1();
      // Poly_MeshPurpose is missing from the generated JS/TS enums in the beta
      // package. OCCT defines zero as the default triangulation purpose and the
      // Embind binding accepts its numeric value.
      const handle = this.oc.BRep_Tool.Triangulation(face, location, 0 as never);
      if (handle.IsNull()) {
        handle.delete();
        location.delete();
        face.delete();
        throw new Error(`OpenCascade produced no triangulation for face ${faceId}.`);
      }

      const triangulation = handle.get();
      const transformation = location.Transformation();
      const localToGlobal = new Uint32Array(triangulation.NbNodes() + 1);
      for (let nodeIndex = 1; nodeIndex <= triangulation.NbNodes(); nodeIndex++) {
        const localPoint = triangulation.Node(nodeIndex);
        const worldPoint = localPoint.Transformed(transformation);
        localToGlobal[nodeIndex] = vertexIndex(worldPoint.X(), worldPoint.Y(), worldPoint.Z());
        worldPoint.delete();
        localPoint.delete();
      }

      const reversed = face.Orientation_1() === this.oc.TopAbs_Orientation.TopAbs_REVERSED;
      for (let triangleIndex = 1; triangleIndex <= triangulation.NbTriangles(); triangleIndex++) {
        const triangle = triangulation.Triangle(triangleIndex);
        const a = localToGlobal[triangle.Value(1)];
        const b = localToGlobal[triangle.Value(2)];
        const c = localToGlobal[triangle.Value(3)];
        triangle.delete();
        if (a === b || b === c || c === a) continue;
        indices.push(a, reversed ? c : b, reversed ? b : c);
        triangleFaceIds.push(faceId);
      }

      transformation.delete();
      handle.delete();
      location.delete();
      face.delete();
    });
    mesher.delete();

    return {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
      triangleFaceIds: new Uint32Array(triangleFaceIds),
    };
  }

  serialize(solid: OpenCascadeSolid): SerializedKernelSolid {
    const file = this.temporaryFile('write', 'brep');
    const progress = new this.oc.Message_ProgressRange_1();
    try {
      const written = this.oc.BRepTools.Write_4(
        solid.shape(this),
        file,
        false,
        false,
        this.oc.TopTools_FormatVersion.TopTools_FormatVersion_CURRENT as unknown as TopTools_FormatVersion,
        progress,
      );
      if (!written) throw new Error('OpenCascade failed to serialize the solid.');
      return { format: 'occt-brep-v1', data: this.oc.FS.readFile(file, { encoding: 'utf8' }) };
    } finally {
      progress.delete();
      this.unlinkIfPresent(file);
    }
  }

  deserialize(serialized: SerializedKernelSolid): OpenCascadeSolid {
    if (serialized.format !== 'occt-brep-v1' || !serialized.data) {
      throw new Error('Unsupported or empty exact-solid format.');
    }
    const file = this.temporaryFile('read', 'brep');
    this.oc.FS.writeFile(file, serialized.data);
    const shape = new this.oc.TopoDS_Shape();
    const builder = new this.oc.BRep_Builder();
    const progress = new this.oc.Message_ProgressRange_1();
    try {
      const read = this.oc.BRepTools.Read_2(shape, file, builder, progress);
      if (!read || shape.IsNull()) throw new Error('OpenCascade failed to deserialize the solid.');
      const analyzer = new this.oc.BRepCheck_Analyzer(shape, true, false);
      const valid = analyzer.IsValid_2();
      analyzer.delete();
      if (!valid) throw new Error('The serialized OpenCascade solid is invalid.');
      return this.wrap(shape);
    } catch (error) {
      shape.delete();
      throw error;
    } finally {
      progress.delete();
      builder.delete();
      this.unlinkIfPresent(file);
    }
  }

  writeStep(shapes: readonly OpenCascadeSolid[]): string {
    if (shapes.length === 0) throw new Error('STEP export requires at least one solid.');
    this.oc.Interface_Static.SetCVal('write.step.unit', 'MM');
    const file = this.temporaryFile('write', 'step');
    const writer = new this.oc.STEPControl_Writer_1();
    try {
      for (const solid of shapes) {
        const progress = new this.oc.Message_ProgressRange_1();
        const status = writer.Transfer(
          solid.shape(this),
          this.oc.STEPControl_StepModelType.STEPControl_AsIs as unknown as STEPControl_StepModelType,
          true,
          progress,
        );
        progress.delete();
        if (!this.isStepDone(status)) throw new Error('OpenCascade failed to transfer a solid to the STEP writer.');
      }
      if (!this.isStepDone(writer.Write(file))) throw new Error('OpenCascade failed to write the STEP file.');
      return this.oc.FS.readFile(file, { encoding: 'utf8' });
    } finally {
      writer.delete();
      this.unlinkIfPresent(file);
    }
  }

  readStep(text: string): OpenCascadeSolid[] {
    const file = this.temporaryFile('read', 'step');
    this.oc.FS.writeFile(file, text);
    const reader = new this.oc.STEPControl_Reader_1();
    try {
      if (!this.isStepDone(reader.ReadFile(file))) throw new Error('OpenCascade could not read the STEP file.');
      const progress = new this.oc.Message_ProgressRange_1();
      reader.TransferRoots(progress);
      progress.delete();
      const shapes: OpenCascadeSolid[] = [];
      for (let index = 1; index <= reader.NbShapes(); index++) {
        const shape = reader.Shape(index);
        if (shape.IsNull()) { shape.delete(); continue; }
        shapes.push(this.wrap(shape));
      }
      if (shapes.length === 0) throw new Error('The STEP file contains no shapes.');
      return shapes;
    } finally {
      reader.delete();
      this.unlinkIfPresent(file);
    }
  }

  private isStepDone(status: IFSelect_ReturnStatus): boolean {
    return status === (this.oc.IFSelect_ReturnStatus.IFSelect_RetDone as unknown as IFSelect_ReturnStatus);
  }

  private wrap(shape: TopoDS_Shape): OpenCascadeSolid {
    return new OpenCascadeSolid(this, shape);
  }

  private makeWithAxes(origin: Point3, create: (axes: gp_Ax2) => TopoDS_Shape): OpenCascadeSolid {
    const point = new this.oc.gp_Pnt_3(origin.x, origin.y, origin.z);
    const xDirection = new this.oc.gp_Dir_4(1, 0, 0);
    const zDirection = new this.oc.gp_Dir_4(0, 0, 1);
    const axes = new this.oc.gp_Ax2_2(point, zDirection, xDirection);
    try {
      return this.wrap(create(axes));
    } finally {
      axes.delete();
      zDirection.delete();
      xDirection.delete();
      point.delete();
    }
  }

  private validateRadialPrimitive(radius: number, height: number, name: string): void {
    if (radius <= 0 || height <= 0) throw new Error(`${name} radius and height must be positive.`);
  }

  private validateVector(vector: Point3, name: string): void {
    if (Math.hypot(vector.x, vector.y, vector.z) <= Number.EPSILON) {
      throw new Error(`${name} vector must be non-zero.`);
    }
  }

  private makeSweepEdge(
    segment: SweepPathSegment3,
    owned: Array<{ delete(): void }>,
  ): ReturnType<InstanceType<typeof this.oc.BRepBuilderAPI_MakeEdge_3>['Edge']> {
    if (segment.kind === 'line') {
      this.validateVector({
        x: segment.end.x - segment.start.x,
        y: segment.end.y - segment.start.y,
        z: segment.end.z - segment.start.z,
      }, 'Sweep path');
      const start = new this.oc.gp_Pnt_3(segment.start.x, segment.start.y, segment.start.z);
      const end = new this.oc.gp_Pnt_3(segment.end.x, segment.end.y, segment.end.z);
      const maker = new this.oc.BRepBuilderAPI_MakeEdge_3(start, end);
      const edge = maker.Edge();
      owned.push(start, end, maker, edge);
      return edge;
    }

    if (segment.kind === 'arc') {
      if (segment.radius <= 0 || Math.abs(segment.sweepAngle) <= Number.EPSILON) {
        throw new Error('Sweep arc radius and angle must be non-zero.');
      }
      const sign = segment.sweepAngle < 0 ? -1 : 1;
      const center = new this.oc.gp_Pnt_3(segment.center.x, segment.center.y, segment.center.z);
      const normal = new this.oc.gp_Dir_4(
        segment.normal.x * sign,
        segment.normal.y * sign,
        segment.normal.z * sign,
      );
      const xDirection = new this.oc.gp_Dir_4(segment.xAxis.x, segment.xAxis.y, segment.xAxis.z);
      const axes = new this.oc.gp_Ax2_2(center, normal, xDirection);
      const circle = new this.oc.gp_Circ_2(axes, segment.radius);
      const fullCircle = Math.abs(Math.abs(segment.sweepAngle) - Math.PI * 2) <= 1e-9;
      const startAngle = sign > 0 ? segment.startAngle : -segment.startAngle;
      const maker = fullCircle
        ? new this.oc.BRepBuilderAPI_MakeEdge_8(circle)
        : new this.oc.BRepBuilderAPI_MakeEdge_9(circle, startAngle, startAngle + Math.abs(segment.sweepAngle));
      const edge = maker.Edge();
      owned.push(center, normal, xDirection, axes, circle, maker, edge);
      return edge;
    }

    if (segment.poles.length < 2) throw new Error('Sweep Bezier path requires at least two poles.');
    const poles = new this.oc.TColgp_Array1OfPnt_2(1, segment.poles.length);
    owned.push(poles);
    for (let index = 0; index < segment.poles.length; index++) {
      const value = segment.poles[index];
      const point = new this.oc.gp_Pnt_3(value.x, value.y, value.z);
      poles.SetValue(index + 1, point);
      owned.push(point);
    }
    const curve = new this.oc.Geom_BezierCurve_1(poles);
    const handle = new this.oc.Handle_Geom_Curve_2(curve);
    const maker = new this.oc.BRepBuilderAPI_MakeEdge_24(handle);
    const edge = maker.Edge();
    owned.push(curve, handle, maker, edge);
    return edge;
  }

  /** Joins exact edges — lines, arcs, Bezier curves, any mix — into one wire.
   *  The common step behind a sweep's spine, a sweep's curved profile, and a
   *  curved-profile extrusion. */
  private buildWireFromEdges(
    edges: readonly SweepPathSegment3[],
    owned: Array<{ delete(): void }>,
    errorMessage: string,
  ): TopoDS_Wire {
    const wireMaker = new this.oc.BRepBuilderAPI_MakeWire_1();
    owned.push(wireMaker);
    for (const segment of edges) wireMaker.Add_1(this.makeSweepEdge(segment, owned));
    if (!wireMaker.IsDone()) throw new Error(errorMessage);
    return wireMaker.Wire();
  }

  private makeSweepProfileWire(
    profile: SweepProfile3,
    owned: Array<{ delete(): void }>,
  ): TopoDS_Wire {
    if (profile.kind === 'polygon') {
      if (profile.points.length < 3) throw new Error('Sweep polygon requires at least three points.');
      const polygon = new this.oc.BRepBuilderAPI_MakePolygon_1();
      owned.push(polygon);
      for (const value of profile.points) {
        const point = new this.oc.gp_Pnt_3(value.x, value.y, value.z);
        polygon.Add_1(point);
        owned.push(point);
      }
      polygon.Close();
      if (!polygon.IsDone()) throw new Error('OpenCascade could not close the sweep profile.');
      return polygon.Wire();
    }

    if (profile.kind === 'wire') {
      return this.buildWireFromEdges(profile.edges, owned, 'OpenCascade could not close the sweep profile.');
    }

    if (profile.radius <= 0) throw new Error('Sweep circle radius must be positive.');
    const center = new this.oc.gp_Pnt_3(profile.center.x, profile.center.y, profile.center.z);
    const normal = new this.oc.gp_Dir_4(profile.normal.x, profile.normal.y, profile.normal.z);
    const xDirection = new this.oc.gp_Dir_4(profile.xAxis.x, profile.xAxis.y, profile.xAxis.z);
    const axes = new this.oc.gp_Ax2_2(center, normal, xDirection);
    const circle = new this.oc.gp_Circ_2(axes, profile.radius);
    const edgeMaker = new this.oc.BRepBuilderAPI_MakeEdge_8(circle);
    const edge = edgeMaker.Edge();
    const wireMaker = new this.oc.BRepBuilderAPI_MakeWire_2(edge);
    const wire = wireMaker.Wire();
    owned.push(center, normal, xDirection, axes, circle, edgeMaker, edge, wireMaker);
    return wire;
  }

  private edgeByFaces(
    shape: TopoDS_Shape,
    reference: EdgeReference3,
  ): { edge: TopoDS_Edge; face: TopoDS_Face; dispose(): void } {
    const faces = this.subShapes(shape, this.oc.TopAbs_ShapeEnum.TopAbs_FACE);
    const [firstId, secondId] = reference.faceIds;
    if (!Number.isInteger(firstId) || !Number.isInteger(secondId)
      || firstId < 0 || secondId < 0 || firstId >= faces.length || secondId >= faces.length
      || firstId === secondId) {
      faces.forEach((face) => face.delete());
      throw new Error('Selected edge refers to invalid B-rep faces.');
    }
    const firstEdges = this.subShapes(faces[firstId], this.oc.TopAbs_ShapeEnum.TopAbs_EDGE);
    const secondEdges = this.subShapes(faces[secondId], this.oc.TopAbs_ShapeEnum.TopAbs_EDGE);
    const common = firstEdges.find((candidate) => secondEdges.some((other) => candidate.IsSame(other)));
    if (!common) {
      firstEdges.forEach((edge) => edge.delete());
      secondEdges.forEach((edge) => edge.delete());
      faces.forEach((face) => face.delete());
      throw new Error('The selected B-rep faces do not share an edge.');
    }
    const edge = this.oc.TopoDS.Edge_1(common);
    const face = this.oc.TopoDS.Face_1(faces[firstId]);
    return {
      edge,
      face,
      dispose: () => {
        edge.delete();
        face.delete();
        firstEdges.forEach((item) => item.delete());
        secondEdges.forEach((item) => item.delete());
        faces.forEach((item) => item.delete());
      },
    };
  }

  private copyShape(shape: TopoDS_Shape): TopoDS_Shape {
    const location = shape.Location_1();
    const copy = shape.Located(location, false);
    location.delete();
    return copy;
  }

  /**
   * Local edge operations on a faceted B-rep can leave otherwise valid edges
   * without complete 3D curves/pcurves.  The in-memory shape still tessellates,
   * but those omissions become visible to BRepCheck after a BREP round trip.
   * Rebuilding the curves and same-parameter data here keeps the persisted
   * exact solid self-contained.
   */
  private repairShape(shape: TopoDS_Shape, operation: string): TopoDS_Shape {
    this.oc.BRepLib.BuildCurves3d_2(shape);
    this.oc.BRepLib.SameParameter_3(shape, 1e-7, true);
    this.oc.BRepLib.UpdateTolerances_1(shape, true);

    const fixer = new this.oc.ShapeFix_Shape_2(shape);
    const progress = new this.oc.Message_ProgressRange_1();
    let fixed: TopoDS_Shape | null = null;
    try {
      fixer.SetPrecision(1e-7);
      fixer.SetMinTolerance(1e-9);
      fixer.SetMaxTolerance(1e-3);
      fixer.Perform(progress);
      fixed = fixer.Shape();
      const result = this.copyShape(fixed);
      const analyzer = new this.oc.BRepCheck_Analyzer(result, true, false);
      const valid = analyzer.IsValid_2();
      analyzer.delete();
      if (!valid) {
        result.delete();
        throw new Error(`${operation} produced an invalid solid.`);
      }
      return result;
    } finally {
      fixed?.delete();
      progress.delete();
      fixer.delete();
    }
  }

  private temporaryFile(operation: string, extension: string): string {
    return `/tmp/mycad-${operation}-${++this.temporaryFileSequence}.${extension}`;
  }

  private unlinkIfPresent(file: string): void {
    if (this.oc.FS.analyzePath(file).exists) this.oc.FS.unlink(file);
  }

  private subShapes(shape: TopoDS_Shape, type: object): TopoDS_Shape[] {
    const explorer = new this.oc.TopExp_Explorer_2(
      shape,
      // opencascade.js types enum values as `{}` although the constructor
      // correctly accepts those individual values at runtime.
      type as unknown as TopAbs_ShapeEnum,
      this.oc.TopAbs_ShapeEnum.TopAbs_SHAPE as unknown as TopAbs_ShapeEnum,
    );
    const result: TopoDS_Shape[] = [];
    while (explorer.More()) {
      result.push(explorer.Value());
      explorer.Next();
    }
    explorer.delete();
    return result;
  }

  private countSubShapes(shape: TopoDS_Shape, type: object): number {
    const shapes = this.subShapes(shape, type);
    shapes.forEach((subShape) => subShape.delete());
    return shapes.length;
  }

  private hasSolid(shape: TopoDS_Shape): boolean {
    return this.countSubShapes(shape, this.oc.TopAbs_ShapeEnum.TopAbs_SOLID) > 0;
  }
}

function isSimilarityTransform(transform: AffineTransform3): boolean {
  const columns = [
    [transform[0], transform[4], transform[8]],
    [transform[1], transform[5], transform[9]],
    [transform[2], transform[6], transform[10]],
  ];
  const lengths = columns.map(([x, y, z]) => Math.hypot(x, y, z));
  const scale = Math.max(...lengths);
  if (!Number.isFinite(scale) || scale <= Number.EPSILON) return false;
  const tolerance = scale * scale * 1e-9;
  const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.abs(lengths[0] - lengths[1]) <= scale * 1e-9
    && Math.abs(lengths[0] - lengths[2]) <= scale * 1e-9
    && Math.abs(dot(columns[0], columns[1])) <= tolerance
    && Math.abs(dot(columns[0], columns[2])) <= tolerance
    && Math.abs(dot(columns[1], columns[2])) <= tolerance;
}
