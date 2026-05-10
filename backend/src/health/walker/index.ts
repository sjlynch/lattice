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
import type { GrammarKey } from '../parser.js';
import { nodeKindsFor } from '../nodeKinds/index.js';
import { type FnRecord, recordFunction } from './functionRecord.js';
import { computeComplexityAdds, detectElseIf } from './complexity.js';
import {
  detectAstSmells,
  isConsoleLogish,
  countExportBindings,
  leafIdentifier,
  isImportSpecifierString,
} from './smells.js';

export type { FnRecord };

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
      const fn = recordFunction(node, grammar, kinds, result.smellTokens);
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
      if (!isImportSpecifierString(node)) {
        const raw = node.text;
        const trimmed = raw.replace(/^['"`]|['"`]$/g, '');
        if (trimmed.length >= 4 && trimmed.length <= 200 && /\S/.test(trimmed)) {
          result.stringLiterals.set(
            trimmed,
            (result.stringLiterals.get(trimmed) ?? 0) + 1,
          );
        }
      }
    }

    // ----- AST smell detection (runs for every node) -----
    detectAstSmells(node, t, result.smellTokens, kinds, grammar, isTs, isJsFamily);

    // ----- Top-level export tracking for mixed-exports smell -----
    if (
      isJsFamily &&
      node.parent &&
      node.parent.type === 'program' &&
      t === 'export_statement'
    ) {
      const isDefault = node.children.some((c) => c?.type === 'default');
      if (isDefault) hasDefaultExport = true;
      else namedExportCount += countExportBindings(node);
    }

    // ----- Function-context complexity tracking + call graph -----
    let pushedNesting = false;
    const fn = currentFn();
    const isElseIf = detectElseIf(node, t, isJsFamily);
    if (fn) {
      const { cyclomaticAdd, cognitiveAdd, opensNesting } = computeComplexityAdds(
        node,
        kinds,
        grammar,
        nesting,
        isElseIf,
      );
      if (opensNesting) {
        pushedNesting = true;
        const newDepth = nesting + 1;
        if (newDepth > fn.maxNestingDepth) fn.maxNestingDepth = newDepth;
      }
      if (t === 'await_expression' || t === 'await') fn.hasAwait = true;
      if (kinds.call.has(t)) {
        const callee = node.childForFieldName('function') || node.namedChild(0);
        if (callee) {
          const calleeText = callee.text;
          if (isJsFamily && isConsoleLogish(calleeText)) {
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
        if (isJsFamily && isConsoleLogish(calleeText)) {
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
