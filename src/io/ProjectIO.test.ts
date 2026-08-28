import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { WORLD_WORK_PLANE } from '../math/workplane';
import { resetIdCounter, type EdgeModificationFeature, type ExtrusionFeature, type PressPullFeature, type PrimitiveFeature, type SweepFeature } from '../core/entities/types';
import { primitivePreviewMesh as primitiveMesh } from '../core/geometry/PrimitiveMesh';
import { exportAsciiStl, loadProject, serializeProject } from './ProjectIO';
import { solidPlanarFaces } from '../core/solids/SolidTopology';

describe('ProjectIO', () => {
  it('round-trips block definitions and INSERT transforms', () => {
    const source = new Document();
    const definition = { name: 'Part', basePoint: { x: 1, y: 2 }, entities: [source.createLine({ x: 1, y: 2 }, { x: 6, y: 2 })] };
    source.blockDefinitions = [definition];
    const insert = source.createInsert(definition, { x: 10, y: 20 });
    insert.scaleX = 2;
    insert.rotation = Math.PI / 4;
    source.addEntity(insert);
    const target = new Document();

    loadProject(target, serializeProject(source));

    expect(target.blockDefinitions[0]).toMatchObject({ name: 'Part', basePoint: { x: 1, y: 2 } });
    expect(target.entities[0]).toMatchObject({ type: 'insert', blockName: 'Part', position: { x: 10, y: 20 }, scaleX: 2 });
  });

  it('migrates a bezier saved before multi-segment splines into a one-segment chain', () => {
    // Old shape: control1/control2/end sat directly on the entity, not inside
    // a `segments` array — a project saved before BezierEntity grew one.
    const source = new Document();
    source.addEntity(source.createBezier({ x: 0, y: 0 }, { x: 1, y: 5 }, { x: 8, y: 5 }, { x: 10, y: 0 }));
    const saved = JSON.parse(serializeProject(source));
    const [start, control1, control2, end] = [saved.entities[0].start, saved.entities[0].segments[0].control1, saved.entities[0].segments[0].control2, saved.entities[0].segments[0].end];
    saved.entities[0] = { ...saved.entities[0], start, control1, control2, end, segments: undefined };
    const target = new Document();

    loadProject(target, JSON.stringify(saved));

    expect(target.entities[0]).toMatchObject({
      type: 'bezier', start: { x: 0, y: 0 },
      segments: [{ control1: { x: 1, y: 5 }, control2: { x: 8, y: 5 }, end: { x: 10, y: 0 } }],
    });
  });

  it('pools one definition across many placements instead of writing it once per INSERT', () => {
    // A symbol placed 80 times used to write its whole geometry 80 times over —
    // this is the file-size bug PURGEBLOCKS' neighbour issue was about.
    const source = new Document();
    const definition = { name: 'Fixture', basePoint: { x: 0, y: 0 }, entities: [source.createCircle({ x: 0, y: 0 }, 1)] };
    for (let i = 0; i < 80; i++) source.addEntity(source.createInsert(definition, { x: i, y: 0 }));

    const saved = JSON.parse(serializeProject(source));
    expect(saved.definitionPool).toHaveLength(1);
    expect(saved.entities.every((e: { definition: unknown }) => e.definition && '$block' in (e.definition as object))).toBe(true);

    const target = new Document();
    loadProject(target, JSON.stringify(saved));
    expect(target.entities).toHaveLength(80);
    expect(target.entities[79]).toMatchObject({ type: 'insert', blockName: 'Fixture', position: { x: 79, y: 0 } });
  });

  it('keeps two same-named definitions separate once one has diverged from the other', () => {
    // Placed, then one was edited after the fact — INSERTs snapshot on purpose
    // (see SetBlockDefinitionsEdit), so this must not collapse them into one.
    const source = new Document();
    const definitionA = { name: 'Widget', basePoint: { x: 0, y: 0 }, entities: [source.createLine({ x: 0, y: 0 }, { x: 1, y: 0 })] };
    const definitionB = { name: 'Widget', basePoint: { x: 0, y: 0 }, entities: [source.createLine({ x: 0, y: 0 }, { x: 5, y: 0 })] };
    source.addEntity(source.createInsert(definitionA, { x: 0, y: 0 }));
    source.addEntity(source.createInsert(definitionB, { x: 10, y: 0 }));

    const saved = JSON.parse(serializeProject(source));
    expect(saved.definitionPool).toHaveLength(2);

    const target = new Document();
    loadProject(target, JSON.stringify(saved));
    const first = target.entities[0] as { type: 'insert'; definition: { entities: Array<{ end: { x: number } }> } };
    const second = target.entities[1] as typeof first;
    expect(first.definition.entities[0].end.x).toBe(1);
    expect(second.definition.entities[0].end.x).toBe(5);
  });

  it('gives every loaded INSERT its own independent definition, even sharing one pool entry', () => {
    const source = new Document();
    const definition = { name: 'Shared', basePoint: { x: 0, y: 0 }, entities: [source.createLine({ x: 0, y: 0 }, { x: 1, y: 0 })] };
    source.addEntity(source.createInsert(definition, { x: 0, y: 0 }));
    source.addEntity(source.createInsert(definition, { x: 10, y: 0 }));
    const target = new Document();

    loadProject(target, serializeProject(source));

    const [first, second] = target.entities as Array<{ type: 'insert'; definition: { entities: Array<{ end: { x: number } }> } }>;
    first.definition.entities[0].end.x = 999;
    expect(second.definition.entities[0].end.x).toBe(1); // unaffected by mutating the sibling's snapshot
  });

  it('pools a definition nested inside another block, and round-trips a definition reachable only from the block library', () => {
    const source = new Document();
    const hinge = { name: 'Hinge', basePoint: { x: 0, y: 0 }, entities: [source.createCircle({ x: 0, y: 0 }, 0.5)] };
    const cabinetInsert = source.createInsert(hinge, { x: 1, y: 1 });
    const cabinet = { name: 'Cabinet', basePoint: { x: 0, y: 0 }, entities: [cabinetInsert] };
    source.blockDefinitions = [cabinet];
    source.addEntity(source.createInsert(cabinet, { x: 0, y: 0 }));
    const target = new Document();

    loadProject(target, serializeProject(source));

    const placedCabinet = target.entities[0] as { type: 'insert'; definition: { entities: Array<{ type: 'insert'; blockName: string }> } };
    expect(placedCabinet.definition.entities[0]).toMatchObject({ type: 'insert', blockName: 'Hinge' });
    expect(target.blockDefinitions[0].entities[0]).toMatchObject({ type: 'insert', blockName: 'Hinge' });
  });

  it('still loads a pre-pooling save where every INSERT carries its definition inline', () => {
    const legacy = {
      format: 'mycad', version: 1, units: 'mm',
      settings: {}, blockDefinitions: [],
      entities: [{
        id: 'insert_1', type: 'insert', layer: '0', aci: 256, color: 0xffffff, selected: false,
        blockName: 'Old', position: { x: 3, y: 4 }, scaleX: 1, scaleY: 1, scaleZ: 1, rotation: 0,
        columns: 1, rows: 1, columnSpacing: 0, rowSpacing: 0,
        definition: {
          name: 'Old', basePoint: { x: 0, y: 0 },
          entities: [{ id: 'line_1', type: 'line', layer: '0', aci: 256, color: 0xffffff, selected: false, start: { x: 0, y: 0 }, end: { x: 2, y: 0 } }],
        },
      }],
      solids: [],
    };
    const target = new Document();

    loadProject(target, JSON.stringify(legacy));

    expect(target.entities[0]).toMatchObject({ type: 'insert', blockName: 'Old', position: { x: 3, y: 4 } });
  });

  it('round-trips typed 3D meshes stored inside block definitions and INSERT snapshots', () => {
    const source = new Document();
    const solid = source.createSolid(primitiveMesh({
      kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 4, depth: 6, height: 8,
    }), 'Box', 8, []);
    const definition = { name: 'SolidPart', basePoint: { x: 0, y: 0 }, entities: [], solids: [solid] };
    source.blockDefinitions = [definition];
    const insert = source.createInsert(definition, { x: 10, y: 20 });
    insert.scaleZ = 2;
    source.addEntity(insert);
    const target = new Document();

    loadProject(target, serializeProject(source));

    expect(target.blockDefinitions[0].solids?.[0].mesh.positions).toBeInstanceOf(Float32Array);
    expect(target.blockDefinitions[0].solids?.[0].mesh.indices).toBeInstanceOf(Uint32Array);
    const loaded = target.entities[0];
    expect(loaded).toMatchObject({ type: 'insert', scaleZ: 2 });
    if (loaded.type !== 'insert') throw new Error('expected INSERT');
    expect(loaded.definition.solids?.[0].mesh.positions).toBeInstanceOf(Float32Array);
  });

  it('round-trips a native point entity', () => {
    const source = new Document();
    source.addEntity(source.createPoint({ x: 8.5, y: -2 }));
    const target = new Document();

    loadProject(target, serializeProject(source));

    expect(target.entities[0]).toMatchObject({ type: 'point', position: { x: 8.5, y: -2 } });
  });

  it('serializes a versioned millimetre project with typed meshes', () => {
    const doc = new Document();
    const rectangle = doc.createRectangle({ x: 0, y: 0 }, { x: 10, y: 5 });
    doc.addEntity(rectangle);
    const solid = doc.createSolid(
      { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 1]), indices: new Uint32Array([0, 1, 2]) },
      'test', 1, [rectangle.id]
    );
    doc.addSolid(solid);
    const saved = JSON.parse(serializeProject(doc));
    expect(saved).toMatchObject({ format: 'mycad', version: 2, units: 'mm' });
    expect(saved.settings).toMatchObject({ gridSize: 1, gridVisible: true, snapSize: 0.5 });
    expect(saved.entities[0].type).toBe('rectangle');
    expect(saved.solids[0].mesh.positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 1]);
  });

  it('round-trips exact B-rep metadata and its triangle-to-face map', () => {
    const source = new Document();
    const solid = source.createSolid({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      triangleFaceIds: new Uint32Array([4]),
    }, 'Exact', 1, []);
    solid.exact = {
      kernel: 'opencascade',
      revision: solid.revision,
      shape: { format: 'occt-brep-v1', data: 'CASCADE Topology V3 fixture' },
      transform: [
        1, 0, 0, 12,
        0, 1, 0, -3,
        0, 0, 1, 7,
      ],
    };
    source.addSolid(solid);
    const target = new Document();

    loadProject(target, serializeProject(source));

    expect(target.solids[0].mesh.triangleFaceIds).toEqual(new Uint32Array([4]));
    expect(target.solids[0].exact).toEqual(solid.exact);
  });

  it('advances the id counter on load so a new solid cannot overwrite a loaded one', () => {
    resetIdCounter();
    const source = new Document();
    const loaded = source.createSolid(
      { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
      'Loaded', 1, []
    );
    source.addSolid(loaded);
    const json = serializeProject(source);

    // A fresh session restarts the low counter, but the file's ids are spent.
    resetIdCounter();
    const target = new Document();
    loadProject(target, json);
    const fresh = target.createSolid(
      { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
      'Fresh', 1, []
    );
    target.addSolid(fresh);

    expect(fresh.id).not.toBe(loaded.id);
    expect(target.solids).toHaveLength(2);
    expect(target.solids.map((solid) => solid.id)).toContain(loaded.id);
  });

  it('exports one STL facet for one indexed triangle', () => {
    const doc = new Document();
    doc.addSolid(doc.createSolid(
      { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
      'triangle', 0, []
    ));
    const stl = exportAsciiStl(doc.solids);
    expect(stl.match(/facet normal/g)).toHaveLength(1);
    expect(stl).toContain('facet normal 0 0 1');
    expect(stl).toContain('vertex 1 0 0');
    expect(stl).toMatch(/^solid MyCAD/);
    expect(stl).toMatch(/endsolid MyCAD\n$/);
  });

  it('exports only the solids explicitly passed to the STL writer', () => {
    const doc = new Document();
    const omitted = doc.createSolid(
      { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
      'omitted', 0, [],
    );
    const selected = doc.createSolid(
      { positions: new Float32Array([10, 0, 0, 11, 0, 0, 10, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
      'selected', 0, [],
    );
    doc.solids.push(omitted, selected);

    const stl = exportAsciiStl([selected]);

    expect(stl.match(/facet normal/g)).toHaveLength(1);
    expect(stl).toContain('vertex 10 0 0');
    expect(stl).not.toContain('vertex 0 0 0');
  });

  it('loads a saved project and restores typed mesh arrays', () => {
    const source = new Document();
    source.addEntity(source.createRectangle({ x: 1, y: 2 }, { x: 5, y: 6 }));
    source.addSolid(source.createSolid(
      { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
      'loaded', 1, [],
    ));
    const target = new Document();
    source.activeWorkPlane.origin = { x: 2, y: 3, z: 4 };
    loadProject(target, serializeProject(source));
    expect(target.entities[0].type).toBe('rectangle');
    expect(target.solids[0].mesh.positions).toBeInstanceOf(Float32Array);
    expect(target.solids[0].mesh.indices).toBeInstanceOf(Uint32Array);
    expect(target.activeWorkPlane.origin).toEqual({ x: 2, y: 3, z: 4 });
  });

  it('round-trips a reversible chamfer with a JSON-safe source mesh', () => {
    const source = new Document();
    const base: PrimitiveFeature = {
      kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 10, depth: 6, height: 4,
    };
    const mesh = primitiveMesh(base);
    const feature: EdgeModificationFeature = {
      kind: 'edge-modification', operation: 'chamfer', source: base, amount: 1, amount2: 2,
      edge: {
        solidId: 'box', start: { x: 5, y: 3, z: 0 }, end: { x: 5, y: 3, z: 4 },
        normalA: { x: 1, y: 0, z: 0 }, normalB: { x: 0, y: 1, z: 0 },
      },
      sourceMesh: { positions: Array.from(mesh.positions), indices: Array.from(mesh.indices) },
    };
    source.addSolid(source.createSolid(mesh, 'Chamfered box', 4, [], undefined, feature));
    const target = new Document();

    loadProject(target, serializeProject(source));

    expect(target.solids[0].feature).toMatchObject({ kind: 'edge-modification', amount: 1, amount2: 2 });
    if (target.solids[0].feature.kind !== 'edge-modification') throw new Error('expected an edge feature');
    // The regenerable source (a primitive) means the baked sourceMesh is dropped
    // on save to keep the file small; the source round-trips and rebuilds it.
    expect(target.solids[0].feature.sourceMesh).toBeUndefined();
    expect(target.solids[0].feature.source).toMatchObject({ kind: 'primitive', primitive: 'box' });
  });

  it('round-trips an editable bounded PressPull region', () => {
    const source = new Document();
    const base: PrimitiveFeature = {
      kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 10, depth: 6, height: 4,
    };
    const mesh = primitiveMesh(base);
    const face = solidPlanarFaces(mesh).find((candidate) => candidate.normal.z > 0.9)!;
    const feature: PressPullFeature = {
      kind: 'presspull-region', source: base, distance: 3,
      region: { plane: face.plane, loops: face.loops },
      sourceMesh: { positions: Array.from(mesh.positions), indices: Array.from(mesh.indices) },
    };
    source.addSolid(source.createSolid(mesh, 'Pulled box', 7, [], undefined, feature));
    const target = new Document();

    loadProject(target, serializeProject(source));

    expect(target.solids[0].feature).toMatchObject({ kind: 'presspull-region', distance: 3 });
    if (target.solids[0].feature.kind !== 'presspull-region') throw new Error('expected a PressPull feature');
    expect(target.solids[0].feature.region.loops).toEqual(JSON.parse(JSON.stringify(face.loops)));
    // Regenerable source → the baked sourceMesh is dropped on save.
    expect(target.solids[0].feature.sourceMesh).toBeUndefined();
    expect(target.solids[0].feature.source).toMatchObject({ kind: 'primitive', primitive: 'box' });
  });

  it('keeps the sourceMesh when the source is a baked mesh with no recipe', () => {
    const source = new Document();
    const mesh = primitiveMesh({ kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 10, depth: 6, height: 4 });
    const feature: EdgeModificationFeature = {
      kind: 'edge-modification', operation: 'chamfer', source: { kind: 'mesh' }, amount: 1, amount2: 2,
      edge: {
        solidId: 'box', start: { x: 5, y: 3, z: 0 }, end: { x: 5, y: 3, z: 4 },
        normalA: { x: 1, y: 0, z: 0 }, normalB: { x: 0, y: 1, z: 0 },
      },
      sourceMesh: { positions: Array.from(mesh.positions), indices: Array.from(mesh.indices) },
    };
    source.addSolid(source.createSolid(mesh, 'Chamfered mesh', 4, [], undefined, feature));
    const target = new Document();

    loadProject(target, serializeProject(source));

    // No recipe to rebuild from → the snapshot must survive the round-trip.
    if (target.solids[0].feature.kind !== 'edge-modification') throw new Error('expected an edge feature');
    expect(target.solids[0].feature.sourceMesh?.positions).toEqual(Array.from(mesh.positions));
  });

  it('round-trips EXTRUDE direction, taper and path recipes', () => {
    const source = new Document();
    const profile = source.createRectangle({ x: 0, y: 0 }, { x: 5, y: 4 });
    const path = source.createLine({ x: 0, y: 0 }, { x: 12, y: 0 });
    const placeholder = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
    const directed: ExtrusionFeature = {
      kind: 'extrusion', profile, height: Math.hypot(3, 8), direction: { x: 3, y: 0, z: 8 }, taperAngle: 4,
      transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
    };
    const alongPath: SweepFeature = { kind: 'sweep', createdBy: 'extrude', profile, path };
    source.solids.push(
      source.createSolid(placeholder, 'Direction', directed.height, [profile.id], undefined, directed),
      source.createSolid(placeholder, 'Path', 0, [profile.id, path.id], undefined, alongPath),
    );
    const target = new Document();

    loadProject(target, serializeProject(source));

    expect(target.solids[0].feature).toMatchObject({ kind: 'extrusion', direction: { x: 3, y: 0, z: 8 }, taperAngle: 4 });
    expect(target.solids[1].feature).toMatchObject({ kind: 'sweep', createdBy: 'extrude', profile: { id: profile.id }, path: { id: path.id } });
  });

  it('round-trips named UCS shortcuts and restores the active origin and axes', () => {
    const source = new Document();
    const firstPlane = { ...source.activeWorkPlane, origin: { x: 10, y: 20, z: 30 } };
    const secondPlane = {
      origin: { x: 4, y: 5, z: 6 },
      xAxis: { x: 0, y: 1, z: 0 },
      yAxis: { x: 0, y: 0, z: 1 },
      zAxis: { x: 1, y: 0, z: 0 },
    };
    source.addNamedWorkPlane(firstPlane, 'Table');
    const active = source.addNamedWorkPlane(secondPlane, 'Vice origin');
    const target = new Document();

    loadProject(target, serializeProject(source));

    expect(target.namedWorkPlanes.map((item) => item.name)).toEqual(['Table', 'Vice origin']);
    expect(target.activeNamedWorkPlaneId).toBe(active.id);
    expect(target.activeWorkPlane).toEqual(secondPlane);
    expect(target.activeWorkPlane).not.toBe(target.namedWorkPlanes[1].workPlane);
    expect(target.viewMode).toBe('3d');
  });

  it('ignores invalid saved UCS entries instead of loading broken axes', () => {
    const source = new Document();
    const saved = JSON.parse(serializeProject(source));
    saved.settings.namedWorkPlanes = [
      { id: 'good', name: 'Good', workPlane: WORLD_WORK_PLANE },
      { id: 'bad', name: 'Bad', workPlane: { origin: { x: 'no', y: 0, z: 0 } } },
    ];
    saved.settings.activeNamedWorkPlaneId = 'bad';
    const target = new Document();

    loadProject(target, JSON.stringify(saved));

    expect(target.namedWorkPlanes.map((item) => item.id)).toEqual(['good']);
    expect(target.activeNamedWorkPlaneId).toBeNull();
  });

  it('round-trips drafting and dimension settings', () => {
    const source = new Document();
    source.drafting.orthoEnabled = true;
    source.drafting.polarEnabled = true;
    source.drafting.polarAngles = [15, 30, 90];
    source.drafting.objectSnapModes = ['end', 'perpendicular'];
    source.dimensionStyle = {
      textHeight: 3.5, arrowSize: 2, arrowType: 'open',
      extensionBeyond: 1.5, extensionOffset: 0.5, textOffset: 0.8,
      precision: 3, angularPrecision: 1, unitSuffix: 'mm',
      scale: 2, layer: 'dimensions',
    };
    const target = new Document();

    loadProject(target, serializeProject(source));

    expect(target.drafting).toEqual(source.drafting);
    expect(target.dimensionStyle).toEqual(source.dimensionStyle);
  });

  it('round-trips grid visibility and defaults older drawings to visible', () => {
    const source = new Document();
    source.gridVisible = false;
    const hidden = new Document();
    loadProject(hidden, serializeProject(source));
    expect(hidden.gridVisible).toBe(false);

    const older = JSON.parse(serializeProject(source));
    delete older.settings.gridVisible;
    const visible = new Document();
    visible.gridVisible = false;
    loadProject(visible, JSON.stringify(older));
    expect(visible.gridVisible).toBe(true);
  });

  it('round-trips per-layer line weight and line type', () => {
    const source = new Document();
    source.layers = ['0', 'walls', 'hidden'];
    source.layerLineweight = { '0': 0.25, walls: 0.7, hidden: 0.18 };
    source.layerLinetype = { '0': 'Continuous', walls: 'Continuous', hidden: 'Hidden' };
    const target = new Document();

    loadProject(target, serializeProject(source));

    expect(target.layerLineweight).toEqual(source.layerLineweight);
    expect(target.layerLinetype).toEqual(source.layerLinetype);
  });

  it('gives an older project without line styles the plain defaults', () => {
    const source = new Document();
    source.layers = ['0', 'extra'];
    const saved = JSON.parse(serializeProject(source));
    delete saved.settings.layerLineweight;
    delete saved.settings.layerLinetype;
    const target = new Document();

    loadProject(target, JSON.stringify(saved));

    expect(target.layerLineweight).toEqual({ '0': 0.25, extra: 0.25 });
    expect(target.layerLinetype).toEqual({ '0': 'Continuous', extra: 'Continuous' });
  });

  it('round-trips the plotter settings, which belong to the drawing', () => {
    const source = new Document();
    source.gcode = {
      feedRate: 1200,
      travelRate: 3000,
      penUpCode: 'M9',
      penDownCode: 'M8',
      penDelayMs: 200,
      homingCode: 'G28',
      frameVisible: true,
      frameWidth: 420,
      frameHeight: 297,
      frameOriginX: -10,
      frameOriginY: 20,
      segments: 128,
      holeMode: 'drill',
    };
    const target = new Document();

    loadProject(target, serializeProject(source));

    expect(target.gcode).toEqual(source.gcode);
  });

  it('round-trips native hatches and their drawing defaults', () => {
    const source = new Document();
    source.hatch = { pattern: 'cross', angle: 60, spacing: 4 };
    source.addEntity(source.createHatch([[{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 6 }, { x: 0, y: 6 }]]));
    const target = new Document();

    loadProject(target, serializeProject(source));

    expect(target.hatch).toEqual(source.hatch);
    expect(target.entities[0]).toMatchObject({ type: 'hatch', pattern: 'cross', angle: 60, spacing: 4 });
    expect(target.entities[0].type === 'hatch' && target.entities[0].patternLines).toHaveLength(2);
  });

  it('refuses plotter settings a machine could not use', () => {
    const source = new Document();
    const saved = JSON.parse(serializeProject(source));
    saved.settings.gcode = { feedRate: 0, travelRate: -5, penUpCode: '', penDownCode: 3, homingCode: ' ', segments: 1 };
    const target = new Document();

    loadProject(target, JSON.stringify(saved));

    expect(target.gcode).toEqual({
      feedRate: 4000,
      travelRate: 6000,
      penUpCode: 'M5',
      penDownCode: 'M3 S19',
      penDelayMs: 100,
      homingCode: '$H',
      frameVisible: false,
      frameWidth: 297,
      frameHeight: 210,
      frameOriginX: 0,
      frameOriginY: 0,
      segments: 64,
      holeMode: 'contour',
    });
  });

  it('adds command defaults when loading a project saved before command-driven pen control', () => {
    const source = new Document();
    const saved = JSON.parse(serializeProject(source));
    saved.settings.gcode = { feedRate: 900, travelRate: 1800, cutDepth: 0, safeHeight: 5, segments: 32 };
    const target = new Document();

    loadProject(target, JSON.stringify(saved));

    expect(target.gcode).toEqual({
      feedRate: 900,
      travelRate: 1800,
      penUpCode: 'M5',
      penDownCode: 'M3 S19',
      penDelayMs: 100,
      homingCode: '$H',
      frameVisible: false,
      frameWidth: 297,
      frameHeight: 210,
      frameOriginX: 0,
      frameOriginY: 0,
      segments: 32,
      holeMode: 'contour',
    });
  });

  it('uses drafting defaults when loading an older project', () => {
    const source = new Document();
    const saved = JSON.parse(serializeProject(source));
    delete saved.settings.drafting;
    delete saved.settings.dimensionStyle;
    const target = new Document();
    target.drafting.orthoEnabled = true;

    loadProject(target, JSON.stringify(saved));

    expect(target.drafting.orthoEnabled).toBe(false);
    expect(target.drafting.objectSnapModes).toEqual(['end']);
    expect(target.dimensionStyle.precision).toBe(2);
  });

  it('round-trips what a dimension measures and where its text was dragged', () => {
    const source = new Document();
    const dimension = source.createDimension({ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 1.5, y: 9 }, 'linear', 0);
    dimension.textPosition = { x: 8, y: 12 };
    source.addEntity(dimension);
    source.addEntity(source.createDimension({ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 6, y: 2 }, 'aligned'));
    const angular = source.createDimension({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, 'angular');
    angular.arcPoint = { x: 4, y: 4 };
    source.addEntity(angular);
    const target = new Document();

    loadProject(target, serializeProject(source));

    // Read back as 'aligned', a linear dimension would silently start measuring
    // the diagonal instead of the leg it was drawn to measure.
    const [linear, aligned, loadedAngular] = target.entities as Array<Extract<Document['entities'][number], { type: 'dimension' }>>;
    expect(linear.dimensionKind).toBe('linear');
    expect(linear.rotation).toBe(0);
    expect(linear.textPosition).toEqual({ x: 8, y: 12 });
    expect(aligned.dimensionKind).toBe('aligned');
    expect(aligned.textPosition).toBeUndefined();
    expect(loadedAngular.dimensionKind).toBe('angular');
    expect(loadedAngular.arcPoint).toEqual({ x: 4, y: 4 });
  });

  it('reads a dimension saved before the kinds were told apart as point-to-point', () => {
    const source = new Document();
    source.addEntity(source.createDimension({ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 6, y: 2 }, 'aligned'));
    const saved = JSON.parse(serializeProject(source));
    delete saved.entities[0].dimensionKind;
    const target = new Document();

    loadProject(target, JSON.stringify(saved));

    expect((target.entities[0] as { dimensionKind: string }).dimensionKind).toBe('aligned');
  });

  it('round-trips the saved 2D and 3D camera state', () => {
    const source = new Document();
    const view = {
      mode: '3d' as const,
      twoD: { pan: { x: 12, y: -8 }, zoom: 0.25 },
      threeD: {
        position: { x: 30, y: 20, z: -10 },
        target: { x: 5, y: 6, z: 7 },
        up: { x: 0, y: 1, z: 0 },
        projection: 'perspective' as const,
        orbitRadius: 40,
        activeStandardView: null,
      },
    };
    const target = new Document();
    const restored = loadProject(target, serializeProject(source, view));
    expect(restored).toEqual(view);
    expect(target.viewMode).toBe('3d');
  });
});
