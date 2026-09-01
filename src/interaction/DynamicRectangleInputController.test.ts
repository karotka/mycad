import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import { CommandHistory } from '../core/history/CommandHistory';
import { CommandManager } from '../core/commands/CommandManager';
import { createDynamicRectangleInput, type DynamicRectangleInputElement } from './DynamicRectangleInputController';

function fakeInput(): DynamicRectangleInputElement & { listeners: Record<string, Array<(event: never) => void>> } {
  const listeners: Record<string, Array<(event: never) => void>> = {};
  return {
    value: '',
    hidden: true,
    style: { left: '', top: '' },
    select: vi.fn(),
    addEventListener: (type, listener) => { (listeners[type] ??= []).push(listener as never); },
    listeners,
  };
}

function fire(element: ReturnType<typeof fakeInput>, type: string, event: object = {}): void {
  for (const listener of element.listeners[type] ?? []) listener(event as never);
}

function setup() {
  const doc = new Document();
  const commands = new CommandManager({
    doc,
    history: new CommandHistory(doc),
    moveObjects: vi.fn(),
    copyWorldDelta: () => undefined,
    log: vi.fn(),
    prompt: vi.fn(),
    getCursor: () => ({ x: 0, y: 0 }),
    redraw: vi.fn(),
  });
  const widthInput = fakeInput();
  const heightInput = fakeInput();
  const onCommit = vi.fn();
  const controller = createDynamicRectangleInput({
    widthInput, heightInput, commands, doc,
    project: (point) => ({ x: point.x * 10, y: point.y * 10 }),
    onCommit,
  });
  return { doc, commands, widthInput, heightInput, onCommit, controller };
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
    controller.update({ x: 0, y: 0 }, { x: 10, y: 4 });
    expect(widthInput.value).toBe('99'); // left alone
    expect(heightInput.value).toBe('4.00'); // still live-tracked
  });

  it('commits through onCommit on Enter, using the typed override', () => {
    const { widthInput, controller, onCommit } = setup();
    controller.update({ x: 0, y: 0 }, { x: 10, y: 4 });
    widthInput.value = '25';
    fire(widthInput, 'keydown', { key: 'Enter', preventDefault: () => {} });
    expect(onCommit).toHaveBeenCalledWith({ x: 25, y: 4 });
  });

  it('hides and clears both boxes after a commit', () => {
    const { widthInput, heightInput, controller } = setup();
    controller.update({ x: 0, y: 0 }, { x: 10, y: 4 });
    fire(widthInput, 'keydown', { key: 'Enter', preventDefault: () => {} });
    expect(widthInput.hidden).toBe(true);
    expect(heightInput.hidden).toBe(true);
    expect(widthInput.value).toBe('');
  });

  it('sync() hides the boxes once RECTANGLE is no longer on its second point', async () => {
    const { doc, commands, widthInput, controller } = setup();
    commands.startCommand('RECTANGLE');
    controller.update({ x: 0, y: 0 }, { x: 10, y: 4 });
    expect(widthInput.hidden).toBe(false);
    await commands.handleClick({ x: 5, y: 5 }); // places the first corner, advances to step 1
    controller.sync();
    expect(widthInput.hidden).toBe(false); // still on the pending second point
    doc.viewMode = '3d';
    controller.sync();
    expect(widthInput.hidden).toBe(true); // the prototype is 2D-only
  });
});
