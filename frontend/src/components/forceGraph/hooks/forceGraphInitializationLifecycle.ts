type Teardown = () => void;

// Each slot is filled immediately after the corresponding resource is acquired.
// The order below follows the existing unmount contract, rather than reversing
// acquisition order (in particular, stop idle work before disconnecting resize).
type InitializationResources = {
  removeContextLost?: Teardown;
  removeContextRestored?: Teardown;
  offThrottleFrame?: Teardown;
  destroyIdle?: Teardown;
  teardownResize?: Teardown;
};

// Only the slice of the WebGL renderer teardown needs: `dispose()` (run by the
// graph's `_destructor`) frees three's GPU objects but keeps the context and its
// drawing buffer alive until a GC; only `forceContextLoss()` releases them.
type OwnedRenderer = { forceContextLoss?(): void };
type OwnedGraph = {
  _destructor?: Teardown;
  renderer?: () => OwnedRenderer | null | undefined;
};

// Kept independent of React/WebGL so failures can be injected at each boundary.
// A constructor that throws exposes no instance; only a returned graph is owned.
export function initializeForceGraphLifecycle<Graph extends OwnedGraph>({
  container,
  graphRef,
  createGraph,
  configureGraph,
  registerResources,
  clearLabels,
  disposeSharedResources,
  onRendererFailure,
}: {
  container: { replaceChildren(): void };
  graphRef: { current: Graph | null };
  createGraph: () => Graph;
  configureGraph: (graph: Graph) => void;
  registerResources: (graph: Graph, owned: InitializationResources) => void;
  clearLabels: Teardown;
  // Module-level resources shared across graphs (e.g. sprite material caches),
  // released once per owned graph's teardown, after its destructor.
  disposeSharedResources?: Teardown;
  onRendererFailure: (error: unknown) => void;
}): Teardown | undefined {
  let graph: Graph | null = null;
  const owned: InitializationResources = {};
  let disposed = false;

  const teardown = (clearContainer = false): unknown[] => {
    if (disposed) return [];
    // Claim teardown before calling user/library code, including a destructor
    // that might throw or reenter cleanup. Every operation gets one attempt.
    disposed = true;
    const errors: unknown[] = [];
    const attempt = (cleanup?: Teardown) => {
      try {
        cleanup?.();
      } catch (error) {
        errors.push(error);
      }
    };

    attempt(owned.removeContextLost);
    attempt(owned.removeContextRestored);
    attempt(owned.offThrottleFrame);
    attempt(owned.destroyIdle);
    attempt(owned.teardownResize);
    if (graph) {
      // Use the existing registry release path; shared materials stay owned by
      // their modules and are never disposed per node here.
      attempt(clearLabels);
      // Capture before the destructor, which may throw or clear library state.
      let renderer: OwnedRenderer | null | undefined;
      attempt(() => {
        renderer = graph?.renderer?.();
      });
      attempt(() => graph?._destructor?.());
      // Shared caches next, while the context is still live: this drops the
      // old renderer's `dispose` listeners that would otherwise pin it.
      attempt(disposeSharedResources);
      // Last, so nothing after it touches the GL: release the context and its
      // drawing buffer now rather than at a GC, so remounts don't pile up live
      // contexts toward the browser's per-page limit (which then force-loses
      // the oldest one, possibly a terminal's). Our context-lost listener was
      // removed above and three's in `renderer.dispose()`, so no notice fires.
      attempt(() => renderer?.forceContextLoss?.());
    }
    attempt(() => {
      graphRef.current = null;
    });
    if (clearContainer) attempt(() => container.replaceChildren());
    return errors;
  };

  try {
    // Capture ownership before any setter or later setup operation can throw.
    graph = createGraph();
    configureGraph(graph);
    graphRef.current = graph;
    registerResources(graph, owned);
  } catch (error) {
    // Cleanup faults must not replace the original renderer failure or prevent
    // the recoverable notice from appearing over a clean retry container.
    teardown(true);
    onRendererFailure(error);
    return;
  }

  return () => {
    const errors = teardown();
    // Preserve normal unmount's error propagation, after all cleanup attempts.
    if (errors.length) throw errors[0];
  };
}
