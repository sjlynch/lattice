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
  // Floor the upper bound at VIEWPORT_PAD: when the panel is larger than the
  // viewport (small window, or a large persisted size restored on a smaller
  // monitor) the raw `viewport - size - PAD` max goes negative, which would
  // otherwise pin the panel off the top-left with its header unreachable.
  return {
    x: Math.min(
      Math.max(VIEWPORT_PAD, pos.x),
      Math.max(VIEWPORT_PAD, viewportWidth - size.width - VIEWPORT_PAD),
    ),
    y: Math.min(
      Math.max(VIEWPORT_PAD, pos.y),
      Math.max(VIEWPORT_PAD, viewportHeight - size.height - VIEWPORT_PAD),
    ),
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
    return sanitizePersistedGeometry(JSON.parse(raw));
  } catch {
    return null;
  }
}

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

// Keep only a well-formed `pos` / positive `size` from a stored entry. The raw
// JSON is whatever the key holds — a hand-edit, an older shape, or a NaN that
// JSON.stringify wrote as `null` — and a non-numeric coordinate survives
// clampPos as NaN, rendering the panel somewhere unreachable with no way back
// short of clearing site data.
export function sanitizePersistedGeometry(
  value: unknown,
): PersistedFloatingPanelGeometry | null {
  if (!value || typeof value !== 'object') return null;
  const { pos, size } = value as { pos?: Partial<Pos>; size?: Partial<Size> };
  const out: PersistedFloatingPanelGeometry = {};
  if (pos && isFiniteNumber(pos.x) && isFiniteNumber(pos.y)) {
    out.pos = { x: pos.x, y: pos.y };
  }
  if (
    size &&
    isFiniteNumber(size.width) &&
    isFiniteNumber(size.height) &&
    size.width > 0 &&
    size.height > 0
  ) {
    out.size = { width: size.width, height: size.height };
  }
  return out.pos || out.size ? out : null;
}

export function persistFloatingPanelGeometry(storageKey: string | undefined, pos: Pos, size: Size) {
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify({ pos, size }));
  } catch {
    // ignore quota
  }
}
