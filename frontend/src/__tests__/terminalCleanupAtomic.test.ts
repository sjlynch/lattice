import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TerminalSpec } from '../terminal/terminalTypes';
import {
  planCloseTerminals,
  removeTerminalFromList,
  terminalIdsForTask,
} from '../terminal/terminalState.ts';

function term(
  id: string,
  taskId: string | undefined,
  serverId: string,
): TerminalSpec {
  return { id, taskId, serverId, label: id, cwd: `/wt/${id}` };
}

// Two terminals share a taskId (the worktree-agent pty + its conflict
// resolver, say); a third belongs to a different task. The shared scenario
// from useTaskTerminalCleanup, which fires closeTerminalsForTask on a
// qa/done/deleted transition.
function fixture(): TerminalSpec[] {
  return [
    term('a', 't1', 'sa'),
    term('b', 't1', 'sb'),
    term('c', 't2', 'sc'),
  ];
}

test('terminalIdsForTask collects every terminal sharing the task id', () => {
  assert.deepEqual(terminalIdsForTask(fixture(), 't1'), ['a', 'b']);
  assert.deepEqual(terminalIdsForTask(fixture(), 't2'), ['c']);
  assert.deepEqual(terminalIdsForTask(fixture(), 'nope'), []);
});

test('closeTerminalsForTask plan removes ALL matching terminals atomically and deletes each serverId exactly once', () => {
  const terminals = fixture();

  // This mirrors what closeTerminalsForTask now does: collect the ids, then
  // hand them to the batched close (planCloseTerminals) which computes the
  // post-close list + the serverId DELETEs from a SINGLE snapshot.
  const ids = terminalIdsForTask(terminals, 't1');
  const { serverIdsToDelete, next } = planCloseTerminals(terminals, new Set(ids));

  // Both task-t1 terminals are gone; the unrelated t2 terminal survives.
  assert.deepEqual(
    next.map((t) => t.id),
    ['c'],
    'both terminals for the task are removed in one pass — neither resurrected',
  );

  // Each backend session is DELETEd exactly once (no duplicate, no miss).
  assert.deepEqual(serverIdsToDelete, ['sa', 'sb']);
  assert.equal(
    new Set(serverIdsToDelete).size,
    serverIdsToDelete.length,
    'no serverId is deleted twice',
  );
});

test('regression: the old per-id close loop resurrected a sibling tab; the batched close does not', () => {
  const prev = fixture();
  const ids = terminalIdsForTask(prev, 't1'); // ['a', 'b']

  // Reproduce the OLD bug: closeTerminalsForTask looped closeTerminal(id),
  // and each closeTerminal re-read the SAME stale snapshot (terminalsRef only
  // syncs in an effect after render, never mid-loop) and called setTerminals
  // with that snapshot minus just its own id. The last write therefore won —
  // removing only 'b' and leaving 'a' (already "closed") back in the list.
  let oldFinal = prev;
  for (const id of ids) {
    oldFinal = removeTerminalFromList(prev, id); // NOTE: prev, not oldFinal
  }
  assert.deepEqual(
    oldFinal.map((t) => t.id),
    ['a', 'c'],
    'documents the bug: terminal "a" is resurrected by the stale-snapshot loop',
  );

  // The new atomic path removes both from one snapshot — no resurrection.
  const { next } = planCloseTerminals(prev, new Set(ids));
  assert.deepEqual(next.map((t) => t.id), ['c']);
});

test('planCloseTerminals dedupes the DELETE even if an id is passed twice', () => {
  const terminals = fixture();
  // The old closeTerminals iterated the raw ids array, so a duplicated id
  // fired two DELETEs for one session — which on Windows crashed node-pty's
  // helper. planCloseTerminals walks the terminal list once, keyed by the id
  // set, so each live session contributes at most one DELETE.
  const { serverIdsToDelete } = planCloseTerminals(
    terminals,
    new Set(['a', 'a', 'b']),
  );
  assert.deepEqual(serverIdsToDelete, ['sa', 'sb']);
});
