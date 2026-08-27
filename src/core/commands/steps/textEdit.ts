import { cloneEntity, type TextEntity } from '../../entities/types';
import { ReplaceObjectsEdit } from '../../history/edits';
import type { CommandRun, StepOutcome } from '../types';

export function editText(run: CommandRun): StepOutcome {
  if (run.active.stepIndex === 0) {
    const entity = run.value as TextEntity | undefined;
    if (!entity || entity.type !== 'text') {
      run.ctx.log('TEXTEDIT: select a text object.');
      return 'stay';
    }
    run.data.textEntity = cloneEntity(entity);
    run.ctx.prefillCommandInput?.(entity.text);
    return 'advance';
  }

  const before = run.data.textEntity as TextEntity;
  const after = cloneEntity(before);
  after.text = String(run.value ?? '');
  if (!after.text) {
    run.ctx.log('TEXTEDIT: text cannot be empty; use ERASE to remove it.');
    run.ctx.prefillCommandInput?.(before.text);
    return 'stay';
  }
  run.ctx.history.execute(new ReplaceObjectsEdit('Edit text', [before], [], [after], []));
  run.ctx.doc.clearSelection();
  run.ctx.doc.selectEntity(after.id);
  run.ctx.log('Text updated.');
  return 'advance';
}
