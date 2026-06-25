// tsconfig path-alias resolution + the relative-vs-bare specifier predicate the
// rest of the resolver shares.

import path from 'node:path';
import type { ParsedAlias } from '../../tsconfig.js';
import { tryAllExtensions } from './extensionCandidates.js';

export function isRelativeSpec(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('\\');
}

// Try the import against a tsconfig path-alias map. Aliases are pre-sorted
// longest-prefix-first in tsconfig.ts so the first match is the most specific.
export function resolveByAlias(
  spec: string,
  aliases: readonly ParsedAlias[],
  presentFiles: Set<string>,
): string | null {
  for (const alias of aliases) {
    let tail: string | null = null;
    if (alias.isWildcard) {
      if (alias.prefix === '') {
        // baseUrl catch-all (or a `"*"` path): applies to BARE specifiers
        // only. Relative imports resolve against the importing file, never
        // baseUrl — letting this match them would wrongly bind `./types` to
        // `<baseUrl>/types`.
        if (isRelativeSpec(spec)) continue;
        tail = spec;
      } else if (spec.startsWith(alias.prefix)) {
        tail = spec.slice(alias.prefix.length);
      }
    } else if (spec === alias.prefix) {
      tail = '';
    }
    if (tail === null) continue;

    for (const sub of alias.substitutions) {
      const target = tail ? path.join(sub, tail) : sub;
      const hit = tryAllExtensions(target, presentFiles);
      if (hit) return hit;
    }
  }
  return null;
}
