// Renderer (WebGL) status for the file graph. Split out of the React layer so
// the classification + copy can be unit-tested without a DOM.
//
// The graph owns the app's only long-lived WebGL context, and a browser can
// refuse one for reasons that have nothing to do with Lattice: the per-page
// context budget is already spent (each active xterm WebglAddon takes one
// too), the GPU process is down — an out-of-memory kill is the usual cause,
// and Chrome then withholds contexts until the *browser* restarts — or
// hardware acceleration is switched off. THREE surfaces all of them the same
// way, by throwing `Error creating WebGL context.` out of `new WebGLRenderer`.

export type RendererStatus =
  | { kind: 'ok' }
  // Mount failed: no graph exists. `webgl` distinguishes "the browser wouldn't
  // give us a context" from any other scene-setup fault, which changes the
  // advice the notice shows.
  | { kind: 'unavailable'; message: string; webgl: boolean }
  // The context was created, then taken away (`webglcontextlost`). The scene is
  // intact; the canvas is frozen until the browser restores it.
  | { kind: 'lost' };

export function rendererErrorText(error: unknown): string {
  // An Error is read by message, never stringified: `String(new Error(''))` is
  // the useless literal "Error", which would be all the notice could show.
  const text =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error ?? '');
  return text.trim() || 'Unknown renderer error';
}

// Matches the wording every engine/browser uses for "no context for you":
// THREE's own `Error creating WebGL context.`, plus the
// `WebGL is not supported` / `WebGL unsupported` phrasings.
export function isWebglUnavailableError(error: unknown): boolean {
  const text = rendererErrorText(error).toLowerCase();
  if (!text.includes('webgl')) return false;
  return (
    text.includes('context') ||
    text.includes('support') ||
    text.includes('unavailable') ||
    text.includes('disabled')
  );
}

export function describeRendererFailure(error: unknown): RendererStatus {
  return {
    kind: 'unavailable',
    message: rendererErrorText(error),
    webgl: isWebglUnavailableError(error),
  };
}
