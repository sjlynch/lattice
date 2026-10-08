// A CLAUDE.md that names a file which no longer exists sends the next agent
// looking for code that moved — and refactors here are done by agents that
// rarely re-read every doc. A one-pass audit found stale pointers left by
// module moves (a deleted facade, an `x/index.ts` folded into `x.ts`, a
// script in the wrong folder). This fails on a backtick-quoted file path in a
// CLAUDE.md that matches no repo file. Matching is deliberately lenient:
// leading `./`/`../` are dropped and the rest may be any suffix of a repo path
// (`sidebar/hooks/x.ts`), a `.js` specifier also matches its `.ts`/`.tsx`
// source, and a name the code itself writes at runtime (`LATTICE_TASK.md`,
// `tasks.json` — it appears in a non-doc source file) counts as real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAgentDoc, listRepoFiles, readRepoFile } from './helpers/repoFiles.js';

const PATHLIKE = /^[\w@][\w@./-]*\.(?:ts|tsx|mts|mjs|cjs|js|json|md)$/;
const SOURCE = /\.(?:ts|tsx|mts|mjs|cjs|js|md)$/;

test('every file path a CLAUDE.md names exists (or is a name the code writes)', () => {
  const files = listRepoFiles();
  const known = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 0; i < parts.length; i++) known.add(parts.slice(i).join('/'));
  }
  const corpus = files
    .filter((f) => SOURCE.test(f) && !/(^|\/)(CLAUDE|AGENTS)\.md$/.test(f))
    .map(readRepoFile)
    .join('\n');

  const stale: string[] = [];
  for (const doc of files.filter(isAgentDoc)) {
    const seen = new Set<string>();
    for (const m of readRepoFile(doc).matchAll(/`([^`\s]+)`/g)) {
      const raw = m[1];
      if (raw.includes('...') || raw.includes('<')) continue;
      const tok = raw.replace(/^(?:\.\.?\/)+/, '');
      if (!PATHLIKE.test(tok) || seen.has(tok)) continue;
      seen.add(tok);
      const candidates = [tok, tok.replace(/\.js$/, '.ts'), tok.replace(/\.js$/, '.tsx')];
      if (candidates.some((c) => known.has(c))) continue;
      if (corpus.includes(tok)) continue;
      stale.push(`${doc}: \`${raw}\``);
    }
  }
  assert.deepEqual(stale.sort(), [], 'fix the doc to name the file where it lives now (or drop the reference)');
});
