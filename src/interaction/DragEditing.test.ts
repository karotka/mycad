import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { CommandHistory } from '../core/history/CommandHistory';
import { createMoveEditing } from './DragEditing';

describe('solid move editing', () => {
  it('moves a mesh-only exact piece without making its B-rep stale', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const solid = doc.createSolid({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    }, 'Exact slice', 1, [], undefined, { kind: 'mesh' });
    solid.exact = {
      kernel: 'opencascade', revision: solid.revision,
      shape: { format: 'occt-brep-v1', data: 'fixture' },
    };
    doc.addSolid(solid);
    const editing = createMoveEditing({ doc, history });

    editing.moveObjects([solid.id], { x: 3, y: 4 });

    expect(doc.solids[0].mesh.positions.slice(0, 3)).toEqual(new Float32Array([3, 4, 0]));
    expect(doc.solids[0].exact).toMatchObject({
      revision: doc.solids[0].revision,
      transform: [1, 0, 0, 3, 0, 1, 0, 4, 0, 0, 1, 0],
    });
    history.undo();
    expect(doc.solids[0].mesh.positions.slice(0, 3)).toEqual(new Float32Array([0, 0, 0]));
    expect(doc.solids[0].exact?.transform).toBeUndefined();
  });
});
