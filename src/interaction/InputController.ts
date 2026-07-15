export interface InputControllerCallbacks {
  escape(): void;
  undo(): void;
  redo(): void;
  save(): void;
  newProject(): void;
  open(): void;
  export(): void;
  deleteSelection(): boolean;
  show2d(): void;
  commandActive(): boolean;
  commandInputChanged(): void;
}

export class InputController {
  private readonly keydown = (rawEvent: Event): void => {
    const event = rawEvent as KeyboardEvent;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.callbacks.escape();
      return;
    }

    const key = event.key.toLowerCase();
    const primaryModifier = event.metaKey || event.ctrlKey;
    if (primaryModifier && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.callbacks.redo(); else this.callbacks.undo();
      return;
    }
    if (primaryModifier && key === 's') { event.preventDefault(); this.callbacks.save(); return; }
    if (primaryModifier && key === 'n') { event.preventDefault(); this.callbacks.newProject(); return; }
    if (event.metaKey && key === 'o') { event.preventDefault(); this.callbacks.open(); return; }
    if (event.metaKey && key === 'e') { event.preventDefault(); this.callbacks.export(); return; }

    const isTextEntry = this.isTextEntry(event.target);
    if (!isTextEntry && (event.key === 'Delete' || event.key === 'Backspace') && this.callbacks.deleteSelection()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if ((event.key === ' ' || event.code === 'Space') && !isTextEntry && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) this.callbacks.show2d();
      return;
    }
    if (isTextEntry || event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      this.commandInput.focus({ preventScroll: true });
      this.commandForm.requestSubmit();
    } else if (event.key === 'Backspace') {
      if (!this.callbacks.commandActive() && this.commandInput.value.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      this.commandInput.value = this.commandInput.value.slice(0, -1);
      this.commandInput.focus({ preventScroll: true });
      this.callbacks.commandInputChanged();
    } else if (event.key.length === 1) {
      event.preventDefault();
      event.stopPropagation();
      this.commandInput.value += event.key;
      this.commandInput.focus({ preventScroll: true });
      this.commandInput.setSelectionRange(this.commandInput.value.length, this.commandInput.value.length);
      this.callbacks.commandInputChanged();
    }
  };

  constructor(
    private readonly commandInput: HTMLInputElement,
    private readonly commandForm: HTMLFormElement,
    private readonly callbacks: InputControllerCallbacks,
    private readonly eventTarget: EventTarget = window,
  ) {
    this.eventTarget.addEventListener('keydown', this.keydown, { capture: true });
  }

  dispose(): void {
    this.eventTarget.removeEventListener('keydown', this.keydown, { capture: true });
  }

  private isTextEntry(target: EventTarget | null): boolean {
    const element = target as { tagName?: string; isContentEditable?: boolean } | null;
    const tag = element?.tagName?.toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(element?.isContentEditable);
  }
}
