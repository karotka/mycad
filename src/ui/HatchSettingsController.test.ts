// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Document } from '../core/Document';
import { HatchSettingsController } from './HatchSettingsController';

describe('HatchSettingsController', () => {
  it('renders and applies pattern, angle and spacing defaults', () => {
    const doc = new Document();
    const form = document.createElement('form');
    form.innerHTML = '<select id="hatch-pattern"><option value="lines">Lines</option><option value="cross">Cross</option><option value="solid">Solid</option></select><input id="hatch-angle" type="number"><input id="hatch-spacing" type="number">';
    const changed = vi.fn();
    const controller = new HatchSettingsController(doc, form, changed);
    controller.render();
    expect((form.querySelector('#hatch-angle') as HTMLInputElement).value).toBe('45');
    (form.querySelector('#hatch-pattern') as HTMLSelectElement).value = 'cross';
    (form.querySelector('#hatch-angle') as HTMLInputElement).value = '30';
    (form.querySelector('#hatch-spacing') as HTMLInputElement).value = '4';
    form.querySelector('#hatch-spacing')!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(doc.hatch).toEqual({ pattern: 'cross', angle: 30, spacing: 4 });
    expect(changed).toHaveBeenCalled();
  });
});
