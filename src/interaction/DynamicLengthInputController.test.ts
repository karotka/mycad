import { describe, expect, it, vi } from 'vitest';
import { createDynamicLengthInput, type DynamicLengthInputElement, type DynamicLengthLabelElement } from './DynamicLengthInputController';

function fakeInput(): DynamicLengthInputElement & { listeners: Record<string, Array<(event: never) => void>> } {
  const listeners: Record<string, Array<(event: never) => void>> = {};
  const input = {
    value: '',
    hidden: true,
    style: { left: '', top: '' },
    select: vi.fn(),
    focus: vi.fn(() => { for (const listener of listeners.focus ?? []) listener({} as never); }),
    addEventListener: (type: string, listener: (event: never) => void) => { (listeners[type] ??= []).push(listener); },
    listeners,
  };
  return input;
}

function fakeLabel(): DynamicLengthLabelElement {
  return { hidden: true, style: { left: '', top: '' } };
}

function fire(input: ReturnType<typeof fakeInput>, type: string, event: object = {}): void {
  for (const listener of input.listeners[type] ?? []) listener(event as never);
}

function setup() {
  const lengthInput = fakeInput();
  const angleInput = fakeInput();
  const separatorLabel = fakeLabel();
  const degreeLabel = fakeLabel();
  const onCommit = vi.fn();
  const onEmptyCommit = vi.fn();
  let active = true;
  const controller = createDynamicLengthInput({
    lengthInput, angleInput, separatorLabel, degreeLabel,
    project: (point) => ({ x: point.x * 10, y: point.y * 10 }),
    isActive: () => active,
    onCommit,
    onEmptyCommit,
  });
  return { lengthInput, angleInput, separatorLabel, degreeLabel, onCommit, onEmptyCommit, controller, setActive: (value: boolean) => { active = value; } };
}

