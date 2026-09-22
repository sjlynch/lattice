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

  if (ctx.grammar === 'python') {
    for (const spec of pythonImportSpecs(node, t)) ctx.result.imports.push(spec);
  } else {
    const src = importSourceText(node);
    if (src) ctx.result.imports.push(src);
  }

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

// TS/JS: the source path of an import_statement's `source` field.
function importSourceText(node: Node): string | null {
  const src = node.childForFieldName('source');
  if (!src) return null;
  return stripStringQuotes(src.text);
}

// The dotted module name of a Python `name` child: a bare `dotted_name`, or
// the `name` half of an `aliased_import` (`a.b as c` — its full text is not a
// module name).
function pythonDottedName(n: Node): string | null {
  if (n.type === 'aliased_import') return n.childForFieldName('name')?.text ?? null;
  if (n.type === 'dotted_name') return n.text;
  return null;
}

// Every module a Python import statement can pull in. Both statement kinds
// carry a REPEATED `name` field, and reading only the first one dropped edges:
//   - `import a.b, c.d as e` → `a.b`, `c.d` (was just `a.b`; `as` forms were
//     taken verbatim, `c.d as e`, which never resolves).
//   - `from pkg import mod, other` → `pkg` plus `pkg.mod` / `pkg.other`, and
//     `from . import views` → `.` plus `.views`: the imported names are very
//     often SUBMODULES, and with only the package recorded every module pulled
//     in that way (the common Django/Flask `from . import views` shape) read as
//     dead. A name that is really a function/class simply fails to resolve and
//     is dropped, so over-emitting is harmless.
function pythonImportSpecs(node: Node, t: string): string[] {
  const out: string[] = [];
  const names = node.childrenForFieldName('name').filter((n): n is Node => Boolean(n));
  if (t === 'import_from_statement') {
    const mod = node.childForFieldName('module_name')?.text;
    if (!mod) return out;
    out.push(mod);
    const joiner = /^\.+$/.test(mod) ? '' : '.';
    for (const n of names) {
      const name = pythonDottedName(n);
      if (name) out.push(`${mod}${joiner}${name}`);
    }
    return out;
  }
  for (const n of names) {
    const name = pythonDottedName(n);
    if (name) out.push(name);
  }
  return out;
}
