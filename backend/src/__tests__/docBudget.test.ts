// Every CLAUDE.md is auto-loaded: Claude Code injects the root one into EVERY
// agent session (task worktrees, resolvers, workflow steps) and lazily adds
// each CLAUDE.md on the path from the root to any file it reads. So a doc's
// size is paid on every visit to anything beneath it, and the indexes most of
// all: in 2026-10 the auto-loaded text averaged ~46 KB per code folder, mostly
// the root (18 KB) plus module maps in backend/src (20 KB) and
// frontend/src/components (11 KB) that most sessions never needed. Hence the
// tight index budgets: an auto-loaded CLAUDE.md holds only rules for everything
// beneath it + pointers; navigation maps go in an on-demand MAP.md beside it,
// cross-cutting architecture in docs/*.md (read only when opened, so they get
// a looser budget). Incident stories and rationale essays belong in commit
// messages and code comments. History: the root was trimmed 76 KB → 37 KB and
// re-accreted within a week; the folder docs grew to 104 files / 826 KB before
// being cut to 12 KB each. If this fails, move detail DOWN into the CLAUDE.md
// of the subfolder it describes, a MAP.md, a docs/ file or a code comment — do
// not raise a budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAgentDoc, isOnDemandDoc, listRepoFiles, readRepoFile } from './helpers/repoFiles.js';

const DEFAULT_BUDGET = 12_000;
const ON_DEMAND_BUDGET = 20_000;
// Auto-loaded indexes: the root (every session) and the package / components
// indexes (every visit to any file beneath them).
const BUDGETS: Record<string, number> = {
  'CLAUDE.md': 9_000,
  'backend/src/CLAUDE.md': 5_000,
  'frontend/src/CLAUDE.md': 5_000,
  'frontend/src/components/CLAUDE.md': 5_000,
};

const lfBytes = (rel: string): number => Buffer.byteLength(readRepoFile(rel).replace(/\r\n/g, '\n'));

test('every CLAUDE.md stays within its size budget (LF-normalized bytes)', () => {
  const docs = listRepoFiles().filter(isAgentDoc);
  assert.ok(docs.length > 50, `expected the repo's CLAUDE.md corpus, found ${docs.length}`);
  const over = docs
    .map((rel) => ({ rel, bytes: lfBytes(rel), budget: BUDGETS[rel] ?? DEFAULT_BUDGET }))
    .filter((d) => d.bytes > d.budget)
    .map((d) => `${d.rel}: ${d.bytes} bytes (budget ${d.budget})`)
    .sort();
  assert.deepEqual(
    over,
    [],
    'move navigation into a MAP.md and detail into the CLAUDE.md of the subfolder it describes; do not raise the budget',
  );
});

test('every MAP.md and docs/*.md stays within its size budget (LF-normalized bytes)', () => {
  const docs = listRepoFiles().filter(isOnDemandDoc);
  assert.ok(docs.length > 0, 'expected at least one MAP.md / docs/*.md');
  const over = docs
    .map((rel) => ({ rel, bytes: lfBytes(rel) }))
    .filter((d) => d.bytes > ON_DEMAND_BUDGET)
    .map((d) => `${d.rel}: ${d.bytes} bytes (budget ${ON_DEMAND_BUDGET})`)
    .sort();
  assert.deepEqual(over, [], 'split the doc by area or move detail into the owning CLAUDE.md; do not raise the budget');
});
