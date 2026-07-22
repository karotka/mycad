import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { WORLD_WORK_PLANE } from '../math/workplane';
import type { EdgeModificationFeature, PrimitiveFeature } from '../core/entities/types';
import { primitiveMesh } from '../core/solids/ManifoldEngine';
import { exportAsciiStl, loadProject, serializeProject } from './ProjectIO';

describe('ProjectIO', () => {
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
    expect(saved).toMatchObject({ format: 'mycad', version: 1, units: 'mm' });
    expect(saved.settings).toMatchObject({ gridSize: 1, gridVisible: true, snapSize: 0.5 });
    expect(saved.entities[0].type).toBe('rectangle');
    expect(saved.solids[0].mesh.positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 1]);
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
      kind: 'edge-modification', operation: 'chamfer', source: base, amount: 1,
      edge: {
        solidId: 'box', start: { x: 5, y: 3, z: 0 }, end: { x: 5, y: 3, z: 4 },
        normalA: { x: 1, y: 0, z: 0 }, normalB: { x: 0, y: 1, z: 0 },
      },
      sourceMesh: { positions: Array.from(mesh.positions), indices: Array.from(mesh.indices) },
    };
    source.addSolid(source.createSolid(mesh, 'Chamfered box', 4, [], undefined, feature));
    const target = new Document();

    loadProject(target, serializeProject(source));

    expect(target.solids[0].feature).toMatchObject({ kind: 'edge-modification', amount: 1 });
    if (target.solids[0].feature.kind !== 'edge-modification') throw new Error('expected an edge feature');
    expect(target.solids[0].feature.sourceMesh.positions).toEqual(Array.from(mesh.positions));
    expect(Array.isArray(target.solids[0].feature.sourceMesh.positions)).toBe(true);
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
    source.dimensionStyle = { textHeight: 3.5, arrowSize: 2, arrowType: 'open', extensionBeyond: 1.5, extensionOffset: 0.5, textOffset: 0.8, precision: 3, scale: 2, layer: 'dimensions' };
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
    source.gcode = { feedRate: 1200, travelRate: 3000, cutDepth: -2.5, safeHeight: 8, segments: 128 };
    const target = new Document();

    loadProject(target, serializeProject(source));

    expect(target.gcode).toEqual(source.gcode);
  });

  it('refuses plotter settings a machine could not use', () => {
    const source = new Document();
    const saved = JSON.parse(serializeProject(source));
    saved.settings.gcode = { feedRate: 0, travelRate: -5, cutDepth: -3, safeHeight: 0, segments: 1 };
    const target = new Document();

    loadProject(target, JSON.stringify(saved));

    // A feed of zero never moves and a pen that lifts to 0 never lifts, so those
    // fall back — but a negative pen-down Z is a knife, and is kept.
    expect(target.gcode).toMatchObject({ feedRate: 800, travelRate: 2400, safeHeight: 5, segments: 64, cutDepth: -3 });
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
    expect(target.drafting.objectSnapModes).toEqual(['end', 'center', 'intersection']);
    expect(target.dimensionStyle.precision).toBe(2);
  });

  it('round-trips what a dimension measures and where its text was dragged', () => {
    const source = new Document();
    const dimension = source.createDimension({ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 1.5, y: 9 }, 'linear', 0);
    dimension.textPosition = { x: 8, y: 12 };
    source.addEntity(dimension);
    source.addEntity(source.createDimension({ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 6, y: 2 }, 'aligned'));
    const target = new Document();

    loadProject(target, serializeProject(source));

    // Read back as 'aligned', a linear dimension would silently start measuring
    // the diagonal instead of the leg it was drawn to measure.
    const [linear, aligned] = target.entities as Array<Extract<Document['entities'][number], { type: 'dimension' }>>;
    expect(linear.dimensionKind).toBe('linear');
    expect(linear.rotation).toBe(0);
    expect(linear.textPosition).toEqual({ x: 8, y: 12 });
    expect(aligned.dimensionKind).toBe('aligned');
    expect(aligned.textPosition).toBeUndefined();
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
