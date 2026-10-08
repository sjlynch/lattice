// Every CLAUDE.md is read by an agent before it touches the code beside it, so a
// doc's size is paid on every visit. They are maps + invariants + pointers;
// incident stories and rationale essays belong in commit messages and code
// comments. The root CLAUDE.md is auto-loaded into EVERY agent session (task
// worktrees, resolvers, workflow steps): it was trimmed 76 KB → 37 KB and
// re-accreted within a week, then cut to an index again. The folder docs had
// grown to 104 files / 826 KB, 24 of them over 12 KB (worktree/ was 34 KB),
// before they were cut back to this budget. If this fails, move detail DOWN
// into the CLAUDE.md of the subfolder it describes (or a code comment) — do not
// raise a budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAgentDoc, listRepoFiles, readRepoFile } from './helpers/repoFiles.js';

const DEFAULT_BUDGET = 12_000;
// Indexes: the auto-loaded root and the two package maps.
const BUDGETS: Record<string, number> = {
  'CLAUDE.md': 20_000,
  'backend/src/CLAUDE.md': 20_000,
  'frontend/src/CLAUDE.md': 20_000,
};

test('every CLAUDE.md stays within its size budget (LF-normalized bytes)', () => {
  const docs = listRepoFiles().filter(isAgentDoc);
  assert.ok(docs.length > 50, `expected the repo's CLAUDE.md corpus, found ${docs.length}`);
  const over = docs
    .map((rel) => {
      const bytes = Buffer.byteLength(readRepoFile(rel).replace(/\r\n/g, '\n'));
      return { rel, bytes, budget: BUDGETS[rel] ?? DEFAULT_BUDGET };
    })
    .filter((d) => d.bytes > d.budget)
    .map((d) => `${d.rel}: ${d.bytes} bytes (budget ${d.budget})`)
    .sort();
  assert.deepEqual(over, [], 'move detail into the CLAUDE.md of the subfolder it describes; do not raise the budget');
});
