import type { Node } from 'web-tree-sitter';
import { computeComplexityAdds, detectElseIf } from './complexity.js';
import { recordFunction } from './functionRecord.js';
import { detectAstSmells } from './smells.js';
import {
  countExportBindings,
  isConsoleLogish,
  isImportSpecifierString,
  leafIdentifier,
  stripStringQuotes,
} from './astUtils.js';
import {
  handleDynamicImportEdge,
  handleImportStatement,
  handleReExportEdge,
} from './importEdges.js';
import { currentFunction, type WalkerContext } from './context.js';

export function handleComment(ctx: WalkerContext, node: Node, t: string): boolean {
  if (!ctx.kinds.comment.has(t)) return false;

  const text = node.text;
  if (/@ts-(?:ignore|expect-error)\b/.test(text)) {
    ctx.result.smellTokens.tsIgnore++;
  }
  if (/\beslint-disable(?:-next-line|-line)?\b/.test(text)) {
    ctx.result.smellTokens.eslintDisable++;
  }
  return true;
}

export function handleFunctionEntry(
  ctx: WalkerContext,
  node: Node,
  t: string,
): boolean {
  if (!ctx.kinds.function.has(t)) return false;

  const parent = currentFunction(ctx);
  const fn = recordFunction(node, ctx.grammar, ctx.kinds, ctx.result.smellTokens);
  ctx.fnStack.push(fn);
  ctx.result.functions.push(fn);
  if (parent) parent.ownLines -= fn.totalLines;
  return true;
}

export function handleFunctionExit(ctx: WalkerContext, pushedFn: boolean): void {
  if (pushedFn) ctx.fnStack.pop();
}

export function handleFileStructure(
  ctx: WalkerContext,
  node: Node,
  t: string,
): void {
  if (ctx.kinds.class.has(t)) {
    ctx.result.classCount++;
    return;
  }

  if (!ctx.kinds.interface.has(t)) return;

  ctx.result.interfaceCount++;
  const body =
    node.childForFieldName('body') ||
    node.namedChildren.find((c) => c?.type === 'object_type') ||
    null;
  if (body && body.namedChildCount === 0) {
    ctx.result.smellTokens.emptyInterface++;
  }
}

export function handleImportsAndStrings(
  ctx: WalkerContext,
  node: Node,
  t: string,
): void {
  handleImportStatement(ctx, node, t);

  if (!ctx.kinds.string.has(t) || isImportSpecifierString(node)) return;

  const raw = node.text;
  const trimmed = stripStringQuotes(raw);
  if (trimmed.length >= 4 && trimmed.length <= 200 && /\S/.test(trimmed)) {
    ctx.result.stringLiterals.set(
      trimmed,
      (ctx.result.stringLiterals.get(trimmed) ?? 0) + 1,
    );
  }
}

export function handleAstSmells(
  ctx: WalkerContext,
  node: Node,
  t: string,
): void {
  detectAstSmells(
    node,
    t,
    ctx.result.smellTokens,
    ctx.kinds,
    ctx.grammar,
    ctx.isTs,
    ctx.isJsFamily,
  );
}

export function handleExportTracking(
  ctx: WalkerContext,
  node: Node,
  t: string,
): void {
  if (
    !ctx.isJsFamily ||
    !node.parent ||
    node.parent.type !== 'program' ||
    t !== 'export_statement'
  ) {
    return;
  }

  // Re-exports (`export { x } from './m'`) are import edges — capture the
  // source. Binding counting below stays here (it's a smell signal).
  handleReExportEdge(ctx, node);

  const isDefault = node.children.some((c) => c?.type === 'default');
  if (isDefault) ctx.exportState.hasDefaultExport = true;
  else ctx.exportState.namedExportCount += countExportBindings(node);
}

export function updateComplexity(
  ctx: WalkerContext,
  node: Node,
  t: string,
  nesting: number,
): boolean {
  const fn = currentFunction(ctx);
  if (!fn) return false;

  const isElseIf = detectElseIf(node, t, ctx.isJsFamily);
  const { cyclomaticAdd, cognitiveAdd, opensNesting } = computeComplexityAdds(
    node,
    ctx.kinds,
    ctx.grammar,
    nesting,
    isElseIf,
  );

  if (opensNesting) {
    const newDepth = nesting + 1;
    if (newDepth > fn.maxNestingDepth) fn.maxNestingDepth = newDepth;
  }
  fn.cyclomatic += cyclomaticAdd;
  fn.cognitive += cognitiveAdd;

  return opensNesting;
}

export function handleAwaitExpression(ctx: WalkerContext, t: string): void {
  const fn = currentFunction(ctx);
  if (fn && (t === 'await_expression' || t === 'await')) fn.hasAwait = true;
}

export function handleCallExpression(
  ctx: WalkerContext,
  node: Node,
  t: string,
): void {
  if (!ctx.kinds.call.has(t)) return;

  const callee = node.childForFieldName('function') || node.namedChild(0);
  if (!callee) return;

  const calleeText = callee.text;

  handleDynamicImportEdge(ctx, node, calleeText);

  if (ctx.isJsFamily && isConsoleLogish(calleeText)) {
    ctx.result.smellTokens.consoleCalls++;
  }
  if (calleeText === 'eval' || calleeText === 'Function') {
    ctx.result.smellTokens.evalCalls++;
  }
  if (ctx.grammar === 'python' && calleeText === 'print') {
    ctx.result.smellTokens.printCalls++;
  }

  const fn = currentFunction(ctx);
  if (!fn) return;

  const leafName = leafIdentifier(callee);
  if (leafName) fn.calls.add(leafName);
}
