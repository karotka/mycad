// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { clampPanelPosition, makePanelFloating } from './FloatingPanel';

describe('clampPanelPosition', () => {
  const panel = { width: 340, height: 400 };
  const viewport = { width: 1200, height: 800 };

  it('leaves a panel dropped well inside the window exactly where it was put', () => {
    expect(clampPanelPosition({ x: 300, y: 200 }, panel, viewport)).toEqual({ x: 300, y: 200 });
  });

  it('never lets a panel past the top or left edge, where its header would go out of reach', () => {
    expect(clampPanelPosition({ x: -500, y: -80 }, panel, viewport)).toEqual({ x: 4, y: 4 });
  });

  it('lets a panel hang off the right and bottom, but keeps enough of it to grab', () => {
    const far = clampPanelPosition({ x: 5000, y: 5000 }, panel, viewport);
    // Still on screen by more than nothing, and by less than its whole width:
    // hanging off the edge is allowed, disappearing is not.
    expect(far.x).toBeLessThan(viewport.width);
    expect(viewport.width - far.x).toBeGreaterThanOrEqual(48);
    expect(viewport.height - far.y).toBeGreaterThanOrEqual(48);
  });

  it('brings a panel back when the window it was saved in is now smaller — the case that would otherwise lose it', () => {
    const saved = { x: 1100, y: 700 };
    const smaller = { width: 640, height: 480 };
    const rescued = clampPanelPosition(saved, panel, smaller);
    expect(rescued.x).toBeLessThanOrEqual(smaller.width - 48);
    expect(rescued.y).toBeLessThanOrEqual(smaller.height - 48);
  });

  it('still yields a usable position in a window smaller than the panel itself', () => {
    const tiny = { width: 200, height: 120 };
    const position = clampPanelPosition({ x: 900, y: 900 }, panel, tiny);
    expect(position.x).toBeGreaterThanOrEqual(4);
    expect(position.y).toBeGreaterThanOrEqual(4);
    expect(position.x).toBeLessThan(tiny.width);
    expect(position.y).toBeLessThan(tiny.height);
  });
});

/**
 * A drawing remembers which panels were open and where they were put, so a
 * layout made to keep them clear of the work travels with the file. Asked for
 * directly; the browser storage the panels otherwise use only ever knew about
 * one machine.
 */
describe('a panel as a drawing remembers it', () => {
  function panelWithHeader(): HTMLElement {
    const panel = document.createElement('section');
    panel.hidden = true;
    panel.appendChild(document.createElement('header'));
    document.body.appendChild(panel);
    return panel;
  }

  it('reports whether it is open, under the name it is stored by', () => {
    const panel = panelWithHeader();
    const handle = makePanelFloating(panel, 'layers')!;
    expect(handle.state()).toMatchObject({ name: 'layers', open: false });
    panel.hidden = false;
    expect(handle.state().open).toBe(true);
  });

  it('says nothing about a position it has never been given', () => {
    const handle = makePanelFloating(panelWithHeader(), 'never-moved')!;
    expect(handle.state().x).toBeUndefined();
    expect(handle.state().y).toBeUndefined();
  });

  it('opens and places itself the way a drawing remembers', () => {
    const panel = panelWithHeader();
    const handle = makePanelFloating(panel, 'properties')!;
    handle.restore({ name: 'properties', open: true, x: 120, y: 80 });

    expect(panel.hidden).toBe(false);
    expect(handle.state()).toMatchObject({ open: true, x: 120, y: 80 });
  });

  it('shuts again for a drawing that had it shut', () => {
    const panel = panelWithHeader();
    panel.hidden = false;
    const handle = makePanelFloating(panel, 'blocks')!;
    handle.restore({ name: 'blocks', open: false });
    expect(panel.hidden).toBe(true);
  });

  it('has no handle to offer a panel with no header to drag it by', () => {
    const bare = document.createElement('section');
    document.body.appendChild(bare);
    expect(makePanelFloating(bare, 'headerless')).toBeNull();
  });
});
