import { safeLocalStorageGetItem, safeLocalStorageSetItem } from '../../storage/latticeLocalStorage';
import type { Pos, Size } from './geometry';

// Pop-out window placement, in SCREEN coordinates (`left`/`top` = the OS
// window's outer top-left, `width`/`height` = its content size — what
// `window.open` features take). Persisted per panel under
// `lattice.<thing>.popout`, beside the in-window `lattice.<thing>.window`.
export type PopoutGeometry = { left: number; top: number; width: number; height: number };

export const POPOUT_MIN_SIZE: Size = { width: 360, height: 240 };
// Rough height of a popup's own OS title + address bar, so a window dropped
// at the pointer lands with the panel's titlebar under it.
const POPUP_CHROME_ESTIMATE = 40;

/** `lattice.fleet.window` → `lattice.fleet.popout`; no key, no persistence. */
export function popoutStorageKey(windowKey?: string): string | undefined {
  if (!windowKey) return undefined;
  return windowKey.endsWith('.window')
    ? `${windowKey.slice(0, -'.window'.length)}.popout`
    : `${windowKey}.popout`;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Keep only a well-formed stored entry (hand edits, older shapes, NaN → null). */
export function sanitizePopoutGeometry(value: unknown): PopoutGeometry | null {
  if (!value || typeof value !== 'object') return null;
  const { left, top, width, height } = value as Partial<PopoutGeometry>;
  if (!finite(left) || !finite(top) || !finite(width) || !finite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.max(POPOUT_MIN_SIZE.width, Math.round(width)),
    height: Math.max(POPOUT_MIN_SIZE.height, Math.round(height)),
  };
}

export function loadPopoutGeometry(key?: string): PopoutGeometry | null {
  if (!key) return null;
  const raw = safeLocalStorageGetItem(key);
  if (!raw) return null;
  try {
    return sanitizePopoutGeometry(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function savePopoutGeometry(key: string | undefined, geometry: PopoutGeometry): void {
  if (!key) return;
  const clean = sanitizePopoutGeometry(geometry);
  if (clean) safeLocalStorageSetItem(key, JSON.stringify(clean));
}

type ScreenWindow = Pick<Window, 'screenX' | 'screenY' | 'innerWidth' | 'innerHeight'>;
type MainWindow = ScreenWindow & Pick<Window, 'outerWidth' | 'outerHeight'>;

/** Where an open pop-out is now. */
export function readPopoutGeometry(win: ScreenWindow): PopoutGeometry {
  return { left: win.screenX, top: win.screenY, width: win.innerWidth, height: win.innerHeight };
}

/**
 * First pop-out of a panel with nothing saved: a window over the spot the
 * panel occupies in the main window, at the panel's size.
 */
export function initialPopoutGeometry(panel: { pos: Pos; size: Size }, main: MainWindow): PopoutGeometry {
  // The main window's frame: side borders split evenly, the rest is on top
  // (tabs + address bar). Popups have less chrome; this is an estimate.
  const side = Math.max(0, (main.outerWidth - main.innerWidth) / 2);
  const top = Math.max(0, main.outerHeight - main.innerHeight - side);
  return sanitizePopoutGeometry({
    left: main.screenX + side + panel.pos.x,
    top: main.screenY + top + panel.pos.y - POPUP_CHROME_ESTIMATE,
    width: panel.size.width,
    height: panel.size.height,
  })!;
}

/** A pop-out dropped at a screen point, keeping the titlebar grab offset. */
export function popoutAtPointer(
  screen: { x: number; y: number },
  grab: Pos,
  size: Size,
): PopoutGeometry {
  return sanitizePopoutGeometry({
    left: screen.x - grab.x,
    top: screen.y - grab.y - POPUP_CHROME_ESTIMATE,
    width: size.width,
    height: size.height,
  })!;
}

/** `window.open` features for a sized, placed popup window. */
export function popoutFeatures(geometry: PopoutGeometry): string {
  const g = sanitizePopoutGeometry(geometry) ?? { left: 0, top: 0, ...POPOUT_MIN_SIZE };
  return `popup=yes,width=${g.width},height=${g.height},left=${g.left},top=${g.top}`;
}

/**
 * Is a pointer at client (x, y) more than `margin` px outside a viewport of
 * `size`? The margin keeps a drag that merely grazes the edge from arming.
 */
export function isOutsideViewport(x: number, y: number, size: Size, margin = 0): boolean {
  return x < -margin || y < -margin || x >= size.width + margin || y >= size.height + margin;
}