describe('createDynamicLengthInput', () => {
  it('shows and positions both boxes, tracking the live cursor', () => {
    const { lengthInput, angleInput, controller } = setup();
    const point = controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: false });
    expect(point.x).toBeCloseTo(6, 6);
    expect(point.y).toBeCloseTo(8, 6);
    expect(lengthInput.hidden).toBe(false);
    expect(lengthInput.value).toBe('10.00'); // hypot(6,8)
    expect(angleInput.hidden).toBe(false);
    const angleDeg = Number(angleInput.value);
    expect(angleDeg).toBeCloseTo((Math.atan2(8, 6) * 180) / Math.PI, 1);
    expect(Number.parseFloat(lengthInput.style.left)).toBeCloseTo(30, 6); // midpoint (3,4), projected *10
    // The angle box sits a fixed screen-pixel offset to the right of the
    // length box, at the same height — not at the (world-space) start point.
    expect(Number.parseFloat(angleInput.style.left)).toBeCloseTo(30 + 84, 6);
    expect(angleInput.style.top).toBe(lengthInput.style.top);
  });

  it('shows the "<" between the boxes and the "°" after the angle box', () => {
    const { lengthInput, angleInput, separatorLabel, degreeLabel, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: false });
    const lengthX = Number.parseFloat(lengthInput.style.left);
    const angleX = Number.parseFloat(angleInput.style.left);
    expect(separatorLabel.hidden).toBe(false);
    expect(degreeLabel.hidden).toBe(false);
    const separatorX = Number.parseFloat(separatorLabel.style.left);
    const degreeX = Number.parseFloat(degreeLabel.style.left);
    // The separator sits strictly between the two boxes; the degree mark
    // strictly past the angle box's far side.
    expect(separatorX).toBeGreaterThan(lengthX);
    expect(separatorX).toBeLessThan(angleX);
    expect(degreeX).toBeGreaterThan(angleX);
  });

  it('hides the labels along with the boxes', () => {
    const { separatorLabel, degreeLabel, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: false });
    controller.hide();
    expect(separatorLabel.hidden).toBe(true);
    expect(degreeLabel.hidden).toBe(true);
  });

  it('does not auto-focus by default (drawing a new line/polyline never captures the pointer, so a click reaches it fine)', () => {
    const { lengthInput, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: false });
    expect(lengthInput.focus).not.toHaveBeenCalled();
  });

  it('auto-focuses the length box on first appearance when asked — grip-editing keeps the pointer captured', () => {
    const { lengthInput, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: false, autoFocus: true });
    expect(lengthInput.focus).toHaveBeenCalledTimes(1);
  });

  it('does not keep re-focusing length on every later update — that would yank focus back from angle', () => {
    const { lengthInput, angleInput, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: false, autoFocus: true });
    fire(angleInput, 'focus'); // user tabbed to angle
    controller.update({ x: 0, y: 0 }, { x: 9, y: 12 }, { emptyFinishes: false, autoFocus: true });
    expect(lengthInput.focus).toHaveBeenCalledTimes(1); // only the initial auto-focus
  });

  it('does not overwrite a field the user is actively editing', () => {
    const { lengthInput, angleInput, controller } = setup();
    lengthInput.value = '99';
    fire(lengthInput, 'input');
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: false });
    expect(lengthInput.value).toBe('99');
    expect(Number(angleInput.value)).not.toBeNaN(); // still live-tracked
  });

  it('keeps tracking the live cursor across repeated updates when nothing was typed', () => {
    const { lengthInput, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: false });
    expect(lengthInput.value).toBe('10.00');
    controller.update({ x: 0, y: 0 }, { x: 9, y: 12 }, { emptyFinishes: false });
    expect(lengthInput.value).toBe('15.00');
  });

  it('fixes the length at a typed value, keeping the live angle', () => {
    const { lengthInput, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: false });
    lengthInput.value = '20';
    fire(lengthInput, 'input');
    const point = controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: false });
    expect(point.x).toBeCloseTo(12, 6);
    expect(point.y).toBeCloseTo(16, 6);
  });

  it('fixes the angle at a typed value, keeping the live distance', () => {
    const { angleInput, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: false }); // distance 10
    angleInput.value = '0';
    fire(angleInput, 'input');
    const point = controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: false });
    expect(point.x).toBeCloseTo(10, 6);
    expect(point.y).toBeCloseTo(0, 6);
  });

  it('Tab moves focus explicitly between length and angle, regardless of DOM tab order', () => {
    const { lengthInput, angleInput, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: false });
    fire(lengthInput, 'focus');
    fire(lengthInput, 'keydown', { key: 'Tab', preventDefault: () => {} });
    expect(angleInput.focus).toHaveBeenCalled();
    fire(angleInput, 'keydown', { key: 'Tab', preventDefault: () => {} });
    expect(lengthInput.focus).toHaveBeenCalled();
  });

  it('commits through onCommit on Enter, using the typed overrides', () => {
    const { lengthInput, angleInput, controller, onCommit } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: false });
    lengthInput.value = '10';
    fire(lengthInput, 'input');
    angleInput.value = '180';
    fire(angleInput, 'input');
    fire(lengthInput, 'keydown', { key: 'Enter', preventDefault: () => {} });
    const [point] = onCommit.mock.calls[0];
    expect(point.x).toBeCloseTo(-10, 6);
    expect(point.y).toBeCloseTo(0, 6);
  });

  it('a bare Enter places the point at the live cursor when emptyFinishes is false (LINE)', () => {
    const { lengthInput, controller, onCommit, onEmptyCommit } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: false });
    fire(lengthInput, 'keydown', { key: 'Enter', preventDefault: () => {} });
    const [point] = onCommit.mock.calls[0];
    expect(point.x).toBeCloseTo(6, 6);
    expect(point.y).toBeCloseTo(8, 6);
    expect(onEmptyCommit).not.toHaveBeenCalled();
  });

  it('a bare Enter finishes early via onEmptyCommit when emptyFinishes is true (POLYLINE)', () => {
    const { lengthInput, controller, onCommit, onEmptyCommit } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: true });
    fire(lengthInput, 'keydown', { key: 'Enter', preventDefault: () => {} });
    expect(onEmptyCommit).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('only one overridden field still counts as "something typed" — not an empty-finish', () => {
    const { lengthInput, controller, onCommit, onEmptyCommit } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: true });
    lengthInput.value = '20';
    fire(lengthInput, 'input');
    fire(lengthInput, 'keydown', { key: 'Enter', preventDefault: () => {} });
    expect(onCommit).toHaveBeenCalled();
    expect(onEmptyCommit).not.toHaveBeenCalled();
  });

  it('hides and clears both boxes after a commit', () => {
    const { lengthInput, angleInput, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: false });
    fire(lengthInput, 'keydown', { key: 'Enter', preventDefault: () => {} });
    expect(lengthInput.hidden).toBe(true);
    expect(angleInput.hidden).toBe(true);
    expect(lengthInput.value).toBe('');
    expect(angleInput.value).toBe('');
  });

  it('sync() hides the boxes once isActive() turns false', () => {
    const { lengthInput, controller, setActive } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, { emptyFinishes: false });
    controller.sync();
    expect(lengthInput.hidden).toBe(false);
    setActive(false);
    controller.sync();
    expect(lengthInput.hidden).toBe(true);
  });
});

