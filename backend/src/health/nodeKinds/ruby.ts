import { buildNodeKinds, type NodeKinds } from './base.js';

// Ruby uses different node names than the C-family grammars: `if`,
// `unless`, `while`, `until`, `case`, `when`, `rescue`. Method
// definitions are `method` / `singleton_method`. Ruby has no ternary
// node — `?:` parses as a conditional expression but is rarely
// idiomatic; skip it.
//
// `do_block` and `block` (the brace/do iteration blocks passed to
// `each`/`map`/etc.) are NOT treated as separate functions — they're
// closures that semantically belong to their enclosing method.
// Treating them as functions inflated `functionCount` wildly (every
// `arr.each { ... }` was a "function"), reset Sonar nesting in the
// middle of a method, and ate the enclosing method's `ownLines`.
// Instead they're registered as nesting kinds so code inside them
// still picks up a nesting penalty without becoming its own scope.
// `lambda` (`->(x) { ... }`) stays as an anonymous function since
// it's used as a real first-class value, not just a local block.
const RUBY_FUNCTION_KINDS = ['method', 'singleton_method', 'lambda'];
const RUBY_NAMED_FUNCTION_KINDS = ['method', 'singleton_method'];
const RUBY_ANONYMOUS_FUNCTION_KINDS = ['lambda'];
const RUBY_BRANCH_KINDS = [
  'if',
  'elsif',
  'unless',
  'while',
  'until',
  'for',
  'when',
  'rescue',
  'conditional',
];
const RUBY_COGNITIVE_BRANCH_KINDS = [
  'if',
  'unless',
  'while',
  'until',
  'for',
  'case',
  'rescue',
  'conditional',
];
const RUBY_NESTING_KINDS = [
  'if',
  'unless',
  'while',
  'until',
  'for',
  'case',
  'begin',
  'rescue',
  'conditional',
  // Iteration blocks bump nesting depth without becoming their own
  // function scope (see RUBY_FUNCTION_KINDS comment above).
  'do_block',
  'block',
];

export function buildRubyNodeKinds(): NodeKinds {
  return buildNodeKinds({
    functionKinds: RUBY_FUNCTION_KINDS,
    namedFunctionKinds: RUBY_NAMED_FUNCTION_KINDS,
    anonymousFunctionKinds: RUBY_ANONYMOUS_FUNCTION_KINDS,
    classKinds: ['class', 'module'],
    branchKinds: RUBY_BRANCH_KINDS,
    cognitiveBranchKinds: RUBY_COGNITIVE_BRANCH_KINDS,
    nestingKinds: RUBY_NESTING_KINDS,
    ternaryKinds: ['conditional'],
    catchClauseKinds: ['rescue'],
    callKinds: ['call', 'command', 'command_call', 'method_call'],
    stringKinds: ['string', 'heredoc_body'],
    commentKinds: ['comment'],
    importSourceField: 'name',
  });
}
