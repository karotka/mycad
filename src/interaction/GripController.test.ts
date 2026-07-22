import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { CommandHistory } from '../core/history/CommandHistory';
import { GripController } from './GripController';
import type { EdgeModificationFeature, PrimitiveFeature } from '../core/entities/types';
import { primitiveMesh } from '../core/solids/ManifoldEngine';

describe('GripController', () => {
  it('moves a chamfer feature with a solid centre grip instead of leaving its history behind', () => {
    const doc = new Document();
    const grips = new GripController(doc, new CommandHistory(doc));
    const source: PrimitiveFeature = {
      kind: 'primitive', primitive: 'box', center: { x: 0, y: 0 }, width: 10, depth: 6, height: 4,
    };
    const mesh = primitiveMesh(source);
    const feature: EdgeModificationFeature = {
      kind: 'edge-modification', operation: 'chamfer', source, amount: 1,
      edge: {
        solidId: 'box', start: { x: 5, y: 3, z: 0 }, end: { x: 5, y: 3, z: 4 },
        normalA: { x: 1, y: 0, z: 0 }, normalB: { x: 0, y: 1, z: 0 },
      },
      sourceMesh: { positions: Array.from(mesh.positions), indices: Array.from(mesh.indices) },
    };
    const solid = doc.createSolid(mesh, 'Box', 4, [], undefined, feature);
    doc.addSolid(solid);
    doc.selectSolid(solid.id);
    grips.mode = 'center';

    grips.begin(undefined, solid, 0, { x: 0, y: 0 });
    grips.update({ x: 7, y: -2 });

    expect(solid.feature).toMatchObject({
      kind: 'edge-modification', edge: { start: { x: 12, y: 1, z: 0 } },
    });
  });

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

  it('accepts a signed relative distance for a selected edge grip', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const grips = new GripController(doc, history);
    const rectangle = doc.createRectangle({ x: 0, y: 0 }, { x: 10, y: 5 });
    doc.addEntity(rectangle);
    doc.selectEntity(rectangle.id);
    grips.begin(rectangle, undefined, 5, { x: 10, y: 2.5 });
    expect(grips.applyRelativeDistance(-3)).toBe(true);
    grips.commit();
    expect(rectangle.opposite.x).toBe(7);
    history.undo();
    expect(doc.getEntity(rectangle.id)).toMatchObject({ opposite: { x: 10, y: 5 } });
  });

  it('accepts relative cartesian and polar input while dragging a grip', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const grips = new GripController(doc, history);
    const line = doc.createLine({ x: 0, y: 0 }, { x: 4, y: 0 });
    doc.addEntity(line);
    doc.selectEntity(line.id);

    grips.begin(line, undefined, 0, { x: 0, y: 0 });
    expect(grips.applyRelativeOffset({ x: 3, y: -2 })).toBe(true);
    expect(doc.getEntity(line.id)).toMatchObject({ start: { x: 3, y: -2 } });

    grips.cancel();
    grips.begin(line, undefined, 1, { x: 4, y: 0 });
    expect(grips.applyRelativePolar(5, 90)).toBe(true);
    expect(doc.getEntity(line.id)).toMatchObject({ end: { x: 4, y: 5 } });
  });

  it('uses only an explicit endpoint anchor for line and polyline endpoint drags', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const grips = new GripController(doc, history);
    const line = doc.createLine({ x: 2, y: 3 }, { x: 9, y: 3 });
    doc.addEntity(line);
    doc.selectEntity(line.id);
    grips.begin(line, undefined, 0, { x: 2, y: 3 });
    expect(grips.endpointBase()).toBeNull();
    expect(grips.endpointGuide({ x: 4, y: 6 })).toBeNull();
    expect(grips.endpointBase({ x: 9, y: 3 })).toEqual({ x: 9, y: 3 });
    expect(grips.endpointGuide({ x: 4, y: 6 }, { x: 9, y: 3 })).toMatchObject({ lineStart: { x: 9, y: 3 } });
    grips.cancel();

    const polyline = doc.createPolyline([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 8, y: 3 },
      { x: 10, y: 6 },
    ], false);
    doc.addEntity(polyline);
    doc.selectEntity(polyline.id);

    grips.begin(polyline, undefined, 0, { x: 0, y: 0 });
    expect(grips.endpointBase()).toBeNull();
    expect(grips.endpointGuide({ x: -2, y: 5 })).toBeNull();
    expect(grips.endpointBase({ x: 10, y: 6 })).toEqual({ x: 10, y: 6 });
    expect(grips.endpointGuide({ x: -2, y: 5 }, { x: 10, y: 6 })).toMatchObject({ lineStart: { x: 10, y: 6 } });
    grips.cancel();
    grips.begin(polyline, undefined, 3, { x: 10, y: 6 });
    expect(grips.endpointBase()).toBeNull();
  });

  it('finds an anchor from another vertex on the same open polyline', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const grips = new GripController(doc, history);
    const polyline = doc.createPolyline([
      { x: 0, y: 0 },
      { x: 0, y: 5 },
      { x: 4, y: 5 },
      { x: 4, y: 0 },
    ], false);
    doc.addEntity(polyline);
    doc.selectEntity(polyline.id);

    grips.begin(polyline, undefined, 3, { x: 4, y: 0 });
    expect(grips.polylineEndpointAnchor({ x: 0.2, y: 4.8 }, 1)).toEqual({ x: 0, y: 5 });
  });

  it('uses an explicit anchor point for endpoint tracking', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const grips = new GripController(doc, history);
    const line = doc.createLine({ x: 0, y: 0 }, { x: 4, y: 0 });
    doc.addEntity(line);
    doc.selectEntity(line.id);

    grips.begin(line, undefined, 1, { x: 4, y: 0 });
    expect(grips.endpointBase({ x: 10, y: 6 })).toEqual({ x: 10, y: 6 });
    expect(grips.endpointGuide({ x: 12, y: 9 }, { x: 10, y: 6 })).toMatchObject({
      lineStart: { x: 10, y: 6 },
      snapPoint: { x: 10, y: 9 },
    });
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

  it('edits dimension definition points and dimension-line position with grips', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const grips = new GripController(doc, history);
    const dimension = doc.createDimension({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 4 });
    doc.addEntity(dimension); doc.selectEntity(dimension.id);

    expect(grips.activeGrips()).toHaveLength(3);
    grips.begin(dimension, undefined, 1, { x: 10, y: 0 });
    grips.update({ x: 12, y: 0 }); grips.commit();
    expect(dimension.end).toEqual({ x: 12, y: 0 });
    grips.begin(dimension, undefined, 2, { x: 6, y: 4 });
    grips.update({ x: 6, y: 7 }); grips.commit();
    expect(dimension.offset).toEqual({ x: 6, y: 7 });
  });
});

