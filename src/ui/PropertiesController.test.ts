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
});
