/**
 * Panels you can move, that stay where you put them.
 *
 * Properties, Layers, Blocks, Multiline Styles, the Model Tree and Settings are
 * all anchored to a corner of the viewport by CSS, which is a fine default and
 * a poor answer when one of them covers exactly the part of the drawing being
 * worked on. Dragging a panel's own header moves it; where it was put is
 * remembered per panel, across restarts, like the rest of the UI state.
 *
 * The geometry lives in `clampPanelPosition` so the part that can be wrong —
 * a panel restored off the edge of a window that has since been made smaller,
 * and so unreachable — is testable without a DOM.
 */

export interface PanelPosition { x: number; y: number }

interface Size { width: number; height: number }

/** How much of a panel must stay on screen. Enough of the header to grab. */
const MIN_VISIBLE = 48;

/**
 * `position` brought back within `viewport`.
 *
 * A panel may hang off the right or bottom edge, but never so far that there
 * is nothing left to take hold of, and never off the top or left at all —
 * those are the edges whose header would go out of reach first.
 */
export function clampPanelPosition(position: PanelPosition, size: Size, viewport: Size, margin = 4): PanelPosition {
  const maxX = Math.max(margin, viewport.width - Math.min(size.width, MIN_VISIBLE) - margin);
  const maxY = Math.max(margin, viewport.height - Math.min(size.height, MIN_VISIBLE) - margin);
  return {
    x: Math.min(Math.max(position.x, margin), maxX),
    y: Math.min(Math.max(position.y, margin), maxY),
  };
}

const storageKey = (name: string): string => `mycad.panel.${name}`;

export function readPanelPosition(name: string): PanelPosition | null {
  try {
    const saved = localStorage.getItem(storageKey(name));
    if (!saved) return null;
    const parsed = JSON.parse(saved) as Partial<PanelPosition>;
    return typeof parsed?.x === 'number' && typeof parsed?.y === 'number' ? { x: parsed.x, y: parsed.y } : null;
  } catch {
    // A corrupt or unreadable entry is not worth a broken panel: it opens
    // where its CSS puts it, as it always did.
    return null;
  }
}

export function writePanelPosition(name: string, position: PanelPosition): void {
  try {
    localStorage.setItem(storageKey(name), JSON.stringify(position));
  } catch {
    // Out of quota or blocked: the panel still moves, it just will not
    // remember. Not worth interrupting anyone over.
  }
}

/** A panel's state as a drawing remembers it: whether it was open, and where
 *  it had been put. */
export interface PanelState {
  name: string;
  open: boolean;
  x?: number;
  y?: number;
}

/** What a panel can be asked about and told, once it floats. */
export interface FloatingPanelHandle {
  readonly name: string;
  /** Open or not, and where it sits if it has been moved. */
  state(): PanelState;
  /** Puts it back the way a drawing remembers it. */
  restore(state: PanelState): void;
}

/**
 * Makes one panel draggable by its header and gives it back its saved place.
 *
 * `name` is what the position is stored under, so it has to stay stable.
 */
export function makePanelFloating(panel: HTMLElement, name: string): FloatingPanelHandle | null {
  const header = panel.querySelector('header');
  if (!header) return null;
  header.classList.add('panel-drag-handle');

  /**
   * Positions are kept in window coordinates — the same ones the pointer
   * reports — but `left`/`top` are measured from whatever the panel is
   * positioned inside, which is not the window. Getting this wrong puts a
   * panel a toolbar's width and a viewport's height from where it was
   * dropped, which is exactly what it did the first time.
   */
  const place = (position: PanelPosition): void => {
    const parent = panel.offsetParent?.getBoundingClientRect();
    // The CSS anchors these to a corner; a moved panel is positioned from the
    // top left instead, so those anchors have to let go. Settings is centred
    // with a transform, which would shift it away from where it was dropped.
    panel.style.left = `${position.x - (parent?.left ?? 0)}px`;
    panel.style.top = `${position.y - (parent?.top ?? 0)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.transform = 'none';
  };

  const panelSize = (): Size => ({ width: panel.offsetWidth, height: panel.offsetHeight });
  const viewportSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight });

  let moved = readPanelPosition(name);

  // A hidden panel has no size and no offset parent to measure against, so its
  // saved place is applied when it opens — and checked again whenever the
  // window changes size under it, so one saved in a larger window is never
  // left somewhere unreachable.
  const restoreIntoView = (): void => {
    if (!moved || panel.hidden) return;
    moved = clampPanelPosition(moved, panelSize(), viewportSize());
    place(moved);
  };

  new MutationObserver(restoreIntoView).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('resize', restoreIntoView);
  if (!panel.hidden) restoreIntoView();

  header.addEventListener('pointerdown', (event) => {
    // The header carries close/add/purge buttons; pressing one is not a drag.
    if ((event.target as HTMLElement).closest('button')) return;
    if (event.button !== 0) return;
    const rect = panel.getBoundingClientRect();
    const grabX = event.clientX - rect.left;
    const grabY = event.clientY - rect.top;
    header.setPointerCapture(event.pointerId);
    panel.classList.add('panel-dragging');
    event.preventDefault();

    const onMove = (move: PointerEvent): void => {
      moved = clampPanelPosition(
        { x: move.clientX - grabX, y: move.clientY - grabY },
        panelSize(),
        viewportSize(),
      );
      place(moved);
    };
    const onUp = (up: PointerEvent): void => {
      header.removeEventListener('pointermove', onMove);
      header.removeEventListener('pointerup', onUp);
      header.removeEventListener('pointercancel', onUp);
      panel.classList.remove('panel-dragging');
      if (header.hasPointerCapture(up.pointerId)) header.releasePointerCapture(up.pointerId);
      if (moved) writePanelPosition(name, moved);
    };
    header.addEventListener('pointermove', onMove);
    header.addEventListener('pointerup', onUp);
    header.addEventListener('pointercancel', onUp);
  });

  return {
    name,
    state: () => ({ name, open: !panel.hidden, ...(moved ? { x: moved.x, y: moved.y } : {}) }),
    restore: (state) => {
      // A drawing that says where a panel was beats whatever this machine had
      // remembered for it — the drawing travels, the machine does not. One
      // that says nothing about the position leaves it where it was.
      if (typeof state.x === 'number' && typeof state.y === 'number') {
        moved = { x: state.x, y: state.y };
        writePanelPosition(name, moved);
      }
      panel.hidden = !state.open;
      restoreIntoView();
    },
  };
}
