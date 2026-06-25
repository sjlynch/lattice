// Shared empty iterator for nodes that have no outgoing-edge entry. Set
// iterators stay `done` forever once created empty, so a single instance is
// safe to reuse across frames.
const EMPTY_ITERATOR: Iterator<string> = new Set<string>().values();

// Tarjan's strongly-connected components. Returns an array of SCCs; any SCC
// with more than one node — or a single node that imports itself — is a
// dependency cycle.
//
// Implemented with an explicit work stack rather than self-recursion. The
// original recursive `strongConnect` recursed once per edge along the deepest
// DFS path, so its call depth equalled the longest simple import chain. A
// codegen-heavy repo (ORM models, protobuf, a long linear barrel chain
// a -> b -> ... -> zN thousands of files deep) blew the JS call stack with
// `RangeError: Maximum call stack size exceeded` — which the watcher swallows
// (silently halting cross-file updates) and which can abort a full scan. The
// iterative form keeps its frames on the heap, so cycle detection scales to
// arbitrarily deep graphs like the rest of the pipeline (cf. reachability.ts,
// which was always iterative for exactly this reason).
export function tarjan(
  nodes: string[],
  edges: Map<string, Set<string>>,
): string[][] {
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  // The Tarjan node stack: candidate members of the SCC currently being built.
  // Distinct from the DFS `work` stack below.
  const stack: string[] = [];
  const sccs: string[][] = [];
  let index = 0;

  // One DFS frame per node on the current path. `it` is the lazily-created
  // iterator over the node's successors; a null `it` flags a not-yet-entered
  // frame so the entry bookkeeping runs exactly once. Pushing a frame stands in
  // for a recursive call; popping it stands in for the return, where we fold
  // the child's lowlink back into its parent.
  type Frame = { node: string; it: Iterator<string> | null };
  const work: Frame[] = [];

  for (const n of nodes) {
    if (indices.has(n)) continue;
    work.push({ node: n, it: null });

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const v = frame.node;

      if (frame.it === null) {
        // First visit to this frame: assign index/lowlink and put v on the
        // Tarjan stack (the head of recursive strongConnect).
        indices.set(v, index);
        lowlinks.set(v, index);
        index++;
        stack.push(v);
        onStack.add(v);
        const successors = edges.get(v);
        frame.it = successors ? successors.values() : EMPTY_ITERATOR;
      }

      // Walk v's remaining successors. The iterator state lives on the frame,
      // so descending into a child and later resuming here picks up exactly
      // where iteration left off.
      let descended = false;
      let next = frame.it.next();
      while (!next.done) {
        const w = next.value;
        if (!indices.has(w)) {
          // Unvisited successor → "recurse" by pushing a child frame. v's
          // lowlink is updated from the child when the child returns (the pop
          // step below).
          work.push({ node: w, it: null });
          descended = true;
          break;
        } else if (onStack.has(w)) {
          lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
        }
        next = frame.it.next();
      }
      if (descended) continue;

      // All successors processed — the "return" from strongConnect(v).
      if (lowlinks.get(v) === indices.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        sccs.push(scc);
      }

      work.pop();
      if (work.length > 0) {
        // Fold v's lowlink into its parent — the work the recursive version did
        // immediately after `strongConnect(w)` returned.
        const parent = work[work.length - 1].node;
        lowlinks.set(parent, Math.min(lowlinks.get(parent)!, lowlinks.get(v)!));
      }
    }
  }

  return sccs;
}

export function cyclicNodes(
  sccs: string[][],
  edges: Map<string, Set<string>>,
): Set<string> {
  const inCycle = new Set<string>();
  for (const scc of sccs) {
    if (scc.length > 1) {
      for (const n of scc) inCycle.add(n);
    } else if (scc.length === 1) {
      const n = scc[0];
      if (edges.get(n)?.has(n)) inCycle.add(n);
    }
  }
  return inCycle;
}
