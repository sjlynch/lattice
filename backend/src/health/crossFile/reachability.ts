// Forward reachability: every file transitively imported by a root. `edges`
// maps a file to the set of files it imports, so a DFS from the roots over
// `edges` is exactly "what does the live program pull in".
export function computeReachability(
  edges: Map<string, Set<string>>,
  roots: Iterable<string>,
): Set<string> {
  const reachable = new Set<string>();
  const stack: string[] = [];
  for (const r of roots) {
    if (!reachable.has(r)) {
      reachable.add(r);
      stack.push(r);
    }
  }
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const outs = edges.get(cur);
    if (!outs) continue;
    for (const next of outs) {
      if (!reachable.has(next)) {
        reachable.add(next);
        stack.push(next);
      }
    }
  }
  return reachable;
}
