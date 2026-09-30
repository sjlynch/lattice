type WebglAddonLifecycle = {
  onContextLoss(listener: () => void): unknown;
  dispose(): void;
};

export function disposeTerminalWebgl<T extends { dispose(): void }>(
  webglRef: { current: T | null },
) {
  try {
    webglRef.current?.dispose();
  } catch {
    /* ignore */
  }
  webglRef.current = null;
}

// The factory keeps activation failures testable without a browser or GPU.
export function attachTerminalWebgl<T extends WebglAddonLifecycle>(
  term: { loadAddon(addon: T): void },
  webglRef: { current: T | null },
  createAddon: () => T,
) {
  let attemptedAddon: T | null = null;
  try {
    const webgl = createAddon();
    attemptedAddon = webgl;
    webgl.onContextLoss(() => {
      try {
        webgl.dispose();
      } catch {
        /* ignore */
      }
      if (webglRef.current === webgl) webglRef.current = null;
    });
    term.loadAddon(webgl);
    webglRef.current = webgl;
  } catch {
    // xterm registers the add-on before activating it. Its wrapped dispose
    // removes that registration even when activation failed.
    try {
      attemptedAddon?.dispose();
    } catch {
      /* ignore */
    }
    // WebGL unavailable / context limit hit — DOM renderer stays.
  }
}
