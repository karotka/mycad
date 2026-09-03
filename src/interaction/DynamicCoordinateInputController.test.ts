import { describe, expect, it, vi } from 'vitest';
import { createDynamicCoordinateInput, type DynamicCoordinateInputElement, type DynamicCoordinateLabelElement } from './DynamicCoordinateInputController';

function fakeInput(): DynamicCoordinateInputElement & { listeners: Record<string, Array<(event: never) => void>> } {
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

function fakeLabel(): DynamicCoordinateLabelElement {
  return { hidden: true, style: { left: '', top: '' } };
}

function fire(input: ReturnType<typeof fakeInput>, type: string, event: object = {}): void {
  for (const listener of input.listeners[type] ?? []) listener(event as never);
}

function setup() {
  const xInput = fakeInput();
  const yInput = fakeInput();
  const xLabel = fakeLabel();
  const yLabel = fakeLabel();
  const onCommit = vi.fn();
  let active = true;
  const controller = createDynamicCoordinateInput({
    xInput, yInput, xLabel, yLabel,
    project: (point) => ({ x: point.x * 10, y: point.y * 10 }),
    isActive: () => active,
    onCommit,
  });
  return { xInput, yInput, xLabel, yLabel, onCommit, controller, setActive: (value: boolean) => { active = value; } };
}

describe('createDynamicCoordinateInput', () => {
  it('shows and positions both boxes and their "x:"/"y:" prefixes, tracking the live cursor', () => {
    const { xInput, yInput, xLabel, yLabel, controller } = setup();
    const point = controller.update({ x: 3, y: 4 });
    expect(point).toEqual({ x: 3, y: 4 });
    expect(xInput.hidden).toBe(false);
    expect(xInput.value).toBe('3.00');
    expect(yInput.hidden).toBe(false);
    expect(yInput.value).toBe('4.00');
    expect(xLabel.hidden).toBe(false);
    expect(yLabel.hidden).toBe(false);
    const xScreen = Number.parseFloat(xInput.style.left);
    const yScreen = Number.parseFloat(yInput.style.left);
    const xLabelScreen = Number.parseFloat(xLabel.style.left);
    const yLabelScreen = Number.parseFloat(yLabel.style.left);
    // "x:" sits before the X box, "y:" sits between the two boxes.
    expect(xLabelScreen).toBeLessThan(xScreen);
    expect(yLabelScreen).toBeGreaterThan(xScreen);
    expect(yLabelScreen).toBeLessThan(yScreen);
  });

  it('auto-focuses the X box the moment it first appears — grip-editing keeps the pointer captured', () => {
    const { xInput, controller } = setup();
    controller.update({ x: 3, y: 4 });
    expect(xInput.focus).toHaveBeenCalledTimes(1);
  });

  it('does not keep re-focusing X on every later update — that would yank focus back from Y', () => {
    const { xInput, yInput, controller } = setup();
    controller.update({ x: 3, y: 4 });
    fire(yInput, 'focus');
    controller.update({ x: 5, y: 6 });
    expect(xInput.focus).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a field the user is actively editing', () => {
    const { xInput, yInput, controller } = setup();
    xInput.value = '99';
    fire(xInput, 'input');
    controller.update({ x: 3, y: 4 });
    expect(xInput.value).toBe('99');
    expect(yInput.value).toBe('4.00');
  });

  it('keeps tracking the live cursor across repeated updates when nothing was typed', () => {
    const { xInput, yInput, controller } = setup();
    controller.update({ x: 3, y: 4 });
    expect(xInput.value).toBe('3.00');
    expect(yInput.value).toBe('4.00');
    controller.update({ x: 7, y: -2 });
    expect(xInput.value).toBe('7.00');
    expect(yInput.value).toBe('-2.00');
  });

  it('Tab moves focus explicitly between X and Y, regardless of DOM tab order', () => {
    const { xInput, yInput, controller } = setup();
    controller.update({ x: 3, y: 4 });
    fire(xInput, 'focus');
    fire(xInput, 'keydown', { key: 'Tab', preventDefault: () => {} });
    expect(yInput.focus).toHaveBeenCalled();
    fire(yInput, 'keydown', { key: 'Tab', preventDefault: () => {} });
    expect(xInput.focus).toHaveBeenCalled();
  });

  it('commits through onCommit on Enter, using the typed overrides', () => {
    const { xInput, yInput, controller, onCommit } = setup();
    controller.update({ x: 3, y: 4 });
    xInput.value = '10';
    fire(xInput, 'input');
    yInput.value = '20';
    fire(yInput, 'input');
    fire(xInput, 'keydown', { key: 'Enter', preventDefault: () => {} });
    expect(onCommit).toHaveBeenCalledWith({ x: 10, y: 20 });
  });

  it('hides and clears both boxes and their prefixes after a commit', () => {
    const { xInput, yInput, xLabel, yLabel, controller } = setup();
    controller.update({ x: 3, y: 4 });
    fire(xInput, 'keydown', { key: 'Enter', preventDefault: () => {} });
    expect(xInput.hidden).toBe(true);
    expect(yInput.hidden).toBe(true);
    expect(xLabel.hidden).toBe(true);
    expect(yLabel.hidden).toBe(true);
    expect(xInput.value).toBe('');
  });

  it('sync() hides the boxes once isActive() turns false', () => {
    const { xInput, controller, setActive } = setup();
    controller.update({ x: 3, y: 4 });
    controller.sync();
    expect(xInput.hidden).toBe(false);
    setActive(false);
    controller.sync();
    expect(xInput.hidden).toBe(true);
  });
});
