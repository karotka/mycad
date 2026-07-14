import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { CommandHistory } from '../core/history/CommandHistory';
import { GripController } from './GripController';

describe('GripController', () => {
  it('records a whole line move as one edit', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const grips = new GripController(doc, history);
    const line = doc.createLine({ x: 0, y: 0 }, { x: 2, y: 0 });
    doc.addEntity(line);
    doc.selectEntity(line.id);
    grips.mode = 'middle';

    grips.begin(line, undefined, 0, { x: 1, y: 0 });
    grips.update({ x: 3, y: 4 });
    grips.update({ x: 4, y: 5 });
    grips.commit();
    expect(doc.getEntity(line.id)).toMatchObject({ start: { x: 3, y: 5 }, end: { x: 5, y: 5 } });
    history.undo();
    expect(doc.getEntity(line.id)).toMatchObject({ start: { x: 0, y: 0 }, end: { x: 2, y: 0 } });
  });

  it('reshapes a closed polyline by dragging any vertex grip', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const grips = new GripController(doc, history);
    const polyline = doc.createPolyline([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 },
    ], true);
    doc.entities.push(polyline);
    doc.selectEntity(polyline.id);
    expect(grips.activeGrips()).toHaveLength(3);
    grips.begin(polyline, undefined, 0, { x: 0, y: 0 });
    grips.update({ x: 2, y: 3 });
    expect(polyline.vertices[0]).toEqual({ x: 2, y: 3 });
    expect(polyline.vertices.at(-1)).toEqual({ x: 2, y: 3 });
  });

  it('restores a drag on cancel without adding history', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const grips = new GripController(doc, history);
    const circle = doc.createCircle({ x: 1, y: 1 }, 2);
    doc.addEntity(circle);
    doc.selectEntity(circle.id);
    grips.mode = 'center';
    grips.begin(circle, undefined, 0, { x: 1, y: 1 });
    grips.update({ x: 8, y: 9 });
    grips.cancel();
    expect(doc.getEntity(circle.id)).toMatchObject({ center: { x: 1, y: 1 } });
    expect(history.canUndo).toBe(false);
  });

  it('reports a changed rectangle edge in millimetres', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const grips = new GripController(doc, history);
    const rectangle = doc.createRectangle({ x: 0, y: 0 }, { x: 10, y: 5 });
    doc.addEntity(rectangle);
    doc.selectEntity(rectangle.id);
    grips.mode = 'end';
    grips.begin(rectangle, undefined, 2, { x: 10, y: 5 });
    grips.update({ x: 14, y: 5 });
    expect(grips.changedDimension()).toBe('Edge: 14.00 mm');
  });

  it('shows automatic line grips and moves the line from its middle grip', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const grips = new GripController(doc, history);
    const line = doc.createLine({ x: 0, y: 0 }, { x: 4, y: 0 });
    doc.addEntity(line);
    doc.selectEntity(line.id);

    expect(grips.activeGrips()).toMatchObject([
      { index: 0, shape: 'square' },
      { index: 1, shape: 'square' },
      { index: 2, shape: 'edge', point: { x: 2, y: 0 } },
    ]);
    grips.begin(line, undefined, 2, { x: 2, y: 0 });
    grips.update({ x: 3, y: 2 });
    expect(line).toMatchObject({ start: { x: 1, y: 2 }, end: { x: 5, y: 2 } });
  });

  it('stretches only one rectangle edge from a middle grip', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const grips = new GripController(doc, history);
    const rectangle = doc.createRectangle({ x: 0, y: 0 }, { x: 10, y: 5 });
    doc.addEntity(rectangle);
    doc.selectEntity(rectangle.id);

    expect(grips.activeGrips()).toHaveLength(8);
    grips.begin(rectangle, undefined, 5, { x: 10, y: 2.5 });
    grips.update({ x: 14, y: 4 });
    expect(rectangle).toMatchObject({ first: { x: 0, y: 0 }, opposite: { x: 14, y: 5 } });
  });

  it('shows five circle grips and changes radius from a quadrant grip', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const grips = new GripController(doc, history);
    const circle = doc.createCircle({ x: 2, y: 3 }, 4);
    doc.addEntity(circle);
    doc.selectEntity(circle.id);

    expect(grips.activeGrips()).toHaveLength(5);
    grips.begin(circle, undefined, 1, { x: 6, y: 3 });
    grips.update({ x: 12, y: 3 });
    expect(circle.radius).toBe(10);
    expect(grips.changedDimension()).toBe('R 10.00 mm · Ø 20.00 mm');
  });
});
