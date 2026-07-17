/**
 * One Settings window with a tab per group of document settings — drafting,
 * dimension style, G-code. They were three separate panels, each with its own
 * toggle cluttering the status bar; this is the container that gathers them.
 *
 * Each tab's form has its own controller, which owns reading and writing its
 * values. This owns only which tab is showing and whether the window is open,
 * and asks the visible tab to refresh itself when it is shown.
 */
export interface SettingsTab {
  /** The tab button in the window's header. */
  button: HTMLElement;
  /** The panel the button reveals. */
  panel: HTMLElement;
  /** Refreshes the fields from the document — called each time the tab is shown. */
  render(): void;
}

export class SettingsController {
  private active: SettingsTab | undefined;

  constructor(
    private readonly window: HTMLElement,
    close: HTMLElement,
    private readonly tabs: SettingsTab[],
  ) {
    close.addEventListener('click', () => this.hide());
    for (const tab of tabs) tab.button.addEventListener('click', () => this.show(tab));
  }

  get isOpen(): boolean { return !this.window.hidden; }

  /** Opens the window on the tab that was last shown, or the first. */
  open(): void {
    this.window.hidden = false;
    this.show(this.active ?? this.tabs[0]);
  }

  hide(): void { this.window.hidden = true; }

  toggle(): void { this.isOpen ? this.hide() : this.open(); }

  /** The open window's fields, kept in step while it is open — see main.ts. */
  renderActive(): void {
    if (this.isOpen) this.active?.render();
  }

  private show(tab: SettingsTab): void {
    this.active = tab;
    for (const other of this.tabs) {
      const on = other === tab;
      other.panel.hidden = !on;
      other.button.classList.toggle('active', on);
    }
    tab.render();
  }
}
