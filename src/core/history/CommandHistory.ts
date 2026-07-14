import type { Document } from '../Document';

export interface DocumentEdit {
  readonly label: string;
  apply(doc: Document): void;
  revert(doc: Document): void;
}

export class CommandHistory {
  private undoStack: DocumentEdit[] = [];
  private redoStack: DocumentEdit[] = [];

  constructor(private readonly doc: Document, private readonly limit = 100) {}

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  execute(edit: DocumentEdit): void {
    this.doc.transaction(() => edit.apply(this.doc));
    this.pushApplied(edit);
  }

  recordApplied(edit: DocumentEdit): void {
    this.pushApplied(edit);
  }

  undo(): boolean {
    const edit = this.undoStack.pop();
    if (!edit) return false;
    this.doc.transaction(() => {
      edit.revert(this.doc);
      this.doc.pruneSelection();
    });
    this.redoStack.push(edit);
    return true;
  }

  redo(): boolean {
    const edit = this.redoStack.pop();
    if (!edit) return false;
    this.doc.transaction(() => {
      edit.apply(this.doc);
      this.doc.pruneSelection();
    });
    this.undoStack.push(edit);
    return true;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  private pushApplied(edit: DocumentEdit): void {
    this.undoStack.push(edit);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
}
