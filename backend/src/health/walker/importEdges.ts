import type { Node } from 'web-tree-sitter';
import { stripStringQuotes } from './astUtils.js';
import type { WalkerContext } from './context.js';

// Import-edge extraction for the health walker. Every edge the cross-file
// dead-code reachability pass depends on is captured here — TS/JS import
// sources, `export … from` re-exports, and string-literal dynamic
// `import()`/`require()`, plus Python's two import statement shapes and the
// wildcard-import smell that only rides an import node. Pulling this out of the
// smell/complexity visitors keeps those focused on metrics and gives the
// resolver-accuracy notes in ../crossFile/ one module to trace "which edges
// does the walker actually see".

// Import-statement edges (`import x from './m'`, Python `import a.b` /
// `from m import x`). Also counts Python wildcard imports (`from m import *`)
// as a smell, since the `wildcard_import` node only appears on an
// import_from_statement.
export function handleImportStatement(
  ctx: WalkerContext,
  node: Node,
  t: string,
): void {
  if (!ctx.kinds.import.has(t)) return;

  const src = importSourceText(ctx, node, t);
  if (src) ctx.result.imports.push(src);

  if (ctx.grammar === 'python' && t === 'import_from_statement') {
    for (const c of node.children) {
      if (c && c.type === 'wildcard_import') {
        ctx.result.smellTokens.wildcardImport++;
        break;
      }
    }
  }
}

// Re-exports (`export { x } from './m'`, `export * from './m'`) are import edges
// for reachability purposes — the file pulls in `./m`. The plain import visitor
// doesn't see them (they're export_statements), so capture the source here.
// Without this, files reached only through a barrel index look orphaned to the
// dead-code pass. (Export *binding* counting for the mixed-exports smell stays
// with the export visitor — that's a smell signal, not an edge.)
export function handleReExportEdge(ctx: WalkerContext, node: Node): void {
  const source = node.childForFieldName('source');
  if (!source) return;
  const spec = stripStringQuotes(source.text);
  if (spec) ctx.result.imports.push(spec);
}

// Dynamic imports / requires (`import('./m')`, `require('./m')`) with a
// string-literal specifier are real import edges — capture them for the
// dead-code reachability pass so lazily-loaded route components aren't
// mistaken for orphans. Only string literals are resolvable; computed
// specifiers (`import(path)`) are left to the "uncertain" bucket. `calleeText`
// is passed in so the call visitor doesn't have to re-derive the callee.
export function handleDynamicImportEdge(
  ctx: WalkerContext,
  node: Node,
  calleeText: string,
): void {
  if (!ctx.isJsFamily || (calleeText !== 'import' && calleeText !== 'require')) {
    return;
  }
  const args = node.childForFieldName('arguments');
  const first = args?.namedChild(0);
  if (first && first.type === 'string') {
    const spec = stripStringQuotes(first.text);
    if (spec) ctx.result.imports.push(spec);
  }
}

// Pull the source path off an import-statement node. Field names differ between
// grammars and even between Python's two import statement kinds.
function importSourceText(
  ctx: WalkerContext,
  node: Node,
  t: string,
): string | null {
  if (ctx.grammar === 'python') {
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
  return stripStringQuotes(src.text);
}
