// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import { CommandHistory } from '../core/history/CommandHistory';
import type { ExtrusionFeature } from '../core/entities/types';
import { ModelTreeController } from './ModelTreeController';

/**
 * Drives the panel the way a user does — clicking rows, typing in fields — so
 * that the wiring between the tree and the engine is checked and not only the
 * arithmetic. This is the layer the report about extrusions came from, and the
 * layer nothing could reach before jsdom.
 */
function setup() {
  document.body.innerHTML = `
    <section id="panel" hidden></section>
    <div id="list"></div>
    <button id="toggle"></button>
    <button id="close"></button>`;
  const doc = new Document();
  const history = new CommandHistory(doc);
  const redraw = vi.fn();
  const log = vi.fn();
  const element = (id: string) => document.getElementById(id)!;
  const controller = new ModelTreeController(
    doc, history, element('panel'), element('list'), element('toggle'), element('close'), redraw, log,
  );
  doc.subscribe(() => controller.render());
  return { doc, history, controller, redraw, log };
}

function extrusion(doc: Document) {
  const profile = doc.createRectangle({ x: 0, y: 0 }, { x: 10, y: 5 });
  const feature: ExtrusionFeature = {
    kind: 'extrusion', profile, height: 10, workPlane: profile.workPlane,
    transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
  };
  const solid = doc.createSolid({ positions: new Float32Array(), indices: new Uint32Array() }, 'Extrusion_1', 10, [], undefined, feature);
  doc.addSolid(solid);
  return solid;
}

const rows = () => [...document.querySelectorAll<HTMLElement>('.tree-row')];
const rowLabelled = (label: string) => rows().find((row) => row.querySelector('.tree-label')?.textContent === label)!;
const fields = () => [...document.querySelectorAll<HTMLInputElement>('.tree-params input')];
const fieldLabelled = (label: string) => {
  const field = [...document.querySelectorAll<HTMLElement>('.tree-params .property-row')]
    .find((row) => row.querySelector('span')?.textContent === label);
  return field?.querySelector('input')!;
};

/** A number field reports a typed value on `change`, which blurring fires. */
function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('change'));
}

describe('ModelTreeController', () => {
  it('shows an extrusion and opens its values', () => {
    const { doc, controller } = setup();
    extrusion(doc);
    controller.toggle();

    expect(rows().map((row) => row.querySelector('.tree-label')?.textContent)).toEqual(['Extrusion_1', 'Extrusion']);
    expect(fields()).toHaveLength(0);

    rowLabelled('Extrusion').click();

    expect(fields().map((input) => input.value)).toEqual(['10', '1', '1', '0', '0', '0']);
  });

  it('rebuilds the solid when a value is typed', async () => {
    const { doc, controller } = setup();
    const solid = extrusion(doc);
    controller.toggle();
    rowLabelled('Extrusion').click();

    type(fieldLabelled('Height'), '25');
    await vi.waitFor(() => expect(doc.solids[0].revision).toBe(solid.revision + 1));

    const rebuilt = doc.solids[0];
    let maxZ = -Infinity;
    for (let i = 2; i < rebuilt.mesh.positions.length; i += 3) maxZ = Math.max(maxZ, rebuilt.mesh.positions[i]);
    expect(maxZ).toBeCloseTo(25, 4);
    expect((rebuilt.feature as ExtrusionFeature).height).toBe(25);
    // It stays an extrusion: rebuilding must not cost the history that built it.
    expect(rebuilt.feature.kind).toBe('extrusion');
  });

  it('keeps the row open and shows the new value afterwards', async () => {
    const { doc, controller } = setup();
    extrusion(doc);
    controller.toggle();
    rowLabelled('Extrusion').click();

    // Waiting on the field would prove nothing: it says 25 because that is what
    // was typed into it. The row is redrawn from the document.
    type(fieldLabelled('Height'), '25');
    await vi.waitFor(() => expect(rowLabelled('Extrusion').textContent).toContain('25 high'));

    // The row stays open, so the next value can be typed without hunting for it.
    expect(fieldLabelled('Height')).toBeTruthy();
  });

  it('undoes back to the shape it was', async () => {
    const { doc, history, controller } = setup();
    extrusion(doc);
    controller.toggle();
    rowLabelled('Extrusion').click();

    type(fieldLabelled('Height'), '25');
    await vi.waitFor(() => expect((doc.solids[0].feature as ExtrusionFeature).height).toBe(25));
    history.undo();

    expect((doc.solids[0].feature as ExtrusionFeature).height).toBe(10);
  });

  it('puts the field back and says so when the change cannot be built', async () => {
    const { doc, controller, log } = setup();
    extrusion(doc);
    controller.toggle();
    rowLabelled('Extrusion').click();

    type(fieldLabelled('Height'), '0');
    await vi.waitFor(() => expect(log).toHaveBeenCalled());

    expect(fieldLabelled('Height').value).toBe('10');
    // Silently restoring the field is indistinguishable from doing nothing.
    expect(log.mock.calls[0][0]).toContain('nothing to build');
  });
});
