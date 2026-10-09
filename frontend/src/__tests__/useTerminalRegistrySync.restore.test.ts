// Restore acknowledgements vs registry WS events (`restoreTabs`): an `upsert`
// or `restored` event that beats the acknowledgement keeps the new pty mounted;
// a restore failure or removal before the acknowledgement stays authoritative
// (a failed tab never mounts a serverless pane); with no WS event the
// acknowledgement still marks genuinely queued tabs pending and supersedes an
// older list; a hello during restore protects new ptys and failures while the
// summary queues an unchanged stale pty; restores are single-flighted per
// project, yet an explicit retry still reaches the backend.
// Harness: useTerminalRegistrySync.fixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react-test-renderer';
import type { RestoreSummary } from '../api/types/terminalTabs';
import { harness, P, rec, spec, summary } from './useTerminalRegistrySync.fixture.ts';

for (const eventType of ['upsert', 'restored'] as const) {
  test(`a ${eventType} WS event before the restore acknowledgement keeps the new pty mounted`, async () => {
    const h = harness([spec({ id: 'a', serverId: 'srv_old', status: 'dead' })]);
    try {
      await h.answer(h.request('/api/terminal-tabs'), { tabs: [rec({ id: 'a', serverId: 'srv_old' })] });
      let restoring!: Promise<RestoreSummary | null>;
      act(() => { restoring = h.ctx.restoreTabs(); });
      h.emit({ type: 'upsert', projectPath: P, record: rec({ id: 'a', serverId: 'srv_new', label: 'new label' }) });
      if (eventType === 'restored') {
        h.emit({ type: 'restored', projectPath: P, mode: 'relaunched', record: rec({ id: 'a', serverId: 'srv_new', label: 'new label' }) });
      }
      act(() => { h.ctx.setStatus('a', 'live'); });
      const current = h.ctx.terminals[0];
      assert.equal(current?.relaunchNonce, 1);
      assert.deepEqual(h.mounts, ['srv_old', 'srv_new']);
      await h.answer(h.request('/api/terminal-tabs/restore'), summary(['a']));
      await restoring;
      assert.strictEqual(h.ctx.terminals[0], current);
      assert.equal(h.ctx.terminals[0]?.status, 'live');
      assert.equal(h.ctx.terminals[0]?.restore, undefined);
      assert.deepEqual(h.unmounts, ['srv_old'], 'the new pane stays mounted after the acknowledgement');
    } finally { h.dispose(); }
  });
}

test('restore failure or removal before an acknowledgement remains authoritative', async () => {
  const h = harness([spec({ id: 'failed', serverId: 'srv_failed' }), spec({ id: 'removed', serverId: 'srv_removed' })]);
  try {
    await h.answer(h.request('/api/terminal-tabs'), { tabs: [rec({ id: 'failed' }), rec({ id: 'removed' })] });
    let restoring!: Promise<RestoreSummary | null>;
    act(() => { restoring = h.ctx.restoreTabs(); });
    h.emit({ type: 'restore-failed', projectPath: P, id: 'failed', reason: 'no capacity' });
    h.emit({ type: 'ended', projectPath: P, id: 'removed', ended: { at: 2, reason: 'closed' } });
    await h.answer(h.request('/api/terminal-tabs/restore'), summary(['failed', 'removed']));
    await restoring;
    assert.deepEqual(h.ctx.terminals.map((t) => t.id), ['failed']);
    assert.equal(h.ctx.terminals[0]?.restore, 'failed');
    assert.equal(h.ctx.terminals[0]?.restoreReason, 'no capacity');
    assert.equal(h.ctx.terminals[0]?.serverId, undefined);
    assert.deepEqual(h.mounts, ['srv_failed'], 'failed tabs never mount a serverless pane');
  } finally { h.dispose(); }
});

