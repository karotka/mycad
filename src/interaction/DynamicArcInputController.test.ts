import { describe, expect, it, vi } from 'vitest';
import { createDynamicArcInput, type DynamicArcInputElement } from './DynamicArcInputController';

function fakeInput(): DynamicArcInputElement & { listeners: Record<string, Array<(event: never) => void>> } {
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

function fire(input: ReturnType<typeof fakeInput>, type: string, event: object = {}): void {
  for (const listener of input.listeners[type] ?? []) listener(event as never);
}

const START = { x: -3, y: 0 };
const END = { x: 3, y: 0 };

function setup() {
  const input = fakeInput();
  const onCommit = vi.fn();
  let active = true;
  const controller = createDynamicArcInput({
    input,
    project: (point) => ({ x: point.x * 10, y: point.y * 10 }),
    isActive: () => active,
    onCommit,
  });
  return { input, onCommit, controller, setActive: (value: boolean) => { active = value; } };
}

describe('createDynamicArcInput', () => {
  it('shows and positions the box at the live point, displaying the live radius', () => {
    const { input, controller } = setup();
    const point = controller.update(START, END, { x: 0, y: 1 });
    expect(point).toEqual({ x: 0, y: 1 });
    expect(input.hidden).toBe(false);
    expect(input.value).toBe('5.00'); // matches the arcFromSagitta example
    // Pushed 16px past the apex (0,10) in screen space, away from the chord
    // midpoint (0,0) — not sitting right on the point (and the cursor).
    expect(Number.parseFloat(input.style.left)).toBeCloseTo(0, 6);
    expect(Number.parseFloat(input.style.top)).toBeCloseTo(26, 6);
  });

  it('does not overwrite the box while the user is typing into it', () => {
    const { input, controller } = setup();
    input.value = '99';
    fire(input, 'input');
    controller.update(START, END, { x: 0, y: 1 });
    expect(input.value).toBe('99');
  });

  it('keeps tracking the live cursor across repeated updates when nothing was typed', () => {
    const { input, controller } = setup();
    controller.update(START, END, { x: 0, y: 1 });
    expect(input.value).toBe('5.00');
    controller.update(START, END, { x: 0, y: 8 });
    expect(input.value).not.toBe('5.00');
  });

  it('fixes the radius at a typed value, keeping the cursor\'s side', () => {
    const { input, controller } = setup();
    controller.update(START, END, { x: 0, y: 1 });
    input.value = '5';
    fire(input, 'input');
    const point = controller.update(START, END, { x: 0, y: 2 }); // cursor moves, radius stays fixed
    expect(point.y).toBeGreaterThan(0);
    expect(point.y).toBeCloseTo(1, 6); // the minor-arc sagitta for r=5 on this chord
  });

  it('hides (without a full reset) when the live cursor lands exactly on the chord', () => {
    const { input, controller } = setup();
    controller.update(START, END, { x: 0, y: 1 });
    expect(input.hidden).toBe(false);
    controller.update(START, END, { x: 0, y: 0 }); // exactly on the chord: no arc
    expect(input.hidden).toBe(true);
    controller.update(START, END, { x: 0, y: 2 }); // off the chord again
    expect(input.hidden).toBe(false);
  });

  it('commits through onCommit on Enter, using the typed override', () => {
    const { input, controller, onCommit } = setup();
    controller.update(START, END, { x: 0, y: 1 });
    input.value = '5';
    fire(input, 'input');
    fire(input, 'keydown', { key: 'Enter', preventDefault: () => {} });
    const [point] = onCommit.mock.calls[0];
    expect(point.y).toBeCloseTo(1, 6);
  });

  it('hides and clears the box after a commit', () => {
    const { input, controller } = setup();
    controller.update(START, END, { x: 0, y: 1 });
    fire(input, 'keydown', { key: 'Enter', preventDefault: () => {} });
    expect(input.hidden).toBe(true);
    expect(input.value).toBe('');
  });

  it('sync() hides the box once isActive() turns false', () => {
    const { input, controller, setActive } = setup();
    controller.update(START, END, { x: 0, y: 1 });
    controller.sync();
    expect(input.hidden).toBe(false);
    setActive(false);
    controller.sync();
    expect(input.hidden).toBe(true);
  });
});