describe('endpoint alignment tracking', () => {
  // Acquiring an endpoint lays an alignment line through it. The dragged point
  // locks onto that line and slides along it — it must not be placeable off it.
  const dragging = () => {
    const doc = new Document();
    const grips = new GripController(doc, new CommandHistory(doc));
    const line = doc.createLine({ x: 0, y: 0 }, { x: 20, y: 20 });
    doc.addEntity(line);
    doc.selectEntity(line.id);
    grips.begin(line, undefined, 1, { x: 20, y: 20 });
    return { doc, grips };
  };

  const anchor = { x: 5, y: 40 };

  it('locks the point onto the anchor horizontal when the cursor runs sideways', () => {
    const { grips } = dragging();
    const guide = grips.endpointGuide({ x: 30, y: 38 }, anchor);
    // Cursor is further in x than in y, so the horizontal line through the anchor wins.
    expect(guide?.snapPoint).toMatchObject({ x: 30, y: anchor.y });
    expect(guide?.lineStart).toMatchObject(anchor);
  });

  it('locks the point onto the anchor vertical when the cursor runs up', () => {
    const { grips } = dragging();
    const guide = grips.endpointGuide({ x: 7, y: 90 }, anchor);
    expect(guide?.snapPoint).toMatchObject({ x: anchor.x, y: 90 });
  });

  it('slides the point along the line as the cursor moves', () => {
    const { grips } = dragging();
    const first = grips.endpointGuide({ x: 30, y: 38 }, anchor);
    const second = grips.endpointGuide({ x: 45, y: 41 }, anchor);
    // It follows the cursor along the line...
    expect(first?.snapPoint.x).toBeCloseTo(30);
    expect(second?.snapPoint.x).toBeCloseTo(45);
    // ...but never leaves it.
    expect(first?.snapPoint.y).toBeCloseTo(anchor.y);
    expect(second?.snapPoint.y).toBeCloseTo(anchor.y);
  });

  it('reports the line direction so the guide can be drawn', () => {
    const { grips } = dragging();
    expect(grips.endpointGuide({ x: 30, y: 38 }, anchor)?.angle).toBeCloseTo(0);
    expect(grips.endpointGuide({ x: 7, y: 90 }, anchor)?.angle).toBeCloseTo(90);
  });

  it('does nothing without an acquired anchor', () => {
    const { grips } = dragging();
    expect(grips.endpointGuide({ x: 30, y: 38 }, null)).toBeNull();
    expect(grips.endpointBase(null)).toBeNull();
  });
});

