import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFile } from '../health/index.js';

// A switch with N cases used to cost N*(1+nesting) cognitive points
// because every switch_case fired the cognitive penalty. The Sonar
// B1 spec says the switch dispatches once with the nesting penalty
// and individual cases add nothing, so this same source should now
// land at a small constant regardless of case count.
test('cognitive complexity does not blow up on switch with many cases', async () => {
  const src = `
function dispatch(x: string): number {
  switch (x) {
    case 'a': return 1;
    case 'b': return 2;
    case 'c': return 3;
    case 'd': return 4;
    case 'e': return 5;
    case 'f': return 6;
    case 'g': return 7;
    default: return 0;
  }
}
`;
  const loc = src.split('\n').length;
  const r = await analyzeFile(src, '.ts', loc);
  // Pre-fix: ~8 (one per case at nesting 0). Post-fix: 1 (the
  // switch_statement itself). Allow some slack but assert it's
  // well under the high_cognitive_complexity threshold of 15.
  assert.ok(
    r.metrics.cognitiveMax <= 3,
    `expected cognitiveMax <= 3, got ${r.metrics.cognitiveMax}`,
  );
  // Cyclomatic still counts each case as a path — that part is
  // unchanged and a switch with 8 cases legitimately has 8+ paths.
  assert.ok(
    r.metrics.cyclomaticMax >= 7,
    `expected cyclomaticMax >= 7, got ${r.metrics.cyclomaticMax}`,
  );
});

test('Go file is analyzed via tree-sitter, not fallback', async () => {
  const src = `package main

import "fmt"

func add(a int, b int) int {
  if a > b {
    return a + b
  }
  return b + a
}

func main() {
  fmt.Println(add(1, 2))
}
`;
  const loc = src.split('\n').length;
  const r = await analyzeFile(src, '.go', loc);
  assert.equal(r.metrics.language, 'go');
  // Two named functions, both detected.
  assert.equal(r.metrics.functionCount, 2);
  assert.equal(r.metrics.namedFunctionCount, 2);
  // The if branch should bump cyclomatic for `add` past 1.
  assert.ok(r.metrics.cyclomaticMax >= 2);
});

test('Rust file: match expression contributes to cognitive once', async () => {
  const src = `fn classify(x: i32) -> &'static str {
  match x {
    0 => "zero",
    1 => "one",
    2 => "two",
    _ => "other",
  }
}
`;
  const loc = src.split('\n').length;
  const r = await analyzeFile(src, '.rs', loc);
  assert.equal(r.metrics.language, 'rust');
  assert.equal(r.metrics.functionCount, 1);
  // Cognitive: just the match dispatch itself. Pre-fix-style
  // accidentally-overcounting Rust would give us 4+.
  assert.ok(
    r.metrics.cognitiveMax <= 2,
    `expected cognitiveMax <= 2, got ${r.metrics.cognitiveMax}`,
  );
  // McCabe paths: 4 arms.
  assert.ok(r.metrics.cyclomaticMax >= 4);
});

test('Java method declaration is recognized', async () => {
  const src = `
public class Foo {
  public int add(int a, int b) {
    if (a > b) {
      return a + b;
    }
    return b + a;
  }
}
`;
  const loc = src.split('\n').length;
  const r = await analyzeFile(src, '.java', loc);
  assert.equal(r.metrics.language, 'java');
  assert.ok(r.metrics.functionCount >= 1);
  assert.ok(r.metrics.classCount >= 1);
});

test('files at fallback path still report language=fallback', async () => {
  const r = await analyzeFile('echo hello', '.sh', 1);
  assert.equal(r.metrics.language, 'fallback');
});
