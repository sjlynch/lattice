// Per-language tables that map our generic categories ("this is a
// function", "this is a branch") to the actual node type strings used
// by each tree-sitter grammar. The metrics walker stays
// language-agnostic — it asks `isFunction(node, lang)` etc. rather
// than embedding grammar-specific node names directly.

import type { GrammarKey } from '../parser.js';
import type { NodeKinds } from './base.js';
import { buildTsLikeNodeKinds } from './typescript.js';
import { buildPythonNodeKinds } from './python.js';
import { buildGoNodeKinds } from './go.js';
import { buildRustNodeKinds } from './rust.js';
import { buildJavaNodeKinds } from './java.js';
import { buildCsharpNodeKinds } from './csharp.js';
import { buildRubyNodeKinds } from './ruby.js';

export type { NodeKindSets, NodeKinds } from './base.js';

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
