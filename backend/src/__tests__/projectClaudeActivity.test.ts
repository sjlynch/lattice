import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyProjectActivityEvent,
  endProjectSession,
} from '../projectClaude/lifecycle.js';
import {
  listAgentSessions,
  unregisterAgentSession,
} from '../agentSessions.js';

// Presence for project sessions (an agent in a terminal the user opened)
// follows the agent's TURNS, not the terminal's lifetime:
//   - a prompt / tool use / subagent event creates the node (and brings it back
//     after the idle TTL or a backend restart dropped it — it used to stay gone
//     for the rest of the session, since only SessionStart could create);
//   - Stop removes it after a grace (an agent that finished its turn used to
//     keep its node + last-file label for as long as the tab stayed open);
//   - SessionStart alone draws nothing (it used to put a bare dot on the graph
//     the moment a tab opened);
//   - SessionEnd removes it, and a hook arriving after SessionEnd (each hook is
//     an independent `curl -m 2`, so reordering is real) must not resurrect it.

const PROJECT = '/lattice-project-activity-resurrect-test';

function present(agentId: string): boolean {
  return listAgentSessions(PROJECT).some((s) => s.agentId === agentId);
}

function feed(event: string, sessionId: string, turnEndGraceMs?: number) {
  return applyProjectActivityEvent({
    event,
    sessionId,
    agentId: `claude:${sessionId}`,
    projectPath: PROJECT,
    label: 'claude',
    harness: 'codex',
    turnEndGraceMs,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a PostToolUse after SessionEnd does not resurrect the node', () => {
  const sid = 'resurrect-posttooluse';
  const agentId = `claude:${sid}`;
  try {
    feed('UserPromptSubmit', sid);
    assert.ok(present(agentId), 'a prompt creates the node');

    feed('SessionEnd', sid);
    assert.ok(!present(agentId), 'SessionEnd must remove the node');

    // Stray late hook (was in flight when SessionEnd landed).
    const r = feed('PostToolUse', sid);
    assert.equal(r.emitActivity, false, 'no beam for a gone session');
    assert.ok(!present(agentId), 'a post-SessionEnd PostToolUse must not resurrect');
  } finally {
    unregisterAgentSession(agentId);
  }
});

test('SessionStart alone draws no node; the first tool use does, tagged with its harness', () => {
  const sid = 'idle-tab';
  const agentId = `claude:${sid}`;
  try {
    assert.equal(feed('SessionStart', sid).emitActivity, false);
    assert.ok(!present(agentId), 'an idle, just-opened session shows nothing');

    assert.equal(feed('PreToolUse', sid).emitActivity, true);
    const session = listAgentSessions(PROJECT).find((s) => s.agentId === agentId);
    assert.equal(session?.harness, 'codex');
  } finally {
    unregisterAgentSession(agentId);
  }
});

test('a tool use brings back a node the idle TTL (or a restart) dropped', () => {
  const sid = 'expired-then-active';
  const agentId = `claude:${sid}`;
  try {
    feed('PreToolUse', sid);
    unregisterAgentSession(agentId); // what the idle sweep does
    assert.equal(feed('PostToolUse', sid).emitActivity, true);
    assert.ok(present(agentId), 'a working session gets its node back');
  } finally {
    unregisterAgentSession(agentId);
  }
});

test('Stop removes the node after the grace; activity inside the grace keeps it', async () => {
  const sid = 'turn-end';
  const agentId = `claude:${sid}`;
  try {
    feed('UserPromptSubmit', sid);
    feed('Stop', sid, 30);
    assert.ok(present(agentId), 'still shown during the grace');
    feed('PreToolUse', sid); // Claude's early Stop around a subagent
    await sleep(60);
    assert.ok(present(agentId), 'activity inside the grace cancelled the removal');

    feed('Stop', sid, 30);
    await sleep(60);
    assert.ok(!present(agentId), 'the node goes once the turn has really ended');

    // Not an ended session: its next turn brings the node back.
    feed('UserPromptSubmit', sid);
    assert.ok(present(agentId));
  } finally {
    unregisterAgentSession(agentId);
  }
});

test('a Stop for a session with no node is a no-op', () => {
  const sid = 'stop-only';
  assert.equal(feed('Stop', sid).emitActivity, false);
  assert.ok(!present(`claude:${sid}`));
});

test('endProjectSession (its terminal exited) removes the node and guards late hooks', () => {
  const sid = 'tab-killed';
  const agentId = `claude:${sid}`;
  try {
    feed('PreToolUse', sid);
    endProjectSession(sid);
    assert.ok(!present(agentId));
    feed('PostToolUse', sid);
    assert.ok(!present(agentId), 'an in-flight hook from the killed tab does not bring it back');
  } finally {
    unregisterAgentSession(agentId);
  }
});
