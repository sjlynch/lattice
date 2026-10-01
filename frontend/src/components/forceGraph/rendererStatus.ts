// Renderer (WebGL) status for the file graph. Kept outside React so the
// classification and copy can be unit-tested without a DOM.
//
// WebGL construction errors and `webglcontextlost` report renderer failure,
// not its cause: neither alone establishes OOM or a garbage-collection defect.
// Retry remounts the coordinator and its hooks; `webglcontextrestored` clears
// the notice. A browser restart may help persistent failures, but is neither
// a guaranteed nor an exclusive recovery action. See the recovery advice in
// ../../../README.md#browser-memory-troubleshooting.

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
