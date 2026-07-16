/** How long the button is held before the list opens. */
const HOLD_MS = 450;

/** How far a press may drift and still count as a click rather than a hold. */
export interface FlyoutMemory<T extends string> {
  /** The attribute the list's buttons carry their value in, e.g. `data-primitive-command`. */
  attribute: string;
  storageKey: string;
  labelOf(value: T): string;
  iconOf(value: T): string;
}

export interface FlyoutToolOptions<T extends string> {
  main: HTMLButtonElement;
  flyout: HTMLElement;
  /** The tool to run on a plain click. Already resolved: the caller validates what was stored. */
  initial: T;
  /** Runs the tool — on a plain click, and again once one is picked from the list. */
  run(value: T): void;
  /**
   * Left out by a list whose buttons are ordinary toolbar buttons and whose main
   * button always runs the same tool: picking one then only closes the list, and
   * the button that was picked runs itself.
   */
  memory?: FlyoutMemory<T>;
}

/**
 * A toolbar button that runs its tool when clicked and opens a list of siblings
 * when held — remembering which one was last used, if it has a memory.
 *
 * There were six copies of this, each with its own hold timer and its own 450,
 * and they had already drifted apart.
 */
export class FlyoutTool<T extends string> {
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private openedByHold = false;
  private value: T;

  constructor(private readonly options: FlyoutToolOptions<T>) {
    this.value = options.initial;
    const { main, flyout } = options;

    main.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.openedByHold = false;
      this.holdTimer = setTimeout(() => {
        this.openedByHold = true;
        flyout.hidden = false;
      }, HOLD_MS);
    });
    main.addEventListener('pointerup', (event) => {
      if (event.button !== 0) return;
      this.cancelHold();
      // The hold already did its job by opening the list.
      if (!this.openedByHold) options.run(this.value);
    });
    main.addEventListener('pointerleave', () => this.cancelHold());

    for (const button of flyout.querySelectorAll<HTMLButtonElement>('button')) {
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        flyout.hidden = true;
        const memory = options.memory;
        if (!memory) return; // an ordinary toolbar button; it runs itself
        const picked = button.getAttribute(memory.attribute) as T | null;
        if (!picked) return;
        this.choose(picked);
        options.run(picked);
      });
    }

    window.addEventListener('pointerdown', (event) => {
      if (!flyout.contains(event.target as Node) && event.target !== main) flyout.hidden = true;
    });
  }

  /** The tool a plain click runs. */
  get current(): T { return this.value; }

  /** Picks a tool without running it — for a command started from elsewhere. */
  choose(value: T): void {
    this.value = value;
    const memory = this.options.memory;
    if (!memory) return;
    localStorage.setItem(memory.storageKey, value);
    const label = memory.labelOf(value);
    const { main } = this.options;
    main.dataset.label = label;
    main.title = `${label} · hold for more`;
    main.setAttribute('aria-label', `${label} · hold for more`);
    main.innerHTML = `${memory.iconOf(value)}<span class="flyout-caret">▾</span>`;
  }

  private cancelHold(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }
}
