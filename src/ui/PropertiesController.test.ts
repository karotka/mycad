import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
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
