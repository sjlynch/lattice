// Shared browser/DOM test doubles for the frontend `node:test` suites.
//
// `node --test` runs without a DOM, WebGL, clipboard, or browser timers, yet a
// handful of modules reach for `document` / `window` / `navigator.clipboard` /
// `WebSocket` (or the timer globals) at call time. Each suite used to hand-roll
// its own stub plus a save/restore dance; these helpers centralise the
// install-and-restore so the suites stay small and don't bleed global state.
//
// Every installer either returns a `restore()` thunk or is wrapped by a `with*`
// scope. Restoration puts the global back exactly as found — present-with-its-
// prior-value, or absent — so co-resident suites stay isolated.

// ---- generic single-global save/restore -----------------------------------

type GlobalBag = Record<string, unknown>;

/** Set `globalThis[name] = value`, returning a thunk that restores the previous
 *  value (or deletes the key if it was absent before). */
export function installGlobal(name: string, value: unknown): () => void {
  const bag = globalThis as unknown as GlobalBag;
  const had = name in bag;
  const prev = bag[name];
  bag[name] = value;
  return () => {
    if (had) bag[name] = prev;
    else delete bag[name];
  };
}

// ---- canvas / document ----------------------------------------------------

export interface TextMetricsLike {
  actualBoundingBoxLeft: number;
  actualBoundingBoxRight: number;
  width: number;
}

export type MeasureText = (text: string) => TextMetricsLike;

const defaultMeasureText: MeasureText = (text) => ({
  actualBoundingBoxLeft: 0,
  actualBoundingBoxRight: text.length * 8,
  width: text.length * 8,
});

/** A 2D-context stand-in covering every method the sprite / label / ring
 *  painters touch (text measure, fills, paths, gradients). Unused extras are
 *  harmless — the modules under test only call a subset. */
export function makeCanvas2DContext(
  measureText: MeasureText = defaultMeasureText,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  return {
    font: '',
    textAlign: '',
    textBaseline: '',
    lineJoin: '',
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    measureText,
    strokeText: () => {},
    fillText: () => {},
    fillRect: () => {},
    shadowBlur: 0,
    shadowColor: '',
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    arcTo: () => {},
    clip: () => {},
    save: () => {},
    restore: () => {},
    fill: () => {},
    stroke: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
  };
}

/** Install a minimal `document` whose `createElement('canvas')` yields a canvas
 *  backed by {@link makeCanvas2DContext}. Any non-canvas tag throws so an
 *  unexpected DOM dependency surfaces loudly. Returns a restore thunk. */
export function installCanvasDocument(
  measureText: MeasureText = defaultMeasureText,
): () => void {
  return installGlobal('document', {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
      const ctx = makeCanvas2DContext(measureText);
      return { width: 0, height: 0, getContext: () => ctx };
    },
  });
}

// ---- window ---------------------------------------------------------------

/** Install `window` set to `props`, returning a restore thunk. */
export function installWindow(props: GlobalBag): () => void {
  return installGlobal('window', props);
}

/** Run `fn` with `window` set to `props`, restoring the prior value afterwards
 *  (even if `fn` throws). */
export function withWindow<T>(props: GlobalBag, fn: () => T): T {
  const restore = installWindow(props);
  try {
    return fn();
  } finally {
    restore();
  }
}

// ---- clipboard ------------------------------------------------------------

/** A minimal stand-in for the slice of `navigator.clipboard` our code uses. */
export function stubClipboard(
  writeText: (text: string) => Promise<void>,
): Pick<Clipboard, 'writeText'> {
  return { writeText } as Pick<Clipboard, 'writeText'>;
}

// ---- manual timers --------------------------------------------------------

export interface ScheduledTimer {
  id: number;
  cb: () => void;
  delay: number;
}

export interface ManualTimers {
  /** Live list of pending timers — read `.length` / `[0]` to inspect, and the
   *  scheduled `delay` to assert backoff curves. */
  readonly scheduled: ScheduledTimer[];
  /** Fire every currently-pending timer once, snapshotting first so callbacks
   *  that schedule new timers don't run within the same drain. */
  fireAll(): void;
  /** Restore the real `setTimeout` / `clearTimeout`. */
  restore(): void;
}

/** Replace global `setTimeout` / `clearTimeout` with a hand-driven queue so the
 *  scheduled delays are directly assertable and callbacks fire on demand. */
export function installManualTimers(): ManualTimers {
  let scheduled: ScheduledTimer[] = [];
  let nextId = 1;
  const restoreSet = installGlobal(
    'setTimeout',
    ((cb: () => void, delay: number) => {
      const handle: ScheduledTimer = { id: nextId++, cb, delay };
      scheduled.push(handle);
      return handle;
    }) as unknown as typeof setTimeout,
  );
  const restoreClear = installGlobal(
    'clearTimeout',
    ((handle: ScheduledTimer) => {
      scheduled = scheduled.filter((s) => s !== handle);
    }) as unknown as typeof clearTimeout,
  );

  return {
    get scheduled() {
      return scheduled;
    },
    fireAll() {
      const due = scheduled;
      scheduled = [];
      for (const s of due) s.cb();
    },
    restore() {
      restoreClear();
      restoreSet();
    },
  };
}

// ---- WebSocket ------------------------------------------------------------

/** A scriptable `WebSocket` double: construction records the instance, and
 *  `serverAccept()` / `serverDrop()` drive the open / close lifecycle by hand. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  // Test-side drivers for the server lifecycle.
  serverAccept() {
    this.onopen?.();
  }
  serverDrop() {
    this.onclose?.();
  }
}

/** Install {@link FakeWebSocket} as the global `WebSocket`, resetting its
 *  recorded instances. Returns a restore thunk. */
export function installFakeWebSocket(): () => void {
  FakeWebSocket.instances = [];
  return installGlobal('WebSocket', FakeWebSocket);
}