test('a restore acknowledgement still marks genuinely queued tabs pending when WS events were missed', async () => {
  const h = harness([spec({ id: 'a', serverId: 'srv_old' })]);
  try {
    await h.answer(h.request('/api/terminal-tabs'), { tabs: [rec({ id: 'a', serverId: 'srv_old' })] });
    let restoring!: Promise<RestoreSummary | null>;
    act(() => { restoring = h.ctx.restoreTabs(); });
    await h.answer(h.request('/api/terminal-tabs/restore'), summary(['a']));
    await restoring;
    assert.equal(h.ctx.terminals[0]?.restore, 'pending');
    assert.equal(h.ctx.terminals[0]?.serverId, undefined);
    assert.equal(h.ctx.terminals[0]?.restored, true);
    assert.deepEqual(h.unmounts, ['srv_old']);
    assert.deepEqual(h.mounts, ['srv_old']);
    h.emit({ type: 'restored', projectPath: P, mode: 'relaunched', record: rec({ id: 'a', serverId: 'srv_new' }) });
    assert.equal(h.ctx.terminals[0]?.restore, undefined);
    assert.deepEqual(h.mounts, ['srv_old', 'srv_new']);
  } finally { h.dispose(); }
});

test('a queue acknowledgement also supersedes an older list when no WS event arrived', async () => {
  const h = harness([spec({ id: 'a', serverId: 'srv_old' })]);
  try {
    let restoring!: Promise<RestoreSummary | null>;
    act(() => { restoring = h.ctx.restoreTabs(); });
    await h.answer(h.request('/api/terminal-tabs/restore'), summary(['a']));
    await restoring;
    await h.answer(h.request('/api/terminal-tabs'), { tabs: [rec({ id: 'a', serverId: 'srv_old' })] });
    assert.equal(h.ctx.terminals[0]?.serverId, undefined);
    assert.equal(h.ctx.terminals[0]?.restore, 'pending');
    assert.deepEqual(h.mounts, ['srv_old']);
  } finally { h.dispose(); }
});

test('a hello during restore protects new ptys and failures while the summary queues an unchanged stale pty', async () => {
  const h = harness([
    spec({ id: 'restored', serverId: 'srv_old' }),
    spec({ id: 'failed', restore: 'pending' }),
    spec({ id: 'queued', serverId: 'srv_stale' }),
  ]);
  try {
    let restoring!: Promise<RestoreSummary | null>;
    act(() => { restoring = h.ctx.restoreTabs(); });
    h.emit({ type: 'hello', tabs: [
      rec({ id: 'restored', serverId: 'srv_new' }),
      rec({ id: 'failed', serverId: undefined, ended: { at: 2, reason: 'restore-failed', detail: 'boom' } }),
      rec({ id: 'queued', serverId: 'srv_stale' }),
    ] });
    await h.answer(h.request('/api/terminal-tabs/restore'), summary(['restored', 'failed', 'queued']));
    await restoring;
    assert.equal(h.ctx.terminals.find((t) => t.id === 'restored')?.serverId, 'srv_new');
    assert.equal(h.ctx.terminals.find((t) => t.id === 'failed')?.restoreReason, 'restore-failed: boom');
    assert.equal(h.ctx.terminals.find((t) => t.id === 'queued')?.restore, 'pending');
    assert.equal(h.ctx.terminals.find((t) => t.id === 'queued')?.serverId, undefined);
    assert.deepEqual(h.mounts, ['srv_old', 'srv_new']);
    assert.deepEqual(h.unmounts, ['srv_old']);
  } finally { h.dispose(); }
});

test('restores remain single-flighted in a project and explicit retry requests still reach the backend', async () => {
  const h = harness([spec({ id: 'a', serverId: 'srv_old' })]);
  try {
    let first!: Promise<RestoreSummary | null>;
    let repeated!: Promise<RestoreSummary | null>;
    let retry!: Promise<RestoreSummary | null>;
    act(() => {
      first = h.ctx.restoreTabs();
      repeated = h.ctx.restoreTabs();
      retry = h.ctx.restoreTabs({ retry: true });
    });
    assert.equal(h.requests.filter((r) => r.url.pathname.endsWith('/restore')).length, 2);
    const explicit = h.request('/api/terminal-tabs/restore', P, 1);
    assert.equal(explicit.url.searchParams.get('retry'), '1');
    await h.answer(explicit, { ...summary([]), status: 'already-running' });
    await retry;
    assert.equal(h.ctx.lastRestore?.summary.status, 'already-running');
    await h.answer(h.request('/api/terminal-tabs/restore'), summary(['a']));
    assert.deepEqual(await first, await repeated);
    assert.equal(h.ctx.terminals[0]?.restore, 'pending');
  } finally { h.dispose(); }
});
