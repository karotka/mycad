import { cloneEntity, type DimensionEntity, type Entity, type TextEntity } from '../../entities/types';
import { ReplaceObjectsEdit } from '../../history/edits';
import { textStepValue, type CommandRun, type StepOutcome } from '../types';

export function editText(run: CommandRun): StepOutcome {
  if (run.active.stepIndex === 0) {
    const entity = run.value as Entity | undefined;
    if (!entity || (entity.type !== 'text' && entity.type !== 'dimension')) {
      run.ctx.log('TEXTEDIT: select a text or dimension object.');
      return 'stay';
    }
    run.data.textEntity = cloneEntity(entity);
    run.ctx.prefillCommandInput?.(entity.type === 'text' ? entity.text : entity.textOverride ?? '');
    return 'advance';
  }

  const before = run.data.textEntity as TextEntity | DimensionEntity;

  if (before.type === 'dimension') {
    const after = cloneEntity(before);
    const { text } = textStepValue(run.value ?? '');
    // Unlike TEXT, an empty answer is valid here — it clears the override
    // back to the measured value, rather than being rejected as empty text.
    after.textOverride = text || undefined;
    run.ctx.history.execute(new ReplaceObjectsEdit('Edit dimension text', [before], [], [after], []));
    run.ctx.doc.clearSelection();
    run.ctx.doc.selectEntity(after.id);
    run.ctx.log(after.textOverride ? 'Dimension text override set.' : 'Dimension text override cleared.');
    return 'advance';
  }

  const after = cloneEntity(before);
  const { text, height, font } = textStepValue(run.value ?? '');
  after.text = text;
  if (height !== undefined) after.height = height;
  if (font !== undefined) after.font = font;
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
