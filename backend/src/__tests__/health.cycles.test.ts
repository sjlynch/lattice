// Tarjan SCC / cycle detection — the iterative form must scale to import chains
// far deeper than the JS call stack. Split out of the original health.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cyclicNodes, tarjan } from '../health/crossFile/cycles.js';

// Regression: the original recursive Tarjan recursed once per edge along the
// deepest DFS path, so call depth == longest simple import chain. A long linear
// chain (a -> b -> ... -> zN) thousands of files deep threw `RangeError:
// Maximum call stack size exceeded`. The iterative form keeps frames on the
// heap and must complete cleanly on a chain far deeper than the JS call stack.
test('Tarjan cycle detection scales to a deep import chain without stack overflow', () => {
  const N = 20000;
  const nodes: string[] = [];
  const edges = new Map<string, Set<string>>();
  for (let i = 0; i < N; i++) {
    const file = `f${i}.ts`;
    nodes.push(file);
    // Each file imports the next; the last imports nothing — a pure acyclic chain.
    edges.set(file, new Set(i + 1 < N ? [`f${i + 1}.ts`] : []));
  }

  const sccs = tarjan(nodes, edges);
  // An acyclic chain has one singleton SCC per node and no cycles.
  assert.equal(sccs.length, N, 'one SCC per node in an acyclic chain');
  assert.equal(cyclicNodes(sccs, edges).size, 0, 'no node is in a cycle');
});

// Same depth, but the chain closes into a ring (cN-1 -> c0) so the whole thing
// is one strongly-connected component. Exercises the deep descent AND the
// SCC-collapse that happens on the unwind/return side.
test('Tarjan detects one giant cycle across a deep chain', () => {
  const N = 20000;
  const nodes: string[] = [];
  const edges = new Map<string, Set<string>>();
  for (let i = 0; i < N; i++) {
    const file = `c${i}.ts`;
    nodes.push(file);
    edges.set(file, new Set([`c${(i + 1) % N}.ts`]));
  }

  const sccs = tarjan(nodes, edges);
  assert.equal(cyclicNodes(sccs, edges).size, N, 'every node in the ring is cyclic');
  const big = sccs.filter((s) => s.length > 1);
  assert.equal(big.length, 1, 'the entire ring collapses into a single SCC');
  assert.equal(big[0].length, N, 'and that SCC spans every node');
});
