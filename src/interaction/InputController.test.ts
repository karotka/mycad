import { describe, expect, it, vi } from 'vitest';
import { InputController } from './InputController';

function keyboard(key: string, options: Partial<KeyboardEvent> = {}): Event {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    code: { value: options.code ?? '' },
    metaKey: { value: options.metaKey ?? false },
    ctrlKey: { value: options.ctrlKey ?? false },
    altKey: { value: options.altKey ?? false },
    shiftKey: { value: options.shiftKey ?? false },
    repeat: { value: options.repeat ?? false },
  });
  return event;
}

describe('InputController', () => {
  it('routes shortcuts once and does not react to Command alone', () => {
    const target = new EventTarget();
    const input = { value: '', focus: vi.fn(), setSelectionRange: vi.fn() } as unknown as HTMLInputElement;
    const form = { requestSubmit: vi.fn() } as unknown as HTMLFormElement;
    const callbacks = {
      escape: vi.fn(), undo: vi.fn(), redo: vi.fn(), save: vi.fn(), saveAs: vi.fn(), newProject: vi.fn(),
      open: vi.fn(), export: vi.fn(), deleteSelection: vi.fn(() => false), show2d: vi.fn(),
      toggleObjectSnap: vi.fn(), toggleOrtho: vi.fn(), togglePolar: vi.fn(),
      toggleProperties: vi.fn(),
      commandActive: vi.fn(() => false), commandInputChanged: vi.fn(),
    };
    const controller = new InputController(input, form, callbacks, target);

    target.dispatchEvent(keyboard('Meta'));
    expect(callbacks.show2d).not.toHaveBeenCalled();
    target.dispatchEvent(keyboard('s', { metaKey: true }));
    expect(callbacks.save).toHaveBeenCalledOnce();
    target.dispatchEvent(keyboard('s', { metaKey: true, shiftKey: true }));
    expect(callbacks.saveAs).toHaveBeenCalledOnce();
    target.dispatchEvent(keyboard('z', { metaKey: true, shiftKey: true }));
    expect(callbacks.redo).toHaveBeenCalledOnce();
    target.dispatchEvent(keyboard('1', { ctrlKey: true }));
    expect(callbacks.toggleProperties).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('forwards viewport typing, Space and Delete through explicit callbacks', () => {
    const target = new EventTarget();
    const input = { value: '', focus: vi.fn(), setSelectionRange: vi.fn() } as unknown as HTMLInputElement;
    const form = { requestSubmit: vi.fn() } as unknown as HTMLFormElement;
    const callbacks = {
      escape: vi.fn(), undo: vi.fn(), redo: vi.fn(), save: vi.fn(), saveAs: vi.fn(), newProject: vi.fn(),
      open: vi.fn(), export: vi.fn(), deleteSelection: vi.fn(() => true), show2d: vi.fn(),
      toggleObjectSnap: vi.fn(), toggleOrtho: vi.fn(), togglePolar: vi.fn(),
      toggleProperties: vi.fn(),
      commandActive: vi.fn(() => false), commandInputChanged: vi.fn(),
    };
    const controller = new InputController(input, form, callbacks, target);

    target.dispatchEvent(keyboard('l'));
    expect(input.value).toBe('l');
    expect(callbacks.commandInputChanged).toHaveBeenCalledOnce();
    target.dispatchEvent(keyboard(' ', { code: 'Space' }));
    expect(callbacks.show2d).toHaveBeenCalledOnce();
    target.dispatchEvent(keyboard('Delete'));
    expect(callbacks.deleteSelection).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('routes standard CAD drafting function keys even while the command input is focused', () => {
    const target = new EventTarget();
    const input = { value: '', focus: vi.fn(), setSelectionRange: vi.fn(), tagName: 'INPUT' } as unknown as HTMLInputElement;
    const form = { requestSubmit: vi.fn() } as unknown as HTMLFormElement;
    const callbacks = {
      escape: vi.fn(), undo: vi.fn(), redo: vi.fn(), save: vi.fn(), saveAs: vi.fn(), newProject: vi.fn(),
      open: vi.fn(), export: vi.fn(), deleteSelection: vi.fn(() => false), show2d: vi.fn(),
      toggleObjectSnap: vi.fn(), toggleOrtho: vi.fn(), togglePolar: vi.fn(),
      toggleProperties: vi.fn(),
      commandActive: vi.fn(() => false), commandInputChanged: vi.fn(),
    };
    const controller = new InputController(input, form, callbacks, target);

    target.dispatchEvent(keyboard('F3'));
    target.dispatchEvent(keyboard('F8'));
    target.dispatchEvent(keyboard('F10'));

    expect(callbacks.toggleObjectSnap).toHaveBeenCalledOnce();
    expect(callbacks.toggleOrtho).toHaveBeenCalledOnce();
    expect(callbacks.togglePolar).toHaveBeenCalledOnce();
    controller.dispose();
  });
});
