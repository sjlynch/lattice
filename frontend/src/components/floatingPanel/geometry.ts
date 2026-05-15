export type Size = { width: number; height: number };
export type Pos = { x: number; y: number };

export type PersistedFloatingPanelGeometry = {
  pos?: Pos;
  size?: Size;
};

export const VIEWPORT_PAD = 12;

export function clampPos(pos: Pos, size: Size): Pos {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  return {
    x: Math.min(Math.max(VIEWPORT_PAD, pos.x), viewportWidth - size.width - VIEWPORT_PAD),
    y: Math.min(Math.max(VIEWPORT_PAD, pos.y), viewportHeight - size.height - VIEWPORT_PAD),
  };
}

export function getInitialFloatingPanelPos(size: Size): Pos {
  return {
    x: Math.max(VIEWPORT_PAD, (window.innerWidth - size.width) / 2),
    y: Math.max(VIEWPORT_PAD, (window.innerHeight - size.height) / 3),
  };
}

export function loadPersistedFloatingPanelGeometry(
  storageKey?: string,
): PersistedFloatingPanelGeometry | null {
  if (!storageKey) return null;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function persistFloatingPanelGeometry(storageKey: string | undefined, pos: Pos, size: Size) {
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify({ pos, size }));
  } catch {
    // ignore quota
  }
}
