import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import { dimensionGeometry, type DimensionEntity } from '../core/entities/types';
import { CommandHistory } from '../core/history/CommandHistory';
import { PropertiesController } from './PropertiesController';
import { primitiveMesh } from '../core/solids/ManifoldEngine';

const element = (hidden = true) => ({ hidden, addEventListener: vi.fn() }) as unknown as HTMLElement;

describe('PropertiesController', () => {
  it('updates entity geometry through undoable history', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const circle = doc.createCircle({ x: 2, y: 3 }, 4);
    doc.addEntity(circle);
    doc.selectEntity(circle.id);
    const controller = new PropertiesController(doc, history, element(), element(), element(), element(), vi.fn());

    (controller as unknown as { updateOne(object: typeof circle, key: string, value: number): void })
      .updateOne(circle, 'radius', 8);

    expect(doc.getEntity(circle.id)).toMatchObject({ type: 'circle', radius: 8 });
    history.undo();
    expect(doc.getEntity(circle.id)).toMatchObject({ type: 'circle', radius: 4 });
  });

  it('edits dimension annotation and tolerance as undoable properties', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const dimension = doc.createDimension({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 4 }, 'aligned');
    doc.addEntity(dimension);
    const controller = new PropertiesController(doc, history, element(), element(), element(), element(), vi.fn());
    const update = (key: string, value: string | number): void => {
      const current = doc.getEntity(dimension.id) as DimensionEntity;
      (controller as unknown as { updateOne(object: DimensionEntity, key: string, value: string | number): void })
        .updateOne(current, key, value);
    };

    update('unitSuffix', 'mm');
    update('textPrefix', '4× ');
    update('textSuffix', ' TYP');
    update('toleranceMode', 'symmetric');
    update('toleranceUpper', 0.1);

    const formatted = doc.getEntity(dimension.id) as DimensionEntity;
    expect(dimensionGeometry(formatted).text).toBe('4× 10.00 ±0.10 mm TYP');
    history.undo();
    expect(dimensionGeometry(doc.getEntity(dimension.id) as DimensionEntity).text).toBe('4× 10.00 ±0.00 mm TYP');
  });

  it('keeps an ellipsoid an ellipsoid when its radius is edited', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const feature = {
      kind: 'primitive' as const, primitive: 'sphere' as const,
      center: { x: 0, y: 0 }, radius: 10, height: 20,
      scale: { x: 1, y: 1, z: 0.25 },
    };
    const solid = doc.createSolid(primitiveMesh(feature), 'Squashed', 20, [], 0xffffff, feature);
    doc.addSolid(solid);
    const controller = new PropertiesController(doc, history, element(), element(), element(), element(), vi.fn());

    (controller as unknown as { updateOne(object: typeof solid, key: string, value: number): void })
      .updateOne(solid, 'radius', 20);

    // The panel used to rebuild the mesh from its own copy of the engine's
    // switch, which knew nothing of scale — so editing the radius of a squashed
    // sphere silently inflated it back into a ball.
    const updated = doc.solids[0];
    let maxZ = -Infinity, maxX = -Infinity;
    for (let i = 0; i < updated.mesh.positions.length; i += 3) {
      maxX = Math.max(maxX, updated.mesh.positions[i]);
      maxZ = Math.max(maxZ, updated.mesh.positions[i + 2]);
    }
    expect(maxX).toBeCloseTo(20, 4);
    expect(maxZ).toBeCloseTo(5, 4);
  });

  const subtracted = (doc: Document) => {
    const feature = {
      kind: 'boolean' as const, operation: 'subtract' as const,
      operands: [
        { kind: 'primitive' as const, primitive: 'sphere' as const, center: { x: 0, y: 0 }, radius: 10, height: 20 },
        { kind: 'primitive' as const, primitive: 'cylinder' as const, center: { x: 0, y: 0 }, radius: 3, height: 30 },
      ],
    };
    // The mesh does not matter here; the recipe does.
    const solid = doc.createSolid(primitiveMesh(feature.operands[0]), 'Ball with a hole', 20, [], 0xffffff, feature);
    doc.addSolid(solid);
    return solid;
  };

  it('shows a composed solid its size but does not offer to change it', () => {
    const doc = new Document();
    const solid = subtracted(doc);
    doc.selectSolid(solid.id);
    const controller = new PropertiesController(doc, new CommandHistory(doc), element(), element(), element(), element(), vi.fn());

    const fields = (controller as unknown as { fields(object: typeof solid): Array<{ key: string; kind?: string }> }).fields(solid);

    // A subtraction has no width of its own — it is "this, less that", and its
    // size is its parts'. Typing here used to drag the vertices and throw the
    // recipe away, so the sphere stopped being a sphere.
    for (const key of ['width', 'depth', 'height']) {
      expect(fields.find((field) => field.key === key)?.kind, `${key} is editable`).toBe('readonly');
    }
    // Where it is remains a fair question, and one every feature can answer.
    for (const key of ['x', 'y', 'z']) {
      expect(fields.find((field) => field.key === key)?.kind).toBeUndefined();
    }
  });

  it('still lets a bare mesh be resized, having no recipe to lose', () => {
    const doc = new Document();
    const solid = doc.createSolid(
      primitiveMesh({ kind: 'primitive', primitive: 'sphere', center: { x: 0, y: 0 }, radius: 4, height: 8 }),
      'Imported', 8, [],
    );
    doc.addSolid(solid);
    doc.selectSolid(solid.id);
    const controller = new PropertiesController(doc, new CommandHistory(doc), element(), element(), element(), element(), vi.fn());

    const fields = (controller as unknown as { fields(object: typeof solid): Array<{ key: string; kind?: string }> }).fields(solid);
    expect(fields.find((field) => field.key === 'width')?.kind).toBeUndefined();
  });

  it('moves a composed solid without flattening it', () => {
    const doc = new Document();
    const solid = subtracted(doc);
    const controller = new PropertiesController(doc, new CommandHistory(doc), element(), element(), element(), element(), vi.fn());

    (controller as unknown as { updateOne(object: typeof solid, key: string, value: number): void })
      .updateOne(solid, 'x', 50);

    const moved = doc.solids[0];
    // Moving is the one thing every feature can say, so a move must never cost
    // the recipe — and both parts have to travel, or the hole stays behind.
    expect(moved.feature.kind).toBe('boolean');
    if (moved.feature.kind !== 'boolean') throw new Error('expected a boolean');
    for (const operand of moved.feature.operands) {
      if (operand.kind !== 'primitive') throw new Error('expected primitives');
      expect(operand.workPlane?.origin.x).toBeCloseTo(60, 4);
    }
    let minX = Infinity;
    for (let i = 0; i < moved.mesh.positions.length; i += 3) minX = Math.min(minX, moved.mesh.positions[i]);
    expect(minX).toBeCloseTo(50, 4);
  });

  it('moves a primitive without turning it into a mesh', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const feature = {
      kind: 'primitive' as const, primitive: 'sphere' as const,
      center: { x: 0, y: 0 }, radius: 5, height: 10,
    };
    const solid = doc.createSolid(primitiveMesh(feature), 'Ball', 10, [], 0xffffff, feature);
    doc.addSolid(solid);
    const controller = new PropertiesController(doc, history, element(), element(), element(), element(), vi.fn());

    // The X field reads the near edge of the bounds, so this asks to put the
    // sphere's left-hand side at 20 — its centre lands at 25.
    (controller as unknown as { updateOne(object: typeof solid, key: string, value: number): void })
      .updateOne(solid, 'x', 20);

    const updated = doc.solids[0];
    // Nudging a sphere along X used to drag its vertices and drop the feature,
    // so the sphere stopped being a sphere and its radius became unreachable.
    expect(updated.feature.kind).toBe('primitive');
    if (updated.feature.kind !== 'primitive') throw new Error('expected a primitive');
    expect(updated.feature.radius).toBe(5);
    expect(updated.feature.workPlane?.origin.x).toBeCloseTo(25, 4);
    let minX = Infinity;
    for (let i = 0; i < updated.mesh.positions.length; i += 3) minX = Math.min(minX, updated.mesh.positions[i]);
    expect(minX).toBeCloseTo(20, 4);
  });
});
