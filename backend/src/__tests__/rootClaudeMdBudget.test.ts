// The root CLAUDE.md is auto-loaded into EVERY agent session — every task
// worktree, resolver and workflow step pays for it before reading any code. It
// is an index (layout, run/type-check, git discipline, the safety invariants,
// pointers); detail belongs in the CLAUDE.md beside the code it describes, and
// rationale/incident history in code comments. It was trimmed 76 KB → 37 KB and
// re-accreted within a week; it then carried a 12 KB exhaustive route table
// (now backend/src/routes/ROUTES.md). If this fails, move detail DOWN a level —
// do not raise the budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT_CLAUDE_MD = fileURLToPath(new URL('../../../CLAUDE.md', import.meta.url));
const BUDGET_BYTES = 20_000;

test('root CLAUDE.md stays an index (size budget)', () => {
  const bytes = Buffer.byteLength(fs.readFileSync(ROOT_CLAUDE_MD, 'utf8').replace(/\r\n/g, '\n'));
  assert.ok(
    bytes <= BUDGET_BYTES,
    `root CLAUDE.md is ${bytes} bytes (budget ${BUDGET_BYTES}); move detail into the owning subsystem CLAUDE.md`,
  );
});
