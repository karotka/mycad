// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import { cloneWorkPlane, WORLD_WORK_PLANE } from '../math/workplane';
import { NamedUcsController } from './NamedUcsController';

function setup() {
  document.body.innerHTML = '<button id="wcs"></button><div id="list"></div>';
  const doc = new Document();
  const callbacks = {
    beforeWorkPlaneChange: vi.fn(),
    workPlaneChanged: vi.fn(),
    log: vi.fn(),
  };
  const controller = new NamedUcsController(
    doc,
    document.getElementById('list')!,
    document.getElementById('wcs') as HTMLButtonElement,
    callbacks,
  );
  doc.subscribe(() => controller.render());
  controller.render();
  return { doc, callbacks };
}

const customPlane = (originX: number) => {
  const plane = cloneWorkPlane(WORLD_WORK_PLANE);
  plane.origin.x = originX;
  return plane;
};

describe('NamedUcsController', () => {
  it('adds one editable shortcut for every saved UCS and marks the active one', () => {
    const { doc } = setup();
    const first = doc.addNamedWorkPlane(customPlane(10));
    const second = doc.addNamedWorkPlane(customPlane(20));

    expect(doc.namedWorkPlanes.map((item) => item.name)).toEqual(['UCS 1', 'UCS 2']);
    expect(document.querySelectorAll('.named-ucs-item')).toHaveLength(2);
    expect(document.querySelector(`[data-ucs-id="${second.id}"]`)?.classList.contains('active')).toBe(true);
    expect(document.querySelector<HTMLInputElement>(`[data-ucs-id="${first.id}"] input`)?.value).toBe('UCS 1');
  });

  it('renames and activates a saved UCS without sharing its stored plane', () => {
    const { doc, callbacks } = setup();
    const first = doc.addNamedWorkPlane(customPlane(10));
    doc.addNamedWorkPlane(customPlane(20));
    const name = document.querySelector<HTMLInputElement>(`[data-ucs-id="${first.id}"] input`)!;
    expect(name.readOnly).toBe(true);
    name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(name.readOnly).toBe(false);
    name.value = 'Vice origin';
    name.dispatchEvent(new FocusEvent('blur'));

    document.querySelector<HTMLButtonElement>(`[data-ucs-id="${first.id}"] .named-ucs-activate`)!.click();

    expect(doc.namedWorkPlanes[0].name).toBe('Vice origin');
    expect(doc.activeNamedWorkPlaneId).toBe(first.id);
    expect(doc.activeWorkPlane.origin.x).toBe(10);
    expect(callbacks.workPlaneChanged).toHaveBeenCalledOnce();
    doc.activeWorkPlane.origin.x = 99;
    expect(doc.namedWorkPlanes[0].workPlane.origin.x).toBe(10);
  });

  it('activates from a single click on the name but keeps double-click for editing', () => {
    vi.useFakeTimers();
    const { doc } = setup();
    const first = doc.addNamedWorkPlane(customPlane(10));
    const second = doc.addNamedWorkPlane(customPlane(20));
    let name = document.querySelector<HTMLInputElement>(`[data-ucs-id="${first.id}"] input`)!;

    name.click();
    expect(doc.activeNamedWorkPlaneId).toBe(second.id);
    vi.advanceTimersByTime(220);
    expect(doc.activeNamedWorkPlaneId).toBe(first.id);

    name = document.querySelector<HTMLInputElement>(`[data-ucs-id="${first.id}"] input`)!;
    name.click();
    name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    vi.advanceTimersByTime(220);
    expect(name.readOnly).toBe(false);
    expect(doc.activeNamedWorkPlaneId).toBe(first.id);
    vi.useRealTimers();
  });

  it('changes no name without double-click and cancels an edit with Escape', () => {
    const { doc } = setup();
    const item = doc.addNamedWorkPlane(customPlane(10));
    let name = document.querySelector<HTMLInputElement>(`[data-ucs-id="${item.id}"] input`)!;
    name.value = 'Ignored';
    name.dispatchEvent(new FocusEvent('blur'));
    expect(doc.namedWorkPlanes[0].name).toBe('UCS 1');

    name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    name.value = 'Also ignored';
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    name = document.querySelector<HTMLInputElement>(`[data-ucs-id="${item.id}"] input`)!;
    expect(name.value).toBe('UCS 1');
    expect(doc.namedWorkPlanes[0].name).toBe('UCS 1');
  });

  it('deletes a shortcut with its cross and returns an active UCS to WCS', () => {
    const { doc, callbacks } = setup();
    const item = doc.addNamedWorkPlane(customPlane(10), 'Fixture');

    document.querySelector<HTMLButtonElement>(`[data-ucs-id="${item.id}"] .named-ucs-remove`)!.click();

    expect(doc.namedWorkPlanes).toEqual([]);
    expect(doc.activeNamedWorkPlaneId).toBeNull();
    expect(doc.activeWorkPlane).toEqual(WORLD_WORK_PLANE);
    expect(callbacks.beforeWorkPlaneChange).toHaveBeenCalledOnce();
    expect(callbacks.workPlaneChanged).toHaveBeenCalledOnce();
  });

  it('restores WCS from its permanent button without deleting saved UCS', () => {
    const { doc } = setup();
    doc.addNamedWorkPlane(customPlane(10));

    document.getElementById('wcs')!.click();

    expect(doc.namedWorkPlanes).toHaveLength(1);
    expect(doc.activeNamedWorkPlaneId).toBeNull();
    expect(document.getElementById('wcs')?.classList.contains('active')).toBe(true);
  });
});
