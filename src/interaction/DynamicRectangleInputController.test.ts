import { describe, expect, it, vi } from 'vitest';
import { createDynamicRectangleInput, type DynamicRectangleInputElement } from './DynamicRectangleInputController';

function fakeInput(): DynamicRectangleInputElement & { listeners: Record<string, Array<(event: never) => void>> } {
  const listeners: Record<string, Array<(event: never) => void>> = {};
  const input = {
    value: '',
    hidden: true,
    style: { left: '', top: '' },
    select: vi.fn(),
    // A real `.focus()` call fires the element's own 'focus' listeners too —
    // needed since the controller focuses its sibling field programmatically
    // on Tab, and that must still flip the (un)focused-tracking state.
    focus: vi.fn(() => { for (const listener of listeners.focus ?? []) listener({} as never); }),
    addEventListener: (type: string, listener: (event: never) => void) => { (listeners[type] ??= []).push(listener); },
    listeners,
  };
  return input;
}

function fire(element: ReturnType<typeof fakeInput>, type: string, event: object = {}): void {
  for (const listener of element.listeners[type] ?? []) listener(event as never);
}

function setup() {
  const widthInput = fakeInput();
  const heightInput = fakeInput();
  const onCommit = vi.fn();
  let active = true;
  const controller = createDynamicRectangleInput({
    widthInput, heightInput,
    project: (point) => ({ x: point.x * 10, y: point.y * 10 }),
    isActive: () => active,
    onCommit,
  });
  return { widthInput, heightInput, onCommit, controller, setActive: (value: boolean) => { active = value; } };
}

describe('createDynamicRectangleInput', () => {
  it('shows and positions both boxes from the live cursor', () => {
    const { widthInput, heightInput, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 10, y: 4 });
    expect(widthInput.hidden).toBe(false);
    expect(heightInput.hidden).toBe(false);
    expect(widthInput.value).toBe('10.00');
    expect(heightInput.value).toBe('4.00');
    expect(widthInput.style.left).toBe('50px'); // midpoint x=5, projected *10
    expect(heightInput.style.left).toBe('100px'); // x=10, projected *10
  });

  it('does not overwrite a field the user is actively editing', () => {
    const { widthInput, heightInput, controller } = setup();
    fire(widthInput, 'focus');
    widthInput.value = '99';
    fire(widthInput, 'input');
    controller.update({ x: 0, y: 0 }, { x: 10, y: 4 });
    expect(widthInput.value).toBe('99'); // left alone
    expect(heightInput.value).toBe('4.00'); // still live-tracked
  });

  it('returns the effective corner — fixed on a typed axis, live on the other — so the drawn preview can match it', () => {
    const { widthInput, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 10, y: 4 });
    widthInput.value = '25';
    fire(widthInput, 'input');
    // The mouse keeps moving, but width is now fixed at 25; only height follows.
    const corner = controller.update({ x: 0, y: 0 }, { x: 12, y: 9 });
    expect(corner).toEqual({ x: 25, y: 9 });
  });

  it('keeps tracking the live cursor across repeated updates when nothing was typed', () => {
    // Regression test: update() writes its own live value into `.value` every
    // call. Reading that back as a "typed override" on the next call would
    // latch the corner to whatever the first call happened to show, forever.
    const { widthInput, heightInput, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 10, y: 4 });
    expect(widthInput.value).toBe('10.00');
    expect(heightInput.value).toBe('4.00');
    controller.update({ x: 0, y: 0 }, { x: 30, y: 9 });
    expect(widthInput.value).toBe('30.00');
    expect(heightInput.value).toBe('9.00');
    expect(widthInput.style.left).toBe('150px'); // midpoint x=15, projected *10
  });

  it('Tab moves focus explicitly from width to height and back, regardless of DOM tab order', () => {
    const { widthInput, heightInput, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 10, y: 4 });
    fire(widthInput, 'focus');
    fire(widthInput, 'keydown', { key: 'Tab', preventDefault: () => {} });
    expect(heightInput.focus).toHaveBeenCalled();
    fire(heightInput, 'keydown', { key: 'Tab', preventDefault: () => {} });
    expect(widthInput.focus).toHaveBeenCalled();
  });

  it('commits through onCommit on Enter, using the typed override', () => {
    const { widthInput, controller, onCommit } = setup();
    controller.update({ x: 0, y: 0 }, { x: 10, y: 4 });
    widthInput.value = '25';
    fire(widthInput, 'input');
    fire(widthInput, 'keydown', { key: 'Enter', preventDefault: () => {} });
    expect(onCommit).toHaveBeenCalledWith({ x: 25, y: 4 });
  });

  it('clearing an overridden field back to empty returns that axis to live tracking', () => {
    const { widthInput, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 10, y: 4 });
    widthInput.value = '25';
    fire(widthInput, 'input');
    controller.update({ x: 0, y: 0 }, { x: 12, y: 4 }); // override still holds
    expect(widthInput.value).toBe('25.00');
    widthInput.value = '';
    fire(widthInput, 'input');
    controller.update({ x: 0, y: 0 }, { x: 12, y: 4 });
    expect(widthInput.value).toBe('12.00'); // back to following the cursor
  });

  it('hides and clears both boxes after a commit', () => {
    const { widthInput, heightInput, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 10, y: 4 });
    fire(widthInput, 'keydown', { key: 'Enter', preventDefault: () => {} });
    expect(widthInput.hidden).toBe(true);
    expect(heightInput.hidden).toBe(true);
    expect(widthInput.value).toBe('');
  });

  it('sync() hides the boxes once isActive() turns false — a command switch, cancel, grip release, or view change', () => {
    const { widthInput, controller, setActive } = setup();
    controller.update({ x: 0, y: 0 }, { x: 10, y: 4 });
    controller.sync();
    expect(widthInput.hidden).toBe(false); // still active — sync leaves it alone
    setActive(false);
    controller.sync();
    expect(widthInput.hidden).toBe(true);
  });
});