describe('edge grips follow their edge', () => {
  const rectangleGrips = () => {
    const doc = new Document();
    const grips = new GripController(doc, new CommandHistory(doc));
    const rectangle = doc.createRectangle({ x: 0, y: 0 }, { x: 20, y: 10 });
    doc.addEntity(rectangle);
    doc.selectEntity(rectangle.id);
    return grips;
  };

  const isHorizontal = (angle: number) => Math.abs(Math.sin(angle)) < 1e-9;
  const isVertical = (angle: number) => Math.abs(Math.cos(angle)) < 1e-9;

  // Both lists feed the renderer, so both must carry the angle.
  it.each([
    ['visibleGrips', (g: GripController) => g.visibleGrips()],
    ['activeGrips', (g: GripController) => g.activeGrips()],
  ])('%s gives every rectangle edge grip its edge angle', (_label, read) => {
    const edges = read(rectangleGrips()).filter((grip) => grip.shape === 'edge');
    expect(edges).toHaveLength(4);
    for (const edge of edges) expect(edge.angle, JSON.stringify(edge.point)).toBeTypeOf('number');

    // Two edges run along x, two along y — never all the same way.
    const horizontal = edges.filter((edge) => isHorizontal(edge.angle!));
    const vertical = edges.filter((edge) => isVertical(edge.angle!));
    expect(horizontal).toHaveLength(2);
    expect(vertical).toHaveLength(2);
  });

  it('turns the grip on a vertical edge upright', () => {
    const edges = rectangleGrips().visibleGrips().filter((grip) => grip.shape === 'edge');
    // The left and right edges sit at x = 0 and x = 20, midway up.
    const sides = edges.filter((edge) => Math.abs(edge.point.y - 5) < 1e-9);
    expect(sides).toHaveLength(2);
    for (const side of sides) expect(isVertical(side.angle!), `x=${side.point.x}`).toBe(true);
  });

  it('gives a line its own direction, not a fixed one', () => {
    const doc = new Document();
    const grips = new GripController(doc, new CommandHistory(doc));
    const line = doc.createLine({ x: 0, y: 0 }, { x: 0, y: 10 });
    doc.addEntity(line);
    doc.selectEntity(line.id);
    const edge = grips.visibleGrips().find((grip) => grip.shape === 'edge');
    expect(isVertical(edge!.angle!)).toBe(true);
  });
});
