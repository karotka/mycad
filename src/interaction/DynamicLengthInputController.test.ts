import { describe, expect, it, vi } from 'vitest';
import { createDynamicLengthInput, type DynamicLengthInputElement } from './DynamicLengthInputController';

function fakeInput(): DynamicLengthInputElement & { listeners: Record<string, Array<(event: never) => void>> } {
  const listeners: Record<string, Array<(event: never) => void>> = {};
  return {
    value: '',
    hidden: true,
    style: { left: '', top: '' },
    select: vi.fn(),
    addEventListener: (type: string, listener: (event: never) => void) => { (listeners[type] ??= []).push(listener); },
    listeners,
  };
}

function fire(input: ReturnType<typeof fakeInput>, type: string, event: object = {}): void {
  for (const listener of input.listeners[type] ?? []) listener(event as never);
}

function setup() {
  const input = fakeInput();
  const onCommit = vi.fn();
  const onEmptyCommit = vi.fn();
  let active = true;
  const controller = createDynamicLengthInput({
    input,
    project: (point) => ({ x: point.x * 10, y: point.y * 10 }),
    isActive: () => active,
    onCommit,
    onEmptyCommit,
  });
  return { input, onCommit, onEmptyCommit, controller, setActive: (value: boolean) => { active = value; } };
}

describe('createDynamicLengthInput', () => {
  it('shows and positions the box at the segment\'s midpoint, tracking the live cursor', () => {
    const { input, controller } = setup();
    const point = controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, false);
    expect(point).toEqual({ x: 6, y: 8 });
    expect(input.hidden).toBe(false);
    expect(input.value).toBe('10.00'); // 3-4-5-ish: hypot(6,8) = 10
    expect(input.style.left).toBe('30px'); // midpoint (3,4), projected *10
    expect(input.style.top).toBe('40px');
  });

  it('does not overwrite the box while the user is typing into it', () => {
    const { input, controller } = setup();
    input.value = '99';
    fire(input, 'input');
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, false);
    expect(input.value).toBe('99');
  });

  it('keeps tracking the live cursor across repeated updates when nothing was typed', () => {
    // Same regression shape as RECTANGLE: update()'s own live write must not
    // be mistaken for a typed override on the next call.
    const { input, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, false);
    expect(input.value).toBe('10.00');
    controller.update({ x: 0, y: 0 }, { x: 9, y: 12 }, false);
    expect(input.value).toBe('15.00');
  });

  it('fixes the length at a typed value, keeping the live direction', () => {
    const { input, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, false);
    input.value = '20';
    fire(input, 'input');
    const point = controller.update({ x: 0, y: 0 }, { x: 3, y: 4 }, false); // direction changes, length stays fixed
    expect(point.x).toBeCloseTo(12, 6);
    expect(point.y).toBeCloseTo(16, 6);
  });

  it('commits through onCommit on Enter, using the typed override', () => {
    const { input, controller, onCommit } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, false);
    input.value = '20';
    fire(input, 'input');
    fire(input, 'keydown', { key: 'Enter', preventDefault: () => {} });
    expect(onCommit).toHaveBeenCalledWith({ x: 12, y: 16 });
  });

  it('a bare Enter places the point at the live cursor when emptyFinishes is false (LINE)', () => {
    const { input, controller, onCommit, onEmptyCommit } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, false);
    fire(input, 'keydown', { key: 'Enter', preventDefault: () => {} });
    expect(onCommit).toHaveBeenCalledWith({ x: 6, y: 8 });
    expect(onEmptyCommit).not.toHaveBeenCalled();
  });

  it('a bare Enter finishes early via onEmptyCommit when emptyFinishes is true (POLYLINE)', () => {
    const { input, controller, onCommit, onEmptyCommit } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, true);
    fire(input, 'keydown', { key: 'Enter', preventDefault: () => {} });
    expect(onEmptyCommit).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('hides and clears the box after a commit', () => {
    const { input, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, false);
    fire(input, 'keydown', { key: 'Enter', preventDefault: () => {} });
    expect(input.hidden).toBe(true);
    expect(input.value).toBe('');
  });

  it('sync() hides the box once isActive() turns false', () => {
    const { input, controller, setActive } = setup();
    controller.update({ x: 0, y: 0 }, { x: 6, y: 8 }, false);
    controller.sync();
    expect(input.hidden).toBe(false);
    setActive(false);
    controller.sync();
    expect(input.hidden).toBe(true);
  });
});