describe('createDynamicRectangleInput — updateEdge (a rectangle\'s mid-edge grips)', () => {
  it('shows only the width box for a horizontal-axis edge, at its own midpoint', () => {
    const { widthInput, heightInput, controller } = setup();
    // Right edge: x is free, fixed at first.x = 0; the edge spans y 0..5.
    const point = controller.updateEdge('x', 0, [0, 5], { x: 12, y: 2 });
    expect(point).toEqual({ x: 12, y: 2.5 });
    expect(widthInput.hidden).toBe(false);
    expect(widthInput.value).toBe('12.00');
    expect(heightInput.hidden).toBe(true);
    expect(widthInput.style.left).toBe('120px'); // x=12, projected *10
    expect(widthInput.style.top).toBe('25px'); // midpoint y=2.5, projected *10
  });

  it('shows only the height box for a vertical-axis edge', () => {
    const { widthInput, heightInput, controller } = setup();
    // Bottom edge: y is free, fixed at opposite.y = 5; the edge spans x 0..10.
    const point = controller.updateEdge('y', 5, [0, 10], { x: 3, y: -2 });
    expect(point).toEqual({ x: 5, y: -2 });
    expect(heightInput.hidden).toBe(false);
    expect(heightInput.value).toBe('7.00'); // |−2 − 5|
    expect(widthInput.hidden).toBe(true);
  });

  it('fixes the one free axis at a typed magnitude, on the cursor\'s side', () => {
    const { widthInput, controller } = setup();
    controller.updateEdge('x', 0, [0, 5], { x: 12, y: 2 });
    widthInput.value = '30';
    fire(widthInput, 'input');
    const point = controller.updateEdge('x', 0, [0, 5], { x: 12, y: 2 }); // cursor unchanged, now overridden
    expect(point).toEqual({ x: 30, y: 2.5 });
  });

  it('commits through onCommit on Enter, same as the corner-mode boxes', () => {
    const { widthInput, controller, onCommit } = setup();
    controller.updateEdge('x', 0, [0, 5], { x: 12, y: 2 });
    fire(widthInput, 'keydown', { key: 'Enter', preventDefault: () => {} });
    expect(onCommit).toHaveBeenCalledWith({ x: 12, y: 2.5 });
  });
});
