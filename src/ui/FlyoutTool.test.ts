import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlyoutTool } from './FlyoutTool';

type Tool = 'BOX' | 'SPHERE';

function fakeButton(attributes: Record<string, string> = {}) {
  const listeners = new Map<string, (event: Event) => void>();
  return {
    dataset: {} as Record<string, string>,
    title: '',
    innerHTML: '',
    setAttribute: vi.fn(),
    getAttribute: (name: string) => attributes[name] ?? null,
    addEventListener: (type: string, listener: (event: Event) => void) => listeners.set(type, listener),
    contains: () => false,
    fire: (type: string, event: Partial<PointerEvent> = {}) =>
      listeners.get(type)?.({ button: 0, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...event } as unknown as Event),
    has: (type: string) => listeners.has(type),
  };
}

function setup(options: { withMemory?: boolean } = {}) {
  vi.useFakeTimers();
  const items = [fakeButton({ 'data-tool': 'SPHERE' })];
  const main = fakeButton();
  const flyout = { hidden: true, querySelectorAll: () => items, contains: () => false } as unknown as HTMLElement;
  const run = vi.fn();
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { setItem: (k: string, v: string) => store.set(k, v), getItem: (k: string) => store.get(k) ?? null });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  const tool = new FlyoutTool<Tool>({
    main: main as unknown as HTMLButtonElement,
    flyout,
    initial: 'BOX',
    run,
    memory: options.withMemory === false ? undefined : {
      attribute: 'data-tool',
      storageKey: 'mycad.lastTool',
      labelOf: (value) => (value === 'BOX' ? 'Box' : 'Sphere'),
      iconOf: (value) => `<svg data-icon="${value}"></svg>`,
    },
  });
  return { tool, main, flyout, items, run, store };
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('FlyoutTool', () => {
  it('runs the current tool on a click, and does not open the list', () => {
    const { main, flyout, run } = setup();
    main.fire('pointerdown');
    main.fire('pointerup');
    expect(run).toHaveBeenCalledWith('BOX');
    expect(flyout.hidden).toBe(true);
  });

  it('opens the list when the button is held', () => {
    const { main, flyout, run } = setup();
    main.fire('pointerdown');
    vi.advanceTimersByTime(500);
    expect(flyout.hidden).toBe(false);
    // The hold already did its job, so releasing must not also run the tool.
    main.fire('pointerup');
    expect(run).not.toHaveBeenCalled();
  });

  it('leaves the list shut if the button is released before the hold', () => {
    const { main, flyout, run } = setup();
    main.fire('pointerdown');
    vi.advanceTimersByTime(300);
    main.fire('pointerup');
    expect(flyout.hidden).toBe(true);
    expect(run).toHaveBeenCalledWith('BOX');
  });

  it('drops the hold when the pointer leaves the button', () => {
    const { main, flyout } = setup();
    main.fire('pointerdown');
    main.fire('pointerleave');
    vi.advanceTimersByTime(1000);
    expect(flyout.hidden).toBe(true);
  });

  it('ignores buttons other than the left', () => {
    const { main, run } = setup();
    main.fire('pointerdown', { button: 2 });
    vi.advanceTimersByTime(1000);
    main.fire('pointerup', { button: 2 });
    expect(run).not.toHaveBeenCalled();
  });

  describe('picking from the list', () => {
    it('runs what was picked and remembers it', () => {
      const { tool, items, run, store, flyout } = setup();
      items[0].fire('pointerdown');
      expect(run).toHaveBeenCalledWith('SPHERE');
      expect(tool.current).toBe('SPHERE');
      expect(store.get('mycad.lastTool')).toBe('SPHERE');
      expect(flyout.hidden).toBe(true);
    });

    it('makes the main button show what it will now run', () => {
      const { main, items } = setup();
      items[0].fire('pointerdown');
      expect(main.dataset.label).toBe('Sphere');
      expect(main.title).toBe('Sphere · hold for more');
      expect(main.innerHTML).toContain('data-icon="SPHERE"');
    });

    it('runs the picked tool on the next plain click', () => {
      const { main, items, run } = setup();
      items[0].fire('pointerdown');
      run.mockClear();
      main.fire('pointerdown');
      main.fire('pointerup');
      expect(run).toHaveBeenCalledWith('SPHERE');
    });
  });

  // Some lists always run the same tool and their items are ordinary toolbar
  // buttons, which run themselves — picking one only closes the list.
  describe('without a memory', () => {
    it('closes the list but neither remembers nor runs', () => {
      const { tool, items, run, flyout, store } = setup({ withMemory: false });
      items[0].fire('pointerdown');
      expect(flyout.hidden).toBe(true);
      expect(run).not.toHaveBeenCalled();
      expect(tool.current).toBe('BOX');
      expect(store.size).toBe(0);
    });

    it('still runs its fixed tool on a click', () => {
      const { main, run } = setup({ withMemory: false });
      main.fire('pointerdown');
      main.fire('pointerup');
      expect(run).toHaveBeenCalledWith('BOX');
    });
  });
});
