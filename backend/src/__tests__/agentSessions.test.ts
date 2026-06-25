import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerAgentSession,
  touchAgentSession,
  unregisterAgentSession,
  listAgentSessions,
} from '../agentSessions.js';

// Regression for: lifecycle agent-session graph nodes (push / QA / workflow
// step / post-merge) were force-expired at the 30-min absolute cap while still
// alive and active. The sweep used to reap on `startedAt < ageCutoff`
// regardless of recent activity; lifecycle sessions register WITHOUT an idle
// TTL, so a session running longer than 30 min lost its orange node mid-run.
// The fix: (1) routes/agentActivity.ts touches the session on every activity
// event, and (2) the sweep's absolute backstop now keys off `lastSeen`
// (silence) instead of `startedAt` (age).
//
// A single self-contained test keeps the module-level sweep interval from
// leaking across tests: it drains to empty (which self-clears the timer) before
// resetting the mocked clock.
test('lifecycle session survives past the 30-min cap while active, then is reaped once silent', () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'] });
  try {
    const project = '/lattice-agentsessions-sweep-test';
    const agentId = 'wf:sweep-test:0';
    // No idleTtlMs → only the absolute MAX_AGE_MS (30 min) backstop applies,
    // exactly as the push/QA/workflow/post-merge registration sites do.
    registerAgentSession({ agentId, projectPath: project, label: 'workflow step' });

    // 45 active minutes, touched every 5 min the way the agent-activity hook
    // now does. The sweep fires each minute; an actively-touched session whose
    // `lastSeen` is never older than 5 min must never be reaped — even well
    // past the 30-min absolute cap that used to kill it.
    for (let minute = 1; minute <= 45; minute++) {
      mock.timers.tick(60 * 1000);
      if (minute % 5 === 0) {
        assert.equal(
          touchAgentSession(agentId),
          true,
          `touch at ${minute}m must still find the session`,
        );
      }
    }
    assert.ok(
      listAgentSessions(project).some((s) => s.agentId === agentId),
      'an actively-touched lifecycle session must survive past 30 min',
    );

    // Now it goes silent (the session died without firing its completion
    // callback): after MAX_AGE_MS of no activity the absolute backstop reaps it.
    mock.timers.tick(31 * 60 * 1000);
    assert.ok(
      !listAgentSessions(project).some((s) => s.agentId === agentId),
      'a now-silent lifecycle session must be reaped by the absolute backstop',
    );
  } finally {
    unregisterAgentSession('wf:sweep-test:0');
    mock.timers.reset();
  }
});

// touchAgentSession must not create presence — it only refreshes a session that
// is already registered. A no-op on an unknown id keeps the agent-activity
// route from resurrecting a node after its completion callback unregistered it.
test('touchAgentSession is a no-op for an unregistered session', () => {
  assert.equal(touchAgentSession('push:never-registered'), false);
  assert.equal(listAgentSessions('/lattice-agentsessions-touch-test').length, 0);
});
