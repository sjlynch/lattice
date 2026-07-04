import type { Node } from 'web-tree-sitter';
import type { GrammarKey } from '../parser.js';
import type { NodeKinds } from '../nodeKinds/index.js';
import type { FileAnalysis } from './index.js';
import { countOptionalChainDepth, countTernaryDepth } from './depth.js';

// ---------- AST-based smell detection ----------
//
// Runs unconditionally for every node, regardless of whether we're
// inside a function. The previous implementation gated this behind
// `if (currentFn()) { ...; return; }`, which meant any code inside a
// function body — i.e., nearly all real code — silently bypassed
// every smell check. Calling this separately from the function-
// context complexity logic fixes that.
export function detectAstSmells(
  node: Node,
  t: string,
  smellTokens: FileAnalysis['smellTokens'],
  kinds: NodeKinds,
  grammar: GrammarKey,
  isTs: boolean,
  isJsFamily: boolean,
): void {
  const ctx: AstSmellContext = {
    node,
    t,
    smellTokens,
    kinds,
    grammar,
    isTs,
    isJsFamily,
  };

  detectTsJsSmells(ctx);
  detectPythonSmells(ctx);
  detectGenericStructureSmells(ctx);
}

type AstSmellContext = {
  node: Node;
  t: string;
  smellTokens: FileAnalysis['smellTokens'];
  kinds: NodeKinds;
  grammar: GrammarKey;
  isTs: boolean;
  isJsFamily: boolean;
};

function detectTsJsSmells(ctx: AstSmellContext): void {
  const { node, t, smellTokens } = ctx;

  // These smells (loose_equality, var_keyword, type_assertion,
  // non_null_assertion, debugger_stmt, …) are JS/TS-specific. C-family
  // grammars (Go/Rust/Java/C#) model `a == b` as a `binary_expression`
  // with a `==` token, and C# additionally has `variable_declaration` /
  // `as_expression` nodes — without this gate every equality comparison
  // and local var in those languages mis-fired a smell, depressing their
  // health score. Mirrors detectPythonSmells's `grammar !== 'python'`
  // early return.
  if (!ctx.isJsFamily) return;

  if (ctx.isTs && t === 'predefined_type' && node.text === 'any') {
    smellTokens.anyType++;
  }
  if (t === 'as_expression' || t === 'type_assertion') {
    smellTokens.typeAssertion++;
  }
  if (t === 'non_null_expression') {
    smellTokens.nonNullAssertion++;
  }
  if (t === 'debugger_statement') {
    smellTokens.debuggerStmt++;
  }
  if (t === 'variable_declaration') {
    // var keyword (let/const → lexical_declaration).
    smellTokens.varDecls++;
  }
  if (t === 'binary_expression' && hasLooseEqualityOperator(node)) {
    smellTokens.looseEquality++;
  }
  if (t === 'catch_clause' && isEmptyCatchClause(node)) {
    smellTokens.emptyCatch++;
  }
  if (ctx.isJsFamily && isOptionalChainCarrier(t)) {
    const depth = countOptionalChainDepth(node);
    if (depth > 4) smellTokens.deepOptionalChain++;
  }
}

function detectPythonSmells(ctx: AstSmellContext): void {
  const { node, t, smellTokens } = ctx;
  if (ctx.grammar !== 'python') return;

  if (t === 'except_clause' && isBareExceptClause(node)) {
    smellTokens.bareExcept++;
  }
  if (t === 'global_statement') {
    smellTokens.globalKeyword++;
  }
}

function detectGenericStructureSmells(ctx: AstSmellContext): void {
  if (!ctx.kinds.ternary.has(ctx.t)) return;

  const depth = countTernaryDepth(ctx.node, ctx.kinds);
  if (depth >= 3) ctx.smellTokens.deepTernary++;
}

function hasLooseEqualityOperator(node: Node): boolean {
  for (const c of node.children) {
    if (c && (c.type === '==' || c.type === '!=')) return true;
  }
  return false;
}

function isEmptyCatchClause(node: Node): boolean {
  const body =
    node.childForFieldName('body') ||
    node.namedChildren.find((c) => c?.type === 'statement_block');
  return !!body && body.namedChildCount === 0;
}

function isBareExceptClause(node: Node): boolean {
  // Bare except: only the `except` keyword + `:` + block as children, no
  // exception type.
  for (const c of node.children) {
    if (!c) continue;
    const ct = c.type;
    if (
      ct !== 'except' &&
      ct !== ':' &&
      ct !== 'block' &&
      ct !== 'comment'
    ) {
      return false;
    }
  }
  return true;
}

function isOptionalChainCarrier(t: string): boolean {
  return (
    t === 'member_expression' ||
    t === 'subscript_expression' ||
    t === 'call_expression'
  );
}
