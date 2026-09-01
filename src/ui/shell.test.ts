// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { shellHtml } from './shell';

describe('visual style controls', () => {
  it('starts in X-Ray and orders Wireframe, X-Ray, Shaded', () => {
    document.body.innerHTML = shellHtml({
      primitive: 'BOX',
      circle: 'CIRCLE',
      curve: 'BEZIER',
      dimension: 'MEASURE',
      zoom: 'ZOOM_ALL',
    });
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-visual-style]')];

    expect(buttons.map((button) => button.dataset.visualStyle)).toEqual(['wireframe', 'xray', 'shaded']);
    expect(buttons.find((button) => button.classList.contains('active'))?.dataset.visualStyle).toBe('xray');
  });
});

describe('drafting controls', () => {
  it('offers Dynamic UCS on F6', () => {
    document.body.innerHTML = shellHtml({
      primitive: 'BOX',
      circle: 'CIRCLE',
      curve: 'BEZIER',
      dimension: 'MEASURE',
      zoom: 'ZOOM_ALL',
    });

    expect(document.querySelector<HTMLButtonElement>('#ducs-toggle')?.textContent).toContain('F6');
    expect(document.querySelector<HTMLButtonElement>('#ducs-save')?.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('#area-toggle')?.textContent).toContain('⇧F7');
  });

  it('orders one-shot OSNAP modes and includes Midpoint', () => {
    document.body.innerHTML = shellHtml({ primitive: 'BOX', circle: 'CIRCLE', curve: 'BEZIER', dimension: 'MEASURE', zoom: 'ZOOM_ALL' });
    const modes = [...document.querySelectorAll<HTMLButtonElement>('.one-shot-snaps [data-grip-mode]')]
      .map((button) => button.dataset.gripMode);
    expect(modes.slice(0, 8)).toEqual([
      'end', 'middle', 'perpendicular', 'tangent', 'intersection', 'center', 'apparent-intersection', 'mid2p',
    ]);
  });
});
