import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import { CommandHistory } from '../core/history/CommandHistory';
import { PropertiesController } from './PropertiesController';

const element = (hidden = true) => ({ hidden, addEventListener: vi.fn() }) as unknown as HTMLElement;

describe('PropertiesController', () => {
  it('updates entity geometry through undoable history', () => {
    const doc = new Document();
    const history = new CommandHistory(doc);
    const circle = doc.createCircle({ x: 2, y: 3 }, 4);
    doc.addEntity(circle);
    doc.selectEntity(circle.id);
    const controller = new PropertiesController(doc, history, element(), element(), element(), element(), vi.fn());

    (controller as unknown as { updateOne(object: typeof circle, key: string, value: number): void })
      .updateOne(circle, 'radius', 8);

    expect(doc.getEntity(circle.id)).toMatchObject({ type: 'circle', radius: 8 });
    history.undo();
    expect(doc.getEntity(circle.id)).toMatchObject({ type: 'circle', radius: 4 });
  });
});
