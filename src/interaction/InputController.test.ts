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
      toggleObjectSnap: vi.fn(), toggleDynamicUcs: vi.fn(), toggleGridDisplay: vi.fn(), toggleCutArea: vi.fn(), toggleOrtho: vi.fn(), togglePolar: vi.fn(),
      toggleGridSnap: vi.fn(), toggleObjectSnapTracking: vi.fn(),
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
      toggleObjectSnap: vi.fn(), toggleDynamicUcs: vi.fn(), toggleGridDisplay: vi.fn(), toggleCutArea: vi.fn(), toggleOrtho: vi.fn(), togglePolar: vi.fn(),
      toggleGridSnap: vi.fn(), toggleObjectSnapTracking: vi.fn(),
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
      toggleObjectSnap: vi.fn(), toggleDynamicUcs: vi.fn(), toggleGridDisplay: vi.fn(), toggleCutArea: vi.fn(), toggleOrtho: vi.fn(), togglePolar: vi.fn(),
      toggleGridSnap: vi.fn(), toggleObjectSnapTracking: vi.fn(),
      toggleProperties: vi.fn(),
      commandActive: vi.fn(() => false), commandInputChanged: vi.fn(),
    };
    const controller = new InputController(input, form, callbacks, target);

    target.dispatchEvent(keyboard('F3'));
    target.dispatchEvent(keyboard('F6'));
    target.dispatchEvent(keyboard('F7'));
    target.dispatchEvent(keyboard('F8'));
    target.dispatchEvent(keyboard('F10'));

    expect(callbacks.toggleObjectSnap).toHaveBeenCalledOnce();
    expect(callbacks.toggleDynamicUcs).toHaveBeenCalledOnce();
    expect(callbacks.toggleGridDisplay).toHaveBeenCalledOnce();
    expect(callbacks.toggleOrtho).toHaveBeenCalledOnce();
    expect(callbacks.togglePolar).toHaveBeenCalledOnce();
    controller.dispose();
  });
});

describe('drafting toggles sit on the keys AutoCAD uses', () => {
  const setup = () => {
    const target = new EventTarget();
    const input = { value: '', focus: vi.fn(), setSelectionRange: vi.fn() } as unknown as HTMLInputElement;
    const form = { requestSubmit: vi.fn() } as unknown as HTMLFormElement;
    const callbacks = {
      escape: vi.fn(), undo: vi.fn(), redo: vi.fn(), save: vi.fn(), saveAs: vi.fn(), newProject: vi.fn(),
      open: vi.fn(), export: vi.fn(), deleteSelection: vi.fn(() => false), show2d: vi.fn(),
      toggleObjectSnap: vi.fn(), toggleDynamicUcs: vi.fn(), toggleGridDisplay: vi.fn(), toggleCutArea: vi.fn(), toggleOrtho: vi.fn(), togglePolar: vi.fn(),
      toggleGridSnap: vi.fn(), toggleObjectSnapTracking: vi.fn(),
      toggleProperties: vi.fn(),
      commandActive: vi.fn(() => false), commandInputChanged: vi.fn(),
    };
    // The controller listens from construction; there is nothing to attach.
    new InputController(input, form, callbacks, target);
    return { target, callbacks };
  };

  it.each([
    ['F3', 'toggleObjectSnap'],
    ['F6', 'toggleDynamicUcs'],
    ['F7', 'toggleGridDisplay'],
    ['F8', 'toggleOrtho'],
    ['F9', 'toggleGridSnap'],
    ['F10', 'togglePolar'],
    ['F11', 'toggleObjectSnapTracking'],
  ] as const)('%s toggles %s', (key, callback) => {
    const { target, callbacks } = setup();
    target.dispatchEvent(keyboard(key));
    expect(callbacks[callback]).toHaveBeenCalledTimes(1);
  });

  it('fires each key only once, and only its own toggle', () => {
    const { target, callbacks } = setup();
    target.dispatchEvent(keyboard('F9'));
    expect(callbacks.toggleGridSnap).toHaveBeenCalledTimes(1);
    expect(callbacks.toggleObjectSnap).not.toHaveBeenCalled();
    expect(callbacks.toggleDynamicUcs).not.toHaveBeenCalled();
    expect(callbacks.toggleGridDisplay).not.toHaveBeenCalled();
    expect(callbacks.toggleOrtho).not.toHaveBeenCalled();
    expect(callbacks.togglePolar).not.toHaveBeenCalled();
    expect(callbacks.toggleObjectSnapTracking).not.toHaveBeenCalled();
  });

  it('uses Shift+F7 for the print area without toggling the grid', () => {
    const { target, callbacks } = setup();
    target.dispatchEvent(keyboard('F7', { shiftKey: true }));
    expect(callbacks.toggleCutArea).toHaveBeenCalledOnce();
    expect(callbacks.toggleGridDisplay).not.toHaveBeenCalled();
  });
});
