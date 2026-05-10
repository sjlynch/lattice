// Per-language tables that map our generic categories ("this is a
// function", "this is a branch") to the actual node type strings used
// by each tree-sitter grammar. The metrics walker stays
// language-agnostic — it asks `isFunction(node, lang)` etc. rather
// than embedding grammar-specific node names directly.

import type { GrammarKey } from '../parser.js';
import { buildTsLikeNodeKinds } from './typescript.js';
import { buildPythonNodeKinds } from './python.js';
import { buildGoNodeKinds } from './go.js';
import { buildRustNodeKinds } from './rust.js';
import { buildJavaNodeKinds } from './java.js';
import { buildCsharpNodeKinds } from './csharp.js';
import { buildRubyNodeKinds } from './ruby.js';

export type NodeKinds = {
  // Function-like nodes (anything we treat as its own scope)
  function: Set<string>;
  // Named declarations only — used for the `high_function_count`
  // smell threshold so files full of inline arrow callbacks don't
  // flag falsely
  namedFunction: Set<string>;
  // Anonymous function-likes — tracked separately for the call graph
  // and own-body length calculation
  anonymousFunction: Set<string>;
  // Class-like
  class: Set<string>;
  // Interface (TS/TSX only) — empty in other grammars
  interface: Set<string>;
  // Import statement nodes
  import: Set<string>;
  // Nodes that contribute +1 to cyclomatic complexity (McCabe). One
  // per distinct independent path, so each switch case counts.
  branch: Set<string>;
  // Nodes that contribute +1+nesting to cognitive complexity (Sonar
  // B1). Diverges from `branch` on switch: the switch_statement
  // itself dispatches once with the nesting penalty; individual
  // switch_case / switch_default labels do NOT add cognitive load
  // because Sonar treats them as continuations, not new decisions.
  // Treating each case as +1+nesting (the previous behavior) made
  // dispatch tables look 5–10× more cognitively complex than they
  // really are, blowing past the high_cognitive_complexity threshold
  // for routine code.
  cognitiveBranch: Set<string>;
  // Subset of branches that introduce nesting depth
  nesting: Set<string>;
  // Ternary expression node (counted as a branch and as a smell when
  // chained 3+ deep)
  ternary: Set<string>;
  // Catch clause / except clause
  catchClause: Set<string>;
  // Call expression node
  call: Set<string>;
  // String literal nodes (template/regular)
  string: Set<string>;
  // Comment node
  comment: Set<string>;
  // Field name on an import statement holding the source string
  importSourceField: string;
};

function buildNodeKinds(grammar: GrammarKey): NodeKinds {
  if (grammar === 'python') return buildPythonNodeKinds();
  if (grammar === 'go') return buildGoNodeKinds();
  if (grammar === 'rust') return buildRustNodeKinds();
  if (grammar === 'java') return buildJavaNodeKinds();
  if (grammar === 'csharp') return buildCsharpNodeKinds();
  if (grammar === 'ruby') return buildRubyNodeKinds();
  // typescript / tsx / javascript share a near-identical set; the only
  // grammar-specific bit is `interface_declaration`, which isn't part
  // of plain JavaScript.
  return buildTsLikeNodeKinds(grammar);
}

const cache = new Map<GrammarKey, NodeKinds>();

export function nodeKindsFor(grammar: GrammarKey): NodeKinds {
  let nk = cache.get(grammar);
  if (!nk) {
    nk = buildNodeKinds(grammar);
    cache.set(grammar, nk);
  }
  return nk;
}
