// Tree-sitter AST walker. Single recursive pass over the file's tree,
// extracting per-function records (length, params, cyclomatic,
// cognitive, nesting, call set, async/await, docstring) plus
// file-level totals (class count, interface count, imports, string
// literal occurrences for the magic-string check).
//
// Cognitive complexity follows SonarSource's "B1" specification:
// linearity-breaking control structures add `1 + currentNesting`,
// non-nesting alternatives like `else` add 1, and short-circuit
// operator sequences add 1 each time the operator changes.

import type { Node, Tree } from 'web-tree-sitter';
import type { GrammarKey } from './parser.js';
import { nodeKindsFor, type NodeKinds } from './nodeKinds.js';

export type FnRecord = {
  node: Node;
  name: string | null;
  isAnonymous: boolean;
  isAsync: boolean;
  hasAwait: boolean;
  startLine: number;
  endLine: number;
  totalLines: number;
  // Lines belonging to this function's own scope (excluding nested
  // function bodies). Better signal of "is this function itself long"
  // than `totalLines` for a React component or Python class with many
  // methods.
  ownLines: number;
  cyclomatic: number;
  cognitive: number;
  maxNestingDepth: number;
  paramCount: number;
  booleanParamCount: number;
  hasDocstring: boolean;
  // Names of called functions/methods (just the leaf identifier).
  // Used for the within-file call graph density metric.
  calls: Set<string>;
};

export type FileAnalysis = {
  functions: FnRecord[];
  classCount: number;
  interfaceCount: number;
  imports: string[];
  // Counts for AST-driven smells detected during the walk.
  smellTokens: {
    anyType: number;
    typeAssertion: number;
    nonNullAssertion: number;
    debuggerStmt: number;
    consoleCalls: number;
    evalCalls: number;
    varDecls: number;
    looseEquality: number;
    emptyCatch: number;
    deepOptionalChain: number;
    deepTernary: number;
    emptyInterface: number;
    printCalls: number;
    bareExcept: number;
    wildcardImport: number;
    mutableDefaultArg: number;
    globalKeyword: number;
    tsIgnore: number;
    eslintDisable: number;
    mixedExports: number;
  };
  // For magic-string detection: literal -> count
  stringLiterals: Map<string, number>;
};

const SHORT_CIRCUIT_OPS_TS = new Set(['&&', '||', '??']);
const PY_BOOL_OP_TYPE = 'boolean_operator';

function lineSpan(node: Node): { startLine: number; endLine: number; total: number } {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  return { startLine, endLine, total: Math.max(1, endLine - startLine + 1) };
}

// Pull a name out of a function-like node. For named declarations
// (function/method/generator) the grammar exposes a `name` field;
// for arrow functions and function expressions we look at the
// enclosing `variable_declarator` (`const X = () => {}`), object
// literal pair (`{ foo: () => {} }`), or class field
// (`foo = () => {}`) so React's idiomatic component definitions get
// counted as NAMED rather than anonymous.
function getFunctionName(node: Node, grammar: GrammarKey): string | null {
  const nameField = node.childForFieldName('name');
  if (nameField) return nameField.text;

  if (node.type === 'arrow_function' || node.type === 'function_expression') {
    const parent = node.parent;
    if (parent) {
      if (parent.type === 'variable_declarator') {
        const id = parent.childForFieldName('name');
        if (id && id.type === 'identifier') return id.text;
      }
      if (parent.type === 'pair') {
        const key = parent.childForFieldName('key');
        if (key) return key.text;
      }
      if (
        parent.type === 'public_field_definition' ||
        parent.type === 'field_definition'
      ) {
        const name = parent.childForFieldName('name');
        if (name) return name.text;
      }
      if (parent.type === 'assignment_expression') {
        const left = parent.childForFieldName('left');
        if (left && left.type === 'identifier') return left.text;
      }
    }
  }

  if (grammar === 'python') {
    for (const c of node.namedChildren) {
      if (c && c.type === 'identifier') return c.text;
    }
  }
  return null;
}

