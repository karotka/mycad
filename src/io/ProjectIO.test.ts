import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
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
    expect(saved.settings).toMatchObject({ gridSize: 1, snapSize: 0.5 });
    expect(saved.entities[0].type).toBe('rectangle');
    expect(saved.solids[0].mesh.positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 1]);
  });

  it('exports one STL facet for one indexed triangle', () => {
    const doc = new Document();
    doc.addSolid(doc.createSolid(
      { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
      'triangle', 0, []
    ));
    const stl = exportAsciiStl(doc);
    expect(stl.match(/facet normal/g)).toHaveLength(1);
    expect(stl).toContain('facet normal 0 0 1');
    expect(stl).toContain('vertex 1 0 0');
    expect(stl).toMatch(/^solid MyCAD/);
    expect(stl).toMatch(/endsolid MyCAD\n$/);
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
