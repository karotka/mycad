import { describe, expect, it } from 'vitest';
import { Document } from '../Document';
import { CommandHistory } from './CommandHistory';
import {
  AddEntityEdit,
  DeleteLayerEdit,
  ReplaceObjectsEdit,
  UpdateSolidEdit,
  cloneSolid,
} from './edits';

describe('CommandHistory', () => {
  it('uses a 0.5 mm model snap and a 1 mm display grid', () => {
    const doc = new Document();
    expect(doc.snapSize).toBe(0.5);
    expect(doc.gridSize).toBe(1);
  });

  it('undoes and redoes entity creation with a stable id', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const line = doc.createLine({ x: 0, y: 0 }, { x: 2, y: 1 });

    history.execute(new AddEntityEdit('line', line));
    expect(doc.entities.map((entity) => entity.id)).toEqual([line.id]);
    expect(history.undo()).toBe(true);
    expect(doc.entities).toHaveLength(0);
    expect(history.redo()).toBe(true);
    expect(doc.entities[0].id).toBe(line.id);
  });

  it('treats extrusion replacement as one notification and one undo step', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const circle = doc.createCircle({ x: 3, y: 4 }, 2);
    doc.addEntity(circle);
    const solid = doc.createSolid(
      { positions: new Float32Array([1, 2, 0, 3, 2, 0, 1, 4, 5]), indices: new Uint32Array([0, 1, 2]) },
      'extrusion', 5, [circle.id]
    );
    let notifications = 0;
    doc.subscribe(() => notifications++);

    history.execute(new ReplaceObjectsEdit('extrude', [circle], [], [], [solid]));
    expect(notifications).toBe(1);
    expect(doc.entities).toHaveLength(0);
    expect(doc.solids[0].id).toBe(solid.id);

    history.undo();
    expect(notifications).toBe(2);
    expect(doc.entities[0].id).toBe(circle.id);
    expect(doc.solids).toHaveLength(0);
  });

  it('copies typed arrays for solid undo and redo', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const solid = doc.createSolid(
      { positions: new Float32Array([0, 0, 0, 1, 0, 1]), indices: new Uint32Array([0, 1]) },
      'solid', 1, []
    );
    doc.addSolid(solid);
    const before = cloneSolid(solid);
    solid.mesh.positions[5] = 3;
    solid.height = 3;
    const after = cloneSolid(solid);
    history.recordApplied(new UpdateSolidEdit('presspull', before, after));

    history.undo();
    expect(doc.solids[0].mesh.positions[5]).toBe(1);
    expect(doc.solids[0].height).toBe(1);
    history.redo();
    expect(doc.solids[0].mesh.positions[5]).toBe(3);
    expect(doc.solids[0].height).toBe(3);
  });

  it('clears redo after a new edit and respects the history limit', () => {
    const doc = new Document();
    const history = new CommandHistory(doc, 2);
    const first = doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 });
    const second = doc.createLine({ x: 0, y: 1 }, { x: 1, y: 1 });
    const third = doc.createLine({ x: 0, y: 2 }, { x: 1, y: 2 });
    history.execute(new AddEntityEdit('first', first));
    history.execute(new AddEntityEdit('second', second));
    history.execute(new AddEntityEdit('third', third));
    history.undo();
    history.execute(new AddEntityEdit('replacement', third));
    expect(history.canRedo).toBe(false);
    expect(history.undo()).toBe(true);
    expect(history.undo()).toBe(true);
    expect(history.undo()).toBe(false);
  });

  it('deletes a layer with its objects and restores everything on undo', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    doc.layers.push('Parts');
    doc.layerColors.Parts = 0x123456;
    doc.currentLayer = 'Parts';
    const line = doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 });
    doc.addEntity(line);
    const solid = doc.createSolid(
      { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
      'extrusion', 1, [],
    );
    doc.addSolid(solid);

    history.execute(new DeleteLayerEdit(doc, 'Parts'));
    expect(doc.layers).toEqual(['0']);
    expect(doc.entities).toHaveLength(0);
    expect(doc.solids).toHaveLength(0);
    expect(doc.currentLayer).toBe('0');

    history.undo();
    expect(doc.layers).toEqual(['0', 'Parts']);
    expect(doc.entities[0].id).toBe(line.id);
    expect(doc.solids[0].id).toBe(solid.id);
    expect(doc.layerColors.Parts).toBe(0x123456);
    expect(doc.currentLayer).toBe('Parts');
  });
});
