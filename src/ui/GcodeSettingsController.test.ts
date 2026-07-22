// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import { exportGcode } from '../io/GcodeExport';
import { GcodeSettingsController } from './GcodeSettingsController';

function setup() {
  document.body.innerHTML = `
    <section id="panel" hidden></section>
    <form id="form">
      <input id="gcode-homing-code" type="text">
      <input id="gcode-pen-up-code" type="text">
      <input id="gcode-pen-down-code" type="text">
      <input id="gcode-feed-rate" type="number">
      <input id="gcode-travel-rate" type="number">
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
    expect(field('gcode-homing-code').value).toBe('$H');
    expect(field('gcode-pen-up-code').value).toBe('M5');
    expect(field('gcode-pen-down-code').value).toBe('M3 S19');
    expect(field('gcode-travel-rate').value).toBe('6000');
    expect(field('gcode-feed-rate').value).toBe('4000');
  });

  it('changes what comes out of the export', () => {
    const { doc, controller } = setup();
    controller.render();

    type('gcode-feed-rate', '1200');
    type('gcode-pen-down-code', 'M3 S30');

    doc.addEntity(doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 }));
    expect(exportGcode(doc).gcode).toContain('M3 S30\nG1 X10 Y0 F1200');
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
    type('gcode-travel-rate', '-1'); // a travel that never reaches the work
    type('gcode-segments', '1');     // not a curve

    expect(doc.gcode.feedRate).toBe(4000);
    expect(doc.gcode.travelRate).toBe(6000);
    expect(doc.gcode.segments).toBe(64);
  });

  it('keeps the last usable command while a code field is empty', () => {
    const { doc, controller } = setup();
    controller.render();
    type('gcode-pen-up-code', '  ');
    expect(doc.gcode.penUpCode).toBe('M5');
    expect(field('gcode-pen-up-code').value).toBe('  ');
    type('gcode-pen-up-code', 'M9');
    expect(doc.gcode.penUpCode).toBe('M9');
  });
});