describe('createDynamicLengthInput — updateDiameter (CIRCLE\'s own radius step)', () => {
  it('shows only the length box, displaying the diameter — twice the centre-to-cursor distance', () => {
    const { lengthInput, angleInput, separatorLabel, degreeLabel, controller } = setup();
    // Centre-to-cursor distance is 5 (3-4-5 triangle); diameter is 10.
    const point = controller.updateDiameter({ x: 0, y: 0 }, { x: 3, y: 4 });
    expect(point.x).toBeCloseTo(3, 6);
    expect(point.y).toBeCloseTo(4, 6);
    expect(lengthInput.hidden).toBe(false);
    expect(lengthInput.value).toBe('10.00');
    expect(angleInput.hidden).toBe(true);
    expect(separatorLabel.hidden).toBe(true);
    expect(degreeLabel.hidden).toBe(true);
  });

  it('sits just outside the circle\'s own boundary point, not at the (inside) centre-to-point midpoint', () => {
    const { lengthInput, controller } = setup();
    controller.updateDiameter({ x: 0, y: 0 }, { x: 3, y: 4 });
    // project() is (x,y) -> (x*10, y*10): boundary point (3,4) projects to
    // (30,40), 50px from the projected centre (0,0). The box must sit
    // farther out than that — never at the (15,20) inside midpoint.
    const boxX = Number.parseFloat(lengthInput.style.left);
    const boxY = Number.parseFloat(lengthInput.style.top);
    const distanceFromCentre = Math.hypot(boxX, boxY);
    expect(distanceFromCentre).toBeGreaterThan(50);
  });

  it('fixes the point at half the typed diameter — the radius-equivalent distance', () => {
    const { lengthInput, controller } = setup();
    controller.updateDiameter({ x: 0, y: 0 }, { x: 3, y: 4 });
    lengthInput.value = '20'; // diameter 20 → radius 10
    fire(lengthInput, 'input');
    const point = controller.updateDiameter({ x: 0, y: 0 }, { x: 3, y: 4 });
    expect(point.x).toBeCloseTo(6, 6); // 10 * (3/5)
    expect(point.y).toBeCloseTo(8, 6); // 10 * (4/5)
  });

  it('commits through onCommit on Enter, converting the typed diameter to the underlying radius point', () => {
    const { lengthInput, controller, onCommit } = setup();
    controller.updateDiameter({ x: 0, y: 0 }, { x: 3, y: 4 });
    lengthInput.value = '20';
    fire(lengthInput, 'input');
    fire(lengthInput, 'keydown', { key: 'Enter', preventDefault: () => {} });
    const [point] = onCommit.mock.calls[0];
    expect(point.x).toBeCloseTo(6, 6);
    expect(point.y).toBeCloseTo(8, 6);
  });

  it('hides and clears after a commit, same as the polar (length/angle) mode', () => {
    const { lengthInput, angleInput, controller } = setup();
    controller.updateDiameter({ x: 0, y: 0 }, { x: 3, y: 4 });
    fire(lengthInput, 'keydown', { key: 'Enter', preventDefault: () => {} });
    expect(lengthInput.hidden).toBe(true);
    expect(angleInput.hidden).toBe(true);
    expect(lengthInput.value).toBe('');
  });

  it('does not auto-focus by default (drawing a new circle never captures the pointer)', () => {
    const { lengthInput, controller } = setup();
    controller.updateDiameter({ x: 0, y: 0 }, { x: 3, y: 4 });
    expect(lengthInput.focus).not.toHaveBeenCalled();
  });

  it('auto-focuses on first appearance when asked — grip-editing an existing circle keeps the pointer captured', () => {
    const { lengthInput, controller } = setup();
    controller.updateDiameter({ x: 0, y: 0 }, { x: 3, y: 4 }, true);
    expect(lengthInput.focus).toHaveBeenCalledTimes(1);
    controller.updateDiameter({ x: 0, y: 0 }, { x: 5, y: 5 }, true);
    expect(lengthInput.focus).toHaveBeenCalledTimes(1); // only the initial auto-focus
  });
});
