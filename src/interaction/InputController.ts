export interface InputControllerCallbacks {
  escape(): void;
  undo(): void;
  redo(): void;
}

export class InputController {
  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.callbacks.escape();
      return;
    }
    if (event.metaKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.callbacks.redo();
      else this.callbacks.undo();
    }
  };

  constructor(private readonly callbacks: InputControllerCallbacks) {
    window.addEventListener('keydown', this.keydown);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.keydown);
  }
}
