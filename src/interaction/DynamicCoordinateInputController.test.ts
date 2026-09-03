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
  const commaLabel = fakeLabel();
  const onCommit = vi.fn();
  let active = true;
  const controller = createDynamicCoordinateInput({
    xInput, yInput, commaLabel,
    project: (point) => ({ x: point.x * 10, y: point.y * 10 }),
    isActive: () => active,
    onCommit,
  });
  return { xInput, yInput, commaLabel, onCommit, controller, setActive: (value: boolean) => { active = value; } };
}

describe('createDynamicCoordinateInput', () => {
  it('shows and positions both boxes and the comma, tracking the live cursor', () => {
    const { xInput, yInput, commaLabel, controller } = setup();
    const point = controller.update({ x: 3, y: 4 });
    expect(point).toEqual({ x: 3, y: 4 });
    expect(xInput.hidden).toBe(false);
    expect(xInput.value).toBe('3.00');
    expect(yInput.hidden).toBe(false);
    expect(yInput.value).toBe('4.00');
    expect(commaLabel.hidden).toBe(false);
    const xScreen = Number.parseFloat(xInput.style.left);
    const yScreen = Number.parseFloat(yInput.style.left);
    const commaScreen = Number.parseFloat(commaLabel.style.left);
    expect(commaScreen).toBeGreaterThan(xScreen);
    expect(commaScreen).toBeLessThan(yScreen);
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

  it('hides and clears both boxes and the comma after a commit', () => {
    const { xInput, yInput, commaLabel, controller } = setup();
    controller.update({ x: 3, y: 4 });
    fire(xInput, 'keydown', { key: 'Enter', preventDefault: () => {} });
    expect(xInput.hidden).toBe(true);
    expect(yInput.hidden).toBe(true);
    expect(commaLabel.hidden).toBe(true);
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
