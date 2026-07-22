import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { exportGcode } from './GcodeExport';
import { defaultGcodeOptions } from '../core/settings';
import { STROKE_FONT } from '../core/text/strokeFont';

function setup() {
  const doc = new Document();
  return doc;
}

describe('exportGcode', () => {
  it('homes before it moves', () => {
    const doc = setup();
    doc.addEntity(doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 }));
    const { gcode } = exportGcode(doc);
    const lines = gcode.split('\n');
    expect(lines.slice(0, 5)).toEqual(['; MyCAD G-code', 'G21 ; mm', 'G90 ; absolute', 'M5', '$H']);
    // Homing after a move would drag the tool across the work to reach it.
    expect(lines.findIndex((line) => line === '$H')).toBeLessThan(
      lines.findIndex((line) => line.startsWith('G0 X') || line.startsWith('G1 X')),
    );
  });

  it('writes one pass per layer, in the order the layers are in', () => {
    const doc = setup();
    doc.layers = ['outline', 'holes'];
    const outline = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    outline.layer = 'outline';
    const hole = doc.createLine({ x: 2, y: 2 }, { x: 3, y: 3 });
    hole.layer = 'holes';
    // Added the other way round, so creation order cannot be what decides.
    doc.addEntity(hole);
    doc.addEntity(outline);

    const first = exportGcode(doc);
    expect(first.layers).toEqual(['outline', 'holes']);
    expect(first.gcode.indexOf('; --- layer: outline ---')).toBeLessThan(first.gcode.indexOf('; --- layer: holes ---'));

    // Dragging a layer in the panel reorders doc.layers, and the file follows.
    doc.layers = ['holes', 'outline'];
    const second = exportGcode(doc);
    expect(second.layers).toEqual(['holes', 'outline']);
    expect(second.gcode.indexOf('; --- layer: holes ---')).toBeLessThan(second.gcode.indexOf('; --- layer: outline ---'));
  });

  it('lifts the tool to travel and lowers it to cut', () => {
    const doc = setup();
    doc.addEntity(doc.createLine({ x: 0, y: 0 }, { x: 10, y: 5 }));
    const { gcode } = exportGcode(doc, {
      ...defaultGcodeOptions(),
      penUpCode: 'M9',
      penDownCode: 'M8',
      travelRate: 3000,
      feedRate: 1200,
    });
    expect(gcode).toContain('G0 X0 Y0 F3000\nM8\nG1 X10 Y5 F1200\nM9');
  });

  it('closes a closed path by returning to its first point', () => {
    const doc = setup();
    doc.addEntity(doc.createRectangle({ x: 0, y: 0 }, { x: 10, y: 5 }));
    const { gcode } = exportGcode(doc);
    const cuts = gcode.split('\n').filter((line) => line.startsWith('G1 X'));
    // Four corners to walk and then back to the start: an open rectangle would
    // leave the last side uncut.
    expect(cuts).toEqual([
      'G1 X10 Y0 F4000',
      'G1 X10 Y5 F4000',
      'G1 X0 Y5 F4000',
      'G1 X0 Y0 F4000',
    ]);
  });

  it('skips a hidden layer', () => {
    const doc = setup();
    doc.layers = ['0', 'draft'];
    const draft = doc.createLine({ x: 0, y: 0 }, { x: 1, y: 1 });
    draft.layer = 'draft';
    doc.addEntity(draft);
    doc.hiddenLayers.add('draft');
    const { gcode, layers } = exportGcode(doc);
    // Turning a layer off is how you say you do not want it; cutting it anyway
    // would be a surprise made of chips.
    expect(layers).toEqual([]);
    expect(gcode).not.toContain('G1 X');
  });

  it('reports a system font rather than dropping it silently', () => {
    const doc = setup();
    doc.addEntity(doc.createText({ x: 0, y: 0 }, 'HELLO', 5, 'Arial'));
    doc.addEntity(doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 }));
    const { skipped, gcode } = exportGcode(doc);
    // Its glyphs are filled outlines; following those engraves the edges of each
    // letter rather than the letter. Saying so is the difference between a known
    // gap and a file that quietly came out missing its label.
    expect(skipped).toEqual({ text: 1 });
    expect(gcode).toContain('G1 X10 Y0 F4000');
  });

  it('plots text in the single-stroke font', () => {
    const doc = setup();
    doc.addEntity(doc.createText({ x: 20, y: 10 }, 'AB', 5, STROKE_FONT));
    const { skipped, moveCount, gcode } = exportGcode(doc);

    expect(skipped).toEqual({});
    expect(moveCount).toBeGreaterThan(5);
    // Each run lifts the pen, travels to where the next begins and puts it down:
    // letters are strokes, not one continuous scribble.
    expect(gcode).toContain('M3 S19');
    expect(gcode.split('\n').filter((line) => line.startsWith('G0 X')).length).toBeGreaterThan(2);
    // And it lands where it was put.
    const first = gcode.split('\n').find((line) => line.startsWith('G0 X'))!;
    const [, x, y] = first.match(/G0 X([-\d.]+) Y([-\d.]+)/)!;
    expect(Number(x)).toBeGreaterThanOrEqual(20);
    expect(Number(y)).toBeGreaterThanOrEqual(10);
  });

  it('refuses geometry that does not lie on the world plane', () => {
    const doc = setup();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    line.workPlane = { origin: { x: 0, y: 0, z: 3 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 } };
    doc.addEntity(line);
    const { offPlane, moveCount } = exportGcode(doc);
    // The plotter file owns only world XY. Flattening this would put it in the
    // right apparent place on the wrong plane.
    expect(offPlane).toBe(1);
    expect(moveCount).toBe(0);
  });

  it('keeps the coordinates a work plane puts the drawing at', () => {
    const doc = setup();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    line.workPlane = { origin: { x: 100, y: 50, z: 0 }, xAxis: { x: 0, y: 1, z: 0 }, yAxis: { x: -1, y: 0, z: 0 }, zAxis: { x: 0, y: 0, z: 1 } };
    doc.addEntity(line);
    const { gcode } = exportGcode(doc);
    // Drawn along local X on a plane turned a quarter turn and moved: the file
    // says where it actually is in the world, which is what the screen shows.
    expect(gcode).toContain('G0 X100 Y50');
    expect(gcode).toContain('G1 X100 Y60 F4000');
  });

  it('ends by lifting the tool', () => {
    const doc = setup();
    doc.addEntity(doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 }));
    const gcode = exportGcode(doc).gcode;
    expect(gcode.endsWith('M5\nM2 ; end\n')).toBe(true);
  });
});
