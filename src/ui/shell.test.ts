// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { shellHtml } from './shell';

describe('visual style controls', () => {
  it('starts in X-Ray and orders Wireframe, X-Ray, Shaded', () => {
    document.body.innerHTML = shellHtml({
      primitive: 'BOX',
      circle: 'CIRCLE',
      dimension: 'MEASURE',
      zoom: 'ZOOM_ALL',
    });
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-visual-style]')];

    expect(buttons.map((button) => button.dataset.visualStyle)).toEqual(['wireframe', 'xray', 'shaded']);
    expect(buttons.find((button) => button.classList.contains('active'))?.dataset.visualStyle).toBe('xray');
  });
});
