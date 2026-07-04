import type { Node } from 'web-tree-sitter';

// Generic AST helpers shared by the walker's visitors and smell detectors.
// These are plain tree-sitter accessors — not smell detection — so they live
// apart from `smells.ts` to keep that module's surface honest.

// Strip the surrounding quote characters from a tree-sitter string /
// import-specifier node's `.text`. Backtick-aware on purpose: an ordinary
// '…' / "…" string and a template-literal specifier (`import(`./m`)`) all
// carry their delimiters in `.text`, and the import/dead-code passes want the
// bare module path. Anchored to the first and last char only, so interior
// quotes are left untouched. Single source for this (subtle) edge-strip.
export function stripStringQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '');
}

// Strings inside import specifiers aren't "magic strings" — a
// shared module path like './api' isn't a duplicated literal,
// it's just the module being referenced. Without this skip,
// every multi-importer of the same module trips the smell.
export function isImportSpecifierString(node: Node): boolean {
  const parentType = node.parent?.type ?? '';
  return (
    parentType === 'import_statement' ||
    parentType === 'import_from_statement' ||
    parentType === 'export_statement'
  );
}

// `console.log/debug/info/trace` are debug noise and worth flagging.
// `console.error/warn` are routine production logging on most code
// bases, so flagging them produces too much noise to be useful.
const CONSOLE_NOISE = new Set([
  'console.log',
  'console.debug',
  'console.info',
  'console.trace',
  'console.dir',
  'console.table',
]);
export function isConsoleLogish(calleeText: string): boolean {
  return CONSOLE_NOISE.has(calleeText);
}

// Count the number of named bindings introduced by a top-level
// `export_statement`. The previous mixed-exports smell counted
// statements, which meant `export { a, b, c, d, e, f }` (a single
// statement that exports 6 names) never tripped the threshold while
// six separate `export const X = ...` lines did. Walking into the
// statement gives the count users intuitively expect.
export function countExportBindings(node: Node): number {
  let count = 0;
  for (const c of node.namedChildren) {
    if (!c) continue;
    const ct = c.type;
    if (ct === 'export_clause') {
      // `export { a, b as c, d }` — one binding per export_specifier.
      for (const spec of c.namedChildren) {
        if (spec && spec.type === 'export_specifier') count++;
      }
    } else if (
      ct === 'lexical_declaration' ||
      ct === 'variable_declaration'
    ) {
      // `export const a = 1, b = 2;` — count variable_declarators.
      for (const decl of c.namedChildren) {
        if (decl && decl.type === 'variable_declarator') count++;
      }
    } else if (
      ct === 'function_declaration' ||
      ct === 'generator_function_declaration' ||
      ct === 'class_declaration' ||
      ct === 'interface_declaration' ||
      ct === 'type_alias_declaration' ||
      ct === 'enum_declaration' ||
      ct === 'module' ||
      ct === 'namespace_declaration'
    ) {
      count++;
    }
  }
  // `export * from '...'` and re-exports without an export_clause
  // don't add a known number of bindings; treat as 1 to keep the
  // statement-count semantics for those edge cases.
  return count > 0 ? count : 1;
}

// Get the leaf identifier from an expression like
// `foo.bar.baz(...)` -> `baz`, `qux(...)` -> `qux`.
export function leafIdentifier(node: Node): string | null {
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
