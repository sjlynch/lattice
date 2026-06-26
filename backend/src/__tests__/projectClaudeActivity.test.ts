import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyProjectActivityEvent } from '../routes/projectClaude.js';
import {
  listAgentSessions,
  unregisterAgentSession,
} from '../agentSessions.js';

// Regression for: the project-activity route resurrected a presence node after
// SessionEnd. It used to registerAgentSession (which CREATES the node) on every
// non-SessionEnd event, so a late PreToolUse/PostToolUse — or a reordered
// SessionStart — arriving after SessionEnd re-created a ghost orange node that
// then lingered for the full 5-min idle TTL. Each Claude hook is an independent
// `curl -m 2` with no ordering guarantee, so out-of-order delivery is real. The
// fix makes presence symmetric with routes/agentActivity.ts: only SessionStart
// creates; tool-use / subagent events are refresh-only (touchAgentSession, a
// no-op once gone); and a short recently-ended guard drops a reordered
// SessionStart too.

const PROJECT = '/lattice-project-activity-resurrect-test';

function present(agentId: string): boolean {
  return listAgentSessions(PROJECT).some((s) => s.agentId === agentId);
}

function feed(event: string, sessionId: string) {
  return applyProjectActivityEvent({
    event,
    sessionId,
    agentId: `claude:${sessionId}`,
    projectPath: PROJECT,
    label: 'claude',
  });
}

// The exact regression the task calls for: register → SessionEnd → late
// PostToolUse for the same id → node stays absent.
test('a PostToolUse after SessionEnd does not resurrect the node', () => {
  const sid = 'resurrect-posttooluse';
  const agentId = `claude:${sid}`;
  try {
    feed('SessionStart', sid);
    assert.ok(present(agentId), 'SessionStart must create the node');

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

// A reordered SessionStart (also a "stray late hook") must not bring it back
// either — touch-only alone wouldn't catch this; the recently-ended guard does.
test('a reordered SessionStart after SessionEnd does not resurrect the node', () => {
  const sid = 'resurrect-sessionstart';
  const agentId = `claude:${sid}`;
  try {
    feed('SessionStart', sid);
    feed('SessionEnd', sid);
    assert.ok(!present(agentId), 'SessionEnd must remove the node');

    feed('SessionStart', sid);
    assert.ok(!present(agentId), 'a SessionStart for an already-ended session must not resurrect');
  } finally {
    unregisterAgentSession(agentId);
  }
});

// Sanity: the happy path is unchanged — SessionStart creates, tool-use keeps it
// alive and emits a focus beam.
test('normal lifecycle still creates the node and emits activity', () => {
  const sid = 'happy-path';
  const agentId = `claude:${sid}`;
  try {
    assert.equal(feed('SessionStart', sid).emitActivity, false);
    assert.ok(present(agentId), 'SessionStart creates the node');

    const r = feed('PostToolUse', sid);
    assert.equal(r.emitActivity, true, 'tool-use on a live session emits a beam');
    assert.ok(present(agentId), 'tool-use keeps the node alive');

    feed('SessionEnd', sid);
    assert.ok(!present(agentId), 'SessionEnd removes the node');
  } finally {
    unregisterAgentSession(agentId);
  }
});

// A tool-use for a session that never had a SessionStart (its registration hook
// was lost) is a no-op — touch-only never creates a node out of thin air.
test('a tool-use with no prior SessionStart does not create a node', () => {
  const sid = 'never-started';
  const agentId = `claude:${sid}`;
  const r = feed('PostToolUse', sid);
  assert.equal(r.emitActivity, false);
  assert.ok(!present(agentId), 'no node without a SessionStart');
});