function getParameterCount(node: Node, grammar: GrammarKey): number {
  // Different grammars expose params under different field names.
  // Try the common ones; fall back to a heuristic search.
  const params =
    node.childForFieldName('parameters') ||
    node.childForFieldName('parameter') ||
    null;
  if (params) {
    let count = 0;
    for (const c of params.namedChildren) {
      if (!c) continue;
      // Skip type annotation nodes (TS) and skip the brackets themselves.
      const t = c.type;
      if (t === 'type_annotation' || t === 'comment') continue;
      count++;
    }
    return count;
  }
  if (grammar === 'python') {
    // Python lambdas: parameters listed before the colon.
    const paramsNode = node.namedChildren.find(
      (c) => c?.type === 'parameters' || c?.type === 'lambda_parameters',
    );
    if (paramsNode) {
      return paramsNode.namedChildren.filter((c) => c && c.type !== 'comment').length;
    }
  }
  return 0;
}

function isShortCircuitOperator(node: Node, grammar: GrammarKey): string | null {
  if (grammar === 'python') {
    if (node.type === PY_BOOL_OP_TYPE) {
      const op = node.childForFieldName('operator');
      if (op) return op.type;
      for (const c of node.children) {
        if (c && (c.type === 'and' || c.type === 'or')) return c.type;
      }
    }
    return null;
  }
  if (node.type !== 'binary_expression') return null;
  for (const c of node.children) {
    if (!c) continue;
    if (SHORT_CIRCUIT_OPS_TS.has(c.type)) return c.type;
  }
  return null;
}

function isBooleanParam(node: Node, grammar: GrammarKey): boolean {
  if (grammar === 'python') {
    if (node.type === 'typed_parameter') {
      const typeNode = node.childForFieldName('type');
      if (typeNode && /\bbool\b/.test(typeNode.text)) return true;
    }
    if (node.type === 'default_parameter') {
      const valueNode = node.childForFieldName('value');
      if (valueNode && (valueNode.text === 'True' || valueNode.text === 'False')) return true;
    }
    return false;
  }
  if (node.type === 'required_parameter' || node.type === 'optional_parameter') {
    const typeNode = node.childForFieldName('type');
    if (typeNode && /\bboolean\b/.test(typeNode.text)) return true;
  }
  return false;
}

function isMutableDefaultPython(node: Node): boolean {
  if (node.type !== 'default_parameter') return false;
  const value = node.childForFieldName('value');
  if (!value) return false;
  const t = value.type;
  return t === 'list' || t === 'dictionary' || t === 'set';
}

// Optional-chain depth: count how many `?.` tokens appear in a
// single chain. Tree-sitter-typescript wraps each `?.` in a *named*
// `optional_chain` node whose own child is the anonymous `?.` token,
// so we have to check both the wrapping node type AND the literal
// token type to be robust across grammar versions.
function countOptionalChainDepth(node: Node): number {
  let depth = 0;
  let cur: Node | null = node;
  while (cur) {
    const t = cur.type;
    if (
      t !== 'member_expression' &&
      t !== 'subscript_expression' &&
      t !== 'call_expression'
    ) {
      break;
    }
    let hasOptional = false;
    for (const c of cur.children) {
      if (!c) continue;
      if (c.type === 'optional_chain' || c.type === '?.') {
        hasOptional = true;
        break;
      }
    }
    if (hasOptional) depth++;
    cur = cur.namedChildren[0] ?? null;
  }
  return depth;
}

// Detect ternary nesting depth at this node. At each ternary, walk
// the consequence/alternative sub-trees and count the deepest
// nested ternary chain.
function countTernaryDepth(node: Node, kinds: NodeKinds): number {
  if (!kinds.ternary.has(node.type)) return 0;
  let max = 0;
  for (const c of node.namedChildren) {
    if (!c) continue;
    const d = countTernaryDepthInner(c, kinds);
    if (d > max) max = d;
  }
  return 1 + max;
}

function countTernaryDepthInner(node: Node, kinds: NodeKinds): number {
  if (kinds.ternary.has(node.type)) return countTernaryDepth(node, kinds);
  let max = 0;
  for (const c of node.namedChildren) {
    if (!c) continue;
    const d = countTernaryDepthInner(c, kinds);
    if (d > max) max = d;
  }
  return max;
}

