type WebglAddonLifecycle = {
  onContextLoss(listener: () => void): unknown;
  dispose(): void;
};

// The slice of HTMLCanvasElement needed to release one. Structural so the
// lifecycle tests run without a DOM.
export type ReleasableCanvas = {
  width: number;
  height: number;
  getContext(contextId: 'webgl2'): {
    getExtension(name: 'WEBGL_lose_context'): { loseContext(): void } | null;
  } | null;
  remove(): void;
};

// Canvases each add-on inserted under the terminal element. The add-on's
// dispose only detaches them, so its WebGL2 context and the backing stores
// would otherwise stay allocated until V8 happens to run a major GC.
const addonCanvases = new WeakMap<object, readonly ReleasableCanvas[]>();

function listCanvasesSafely(
  listCanvases: () => readonly ReleasableCanvas[],
): readonly ReleasableCanvas[] {
  try {
    return listCanvases();
  } catch {
    return [];
  }
}

// Called after the add-on's dispose, which has removed its webglcontextlost
// listener and our onContextLoss subscription. getContext('webgl2') returns
// the canvas's existing context (null for xterm's 2D link layer).
function releaseCanvas(canvas: ReleasableCanvas) {
  try {
    canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    /* ignore */
  }
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    /* ignore */
  }
  // Dispose already detached it, but a failed activation can leave it attached.
  try {
    canvas.remove();
  } catch {
    /* ignore */
  }
}

function disposeAndRelease(addon: { dispose(): void }) {
  try {
    addon.dispose();
  } catch {
    /* ignore */
  }
  const canvases = addonCanvases.get(addon) ?? [];
  addonCanvases.delete(addon);
  for (const canvas of canvases) releaseCanvas(canvas);
}

export function disposeTerminalWebgl<T extends { dispose(): void }>(
  webglRef: { current: T | null },
) {
  const addon = webglRef.current;
  webglRef.current = null;
  if (addon) disposeAndRelease(addon);
}

// The factory keeps activation failures testable without a browser or GPU;
// `listCanvases` (the canvases under the terminal element) likewise keeps
// canvas release testable without a DOM.
export function attachTerminalWebgl<T extends WebglAddonLifecycle>(
  term: { loadAddon(addon: T): void },
  webglRef: { current: T | null },
  createAddon: () => T,
  listCanvases: () => readonly ReleasableCanvas[] = () => [],
) {
  let attemptedAddon: T | null = null;
  let canvasesBefore: ReadonlySet<ReleasableCanvas> | null = null;
  // xterm 6's DOM renderer has no canvases, so whatever appears during
  // loadAddon belongs to the add-on (its WebGL canvas and link layer).
  const recordAddedCanvases = (addon: T) => {
    if (!canvasesBefore) return;
    const before = canvasesBefore;
    const added = listCanvasesSafely(listCanvases).filter((canvas) => !before.has(canvas));
    if (added.length > 0) addonCanvases.set(addon, added);
  };
  try {
    const webgl = createAddon();
    attemptedAddon = webgl;
    webgl.onContextLoss(() => {
      disposeAndRelease(webgl);
      if (webglRef.current === webgl) webglRef.current = null;
    });
    canvasesBefore = new Set(listCanvasesSafely(listCanvases));
    term.loadAddon(webgl);
    recordAddedCanvases(webgl);
    webglRef.current = webgl;
  } catch {
    // xterm registers the add-on before activating it. Its wrapped dispose
    // removes that registration even when activation failed.
    if (attemptedAddon) {
      recordAddedCanvases(attemptedAddon);
      disposeAndRelease(attemptedAddon);
    }
    // WebGL unavailable / context limit hit — DOM renderer stays.
  }
}
