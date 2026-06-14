// Tarjan's strongly-connected components. Returns an array of SCCs; any SCC
// with more than one node — or a single node that imports itself — is a
// dependency cycle.
export function tarjan(
  nodes: string[],
  edges: Map<string, Set<string>>,
): string[][] {
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let index = 0;

  function strongConnect(v: string): void {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    const successors = edges.get(v);
    if (successors) {
      for (const w of successors) {
        if (!indices.has(w)) {
          strongConnect(w);
          lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
        } else if (onStack.has(w)) {
          lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
        }
      }
    }

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
  }

  for (const n of nodes) {
    if (!indices.has(n)) strongConnect(n);
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