export function analyzeTree(
  tree: Tree,
  grammar: GrammarKey,
  source: string,
): FileAnalysis {
  const kinds = nodeKindsFor(grammar);
  const root = tree.rootNode;
  const isJsFamily =
    grammar === 'typescript' || grammar === 'tsx' || grammar === 'javascript';
  const isTs = grammar === 'typescript' || grammar === 'tsx';

  const result: FileAnalysis = {
    functions: [],
    classCount: 0,
    interfaceCount: 0,
    imports: [],
    smellTokens: {
      anyType: 0,
      typeAssertion: 0,
      nonNullAssertion: 0,
      debuggerStmt: 0,
      consoleCalls: 0,
      evalCalls: 0,
      varDecls: 0,
      looseEquality: 0,
      emptyCatch: 0,
      deepOptionalChain: 0,
      deepTernary: 0,
      emptyInterface: 0,
      printCalls: 0,
      bareExcept: 0,
      wildcardImport: 0,
      mutableDefaultArg: 0,
      globalKeyword: 0,
      tsIgnore: 0,
      eslintDisable: 0,
      mixedExports: 0,
    },
    stringLiterals: new Map(),
  };

  // Function stack while walking. The top is the active function;
  // metric increments target it. The stack lets nested functions
  // accumulate their own counts independently of their parents.
  const fnStack: FnRecord[] = [];

  // Mixed-exports detection state — populated from the top-level
  // statement scan in the walker.
  let hasDefaultExport = false;
  let namedExportCount = 0;

  function currentFn(): FnRecord | null {
    return fnStack.length > 0 ? fnStack[fnStack.length - 1] : null;
  }

  function recordFunction(node: Node): FnRecord {
    const span = lineSpan(node);
    const name = getFunctionName(node, grammar);
    const isAnonymous =
      kinds.anonymousFunction.has(node.type) && name === null;
    const fn: FnRecord = {
      node,
      name,
      isAnonymous,
      isAsync: false,
      hasAwait: false,
      startLine: span.startLine,
      endLine: span.endLine,
      totalLines: span.total,
      ownLines: span.total,
      cyclomatic: 1,
      cognitive: 0,
      maxNestingDepth: 0,
      paramCount: getParameterCount(node, grammar),
      booleanParamCount: 0,
      hasDocstring: false,
      calls: new Set(),
    };
    for (const c of node.children) {
      if (c && c.type === 'async') {
        fn.isAsync = true;
        break;
      }
    }
    const params =
      node.childForFieldName('parameters') ||
      node.childForFieldName('parameter') ||
      null;
    if (params) {
      for (const p of params.namedChildren) {
        if (!p) continue;
        if (isBooleanParam(p, grammar)) fn.booleanParamCount++;
        if (grammar === 'python' && isMutableDefaultPython(p)) {
          result.smellTokens.mutableDefaultArg++;
        }
      }
    }
    if (grammar === 'python') {
      const body = node.childForFieldName('body');
      if (body && body.namedChildCount > 0) {
        const first = body.namedChild(0);
        if (
          first &&
          first.type === 'expression_statement' &&
          first.namedChildCount > 0 &&
          first.namedChild(0)?.type === 'string'
        ) {
          fn.hasDocstring = true;
        }
      }
    }
    return fn;
  }

  // Pull the source path off an import-statement node. Field names
  // differ between grammars and even between Python's two import
  // statement kinds — handle each case explicitly so `from x import y`
  // imports aren't silently dropped (the previous version treated
  // Python's `name` field as the source for both forms, which only
  // worked for plain `import x`).
  function importSourceText(node: Node, t: string): string | null {
    if (grammar === 'python') {
      if (t === 'import_from_statement') {
        const mod = node.childForFieldName('module_name');
        return mod?.text ?? null;
      }
      // import_statement: `import a.b.c[, d.e]`
      const name = node.childForFieldName('name');
      return name?.text ?? null;
    }
    // TS/JS: import_statement with a `source` field.
    const src = node.childForFieldName('source');
    if (!src) return null;
    return src.text.replace(/^['"`]|['"`]$/g, '');
  }

  // ---------- AST-based smell detection ----------
  //
  // Runs unconditionally for every node, regardless of whether we're
  // inside a function. The previous implementation gated this behind
  // `if (currentFn()) { ...; return; }`, which meant any code inside a
  // function body — i.e., nearly all real code — silently bypassed
  // every smell check. Calling this separately from the function-
  // context complexity logic fixes that.
  function detectAstSmells(node: Node, t: string): void {
    if (isTs && t === 'predefined_type') {
      if (node.text === 'any') result.smellTokens.anyType++;
    }
    if (t === 'as_expression' || t === 'type_assertion') {
      result.smellTokens.typeAssertion++;
    }
    if (t === 'non_null_expression') {
      result.smellTokens.nonNullAssertion++;
    }
    if (t === 'debugger_statement') {
      result.smellTokens.debuggerStmt++;
    }
    if (t === 'variable_declaration') {
      // var keyword (let/const → lexical_declaration).
      result.smellTokens.varDecls++;
    }
    if (t === 'binary_expression') {
      for (const c of node.children) {
        if (c && (c.type === '==' || c.type === '!=')) {
          result.smellTokens.looseEquality++;
          break;
        }
      }
    }
    if (t === 'catch_clause') {
      const body =
        node.childForFieldName('body') ||
        node.namedChildren.find((c) => c?.type === 'statement_block');
      if (body && body.namedChildCount === 0) {
        result.smellTokens.emptyCatch++;
      }
    }
    if (grammar === 'python' && t === 'except_clause') {
      // Bare except: only the `except` keyword + `:` + block as
      // children, no exception type.
      let hasType = false;
      for (const c of node.children) {
        if (!c) continue;
        const ct = c.type;
        if (
          ct !== 'except' &&
          ct !== ':' &&
          ct !== 'block' &&
          ct !== 'comment'
        ) {
          hasType = true;
          break;
        }
      }
      if (!hasType) result.smellTokens.bareExcept++;
    }
    if (grammar === 'python' && t === 'global_statement') {
      result.smellTokens.globalKeyword++;
    }
    if (
      isJsFamily &&
      (t === 'member_expression' || t === 'subscript_expression' || t === 'call_expression')
    ) {
      const depth = countOptionalChainDepth(node);
      if (depth > 4) result.smellTokens.deepOptionalChain++;
    }
    if (kinds.ternary.has(t)) {
      const depth = countTernaryDepth(node, kinds);
      if (depth >= 3) result.smellTokens.deepTernary++;
    }
  }

  function walk(node: Node, nesting: number): void {
    const t = node.type;

    // ----- Comment handling: detect smell tokens; no descent -----
    if (kinds.comment.has(t)) {
      const text = node.text;
      if (/@ts-(?:ignore|expect-error)\b/.test(text)) {
        result.smellTokens.tsIgnore++;
      }
      if (/\beslint-disable(?:-next-line|-line)?\b/.test(text)) {
        result.smellTokens.eslintDisable++;
      }
      return;
    }

    // ----- Function entry: push a record, reset nesting for body -----
    let pushedFn = false;
    if (kinds.function.has(t)) {
      const fn = recordFunction(node);
      fnStack.push(fn);
      result.functions.push(fn);
      const parent = fnStack.length > 1 ? fnStack[fnStack.length - 2] : null;
      if (parent) parent.ownLines -= fn.totalLines;
      pushedFn = true;
      // Sonar's spec: nesting resets at each function boundary.
      nesting = 0;
    }

    // ----- File-level structure -----
    if (kinds.class.has(t)) {
      result.classCount++;
    } else if (kinds.interface.has(t)) {
      result.interfaceCount++;
      const body =
        node.childForFieldName('body') ||
        node.namedChildren.find((c) => c?.type === 'object_type') ||
        null;
      if (body && body.namedChildCount === 0) {
        result.smellTokens.emptyInterface++;
      }
    }
    if (kinds.import.has(t)) {
      const src = importSourceText(node, t);
      if (src) result.imports.push(src);
      if (grammar === 'python' && t === 'import_from_statement') {
        for (const c of node.children) {
          if (c && c.type === 'wildcard_import') {
            result.smellTokens.wildcardImport++;
            break;
          }
        }
      }
    }
    if (kinds.string.has(t)) {
      const raw = node.text;
      const trimmed = raw.replace(/^['"`]|['"`]$/g, '');
      if (trimmed.length >= 4 && trimmed.length <= 200 && /\S/.test(trimmed)) {
        result.stringLiterals.set(
          trimmed,
          (result.stringLiterals.get(trimmed) ?? 0) + 1,
        );
      }
    }

    // ----- AST smell detection (runs for every node) -----
    detectAstSmells(node, t);

    // ----- Top-level export tracking for mixed-exports smell -----
    if (
      isJsFamily &&
      node.parent &&
      node.parent.type === 'program' &&
      t === 'export_statement'
    ) {
      const isDefault = node.children.some((c) => c?.type === 'default');
      if (isDefault) hasDefaultExport = true;
      else namedExportCount++;
    }

    // ----- Function-context complexity tracking + call graph -----
    let pushedNesting = false;
    const fn = currentFn();
    if (fn) {
      let cyclomaticAdd = 0;
      let cognitiveAdd = 0;

      if (kinds.branch.has(t)) {
        cyclomaticAdd = 1;
        cognitiveAdd = 1 + nesting;
      }
      if (kinds.nesting.has(t)) {
        pushedNesting = true;
        const newDepth = nesting + 1;
        if (newDepth > fn.maxNestingDepth) fn.maxNestingDepth = newDepth;
      }
      const op = isShortCircuitOperator(node, grammar);
      if (op) {
        cyclomaticAdd += 1;
        const parent = node.parent;
        const parentOp = parent ? isShortCircuitOperator(parent, grammar) : null;
        if (parentOp !== op) cognitiveAdd += 1;
      }
      if (t === 'await_expression' || t === 'await') fn.hasAwait = true;
      if (kinds.call.has(t)) {
        const callee = node.childForFieldName('function') || node.namedChild(0);
        if (callee) {
          const calleeText = callee.text;
          if (calleeText.startsWith('console.') && isJsFamily) {
            result.smellTokens.consoleCalls++;
          }
          if (calleeText === 'eval' || calleeText === 'Function') {
            result.smellTokens.evalCalls++;
          }
          if (grammar === 'python' && calleeText === 'print') {
            result.smellTokens.printCalls++;
          }
          const leafName = leafIdentifier(callee);
          if (leafName) fn.calls.add(leafName);
        }
      }
      fn.cyclomatic += cyclomaticAdd;
      fn.cognitive += cognitiveAdd;
    } else if (kinds.call.has(t)) {
      // File-level call (e.g., a top-level console.log or eval). Still
      // a real smell — track it without a fn context.
      const callee = node.childForFieldName('function') || node.namedChild(0);
      if (callee) {
        const calleeText = callee.text;
        if (calleeText.startsWith('console.') && isJsFamily) {
          result.smellTokens.consoleCalls++;
        }
        if (calleeText === 'eval' || calleeText === 'Function') {
          result.smellTokens.evalCalls++;
        }
        if (grammar === 'python' && calleeText === 'print') {
          result.smellTokens.printCalls++;
        }
      }
    }

    // ----- Recurse into children -----
    for (const c of node.namedChildren) {
      if (c) walk(c, pushedNesting ? nesting + 1 : nesting);
    }

    // ----- Pop function stack -----
    if (pushedFn) fnStack.pop();
  }

  walk(root, 0);

  if (hasDefaultExport && namedExportCount >= 5) {
    result.smellTokens.mixedExports = 1;
  }

  // Reserved for future passes (e.g., reading raw text by byte range).
  void source;

  return result;
}

// Get the leaf identifier from an expression like
// `foo.bar.baz(...)` -> `baz`, `qux(...)` -> `qux`.
function leafIdentifier(node: Node): string | null {
  let cur: Node | null = node;
  while (cur) {
    if (cur.type === 'identifier' || cur.type === 'property_identifier') {
      return cur.text;
    }
    if (cur.type === 'member_expression') {
      const prop = cur.childForFieldName('property');
      if (prop) return prop.text;
    }
    cur = cur.namedChild(cur.namedChildCount - 1);
  }
  return null;
}
