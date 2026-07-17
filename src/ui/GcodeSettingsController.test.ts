// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import { exportGcode } from '../io/GcodeExport';
import { GcodeSettingsController } from './GcodeSettingsController';

function setup() {
  document.body.innerHTML = `
    <section id="panel" hidden></section>
    <form id="form">
      <input id="gcode-feed-rate" type="number">
      <input id="gcode-travel-rate" type="number">
      <input id="gcode-cut-depth" type="number">
      <input id="gcode-safe-height" type="number">
      <input id="gcode-segments" type="number">
    </form>
    <button id="toggle"></button>
    <button id="close"></button>`;
  const doc = new Document();
  const element = (id: string) => document.getElementById(id)!;
  const controller = new GcodeSettingsController(doc, element('form') as HTMLFormElement, vi.fn());
  // Wired the way main.ts wires it: the document tells the panel to redraw.
  doc.subscribe(() => controller.render());
  return { doc, controller };
}

const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const type = (id: string, value: string) => {
  field(id).value = value;
  field(id).dispatchEvent(new Event('input', { bubbles: true }));
};

describe('GcodeSettingsController', () => {
  it('shows what the document will be exported with', () => {
    const { controller } = setup();
    controller.render();
    expect(field('gcode-feed-rate').value).toBe('800');
    expect(field('gcode-cut-depth').value).toBe('0');
    expect(field('gcode-safe-height').value).toBe('5');
  });

  it('changes what comes out of the export', () => {
    const { doc, controller } = setup();
    controller.render();

    type('gcode-feed-rate', '1200');
    type('gcode-cut-depth', '-2');

    doc.addEntity(doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 }));
    expect(exportGcode(doc).gcode).toContain('G1 Z-2 F1200');
  });

  it('lets a field be cleared and retyped', () => {
    const { controller } = setup();
    controller.render();

    // Emptying a number field to type a new one sends '' — apply() must not
    // answer by writing the old value back, or the box can never be cleared.
    // Both sibling panels had exactly this bug.
    type('gcode-feed-rate', '');
    expect(field('gcode-feed-rate').value).toBe('');
    type('gcode-feed-rate', '450');
    expect(field('gcode-feed-rate').value).toBe('450');
  });

  it('keeps the last good value rather than an unusable one', () => {
    const { doc, controller } = setup();
    controller.render();

    type('gcode-feed-rate', '0');   // a plotter that never moves
    type('gcode-safe-height', '-1'); // a pen that lifts into the paper
    type('gcode-segments', '1');     // not a curve

    expect(doc.gcode.feedRate).toBe(800);
    expect(doc.gcode.safeHeight).toBe(5);
    expect(doc.gcode.segments).toBe(64);
  });

  it('takes a pen-down Z of zero or below, which the others could not', () => {
    const { doc, controller } = setup();
    controller.render();
    // A pen touches the paper at 0 and a knife goes under it, so the guard the
    // other fields use would refuse the ordinary case.
    type('gcode-cut-depth', '-3.5');
    expect(doc.gcode.cutDepth).toBe(-3.5);
    type('gcode-cut-depth', '0');
    expect(doc.gcode.cutDepth).toBe(0);
  });
});
