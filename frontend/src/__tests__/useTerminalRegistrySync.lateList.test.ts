// A late initial `GET /api/terminal-tabs` list never reverts newer registry
// state: it preserves a relaunched pty, failures, removals and remote additions
// (with or without a hello first); a newer hello supersedes the entire old
// list, including records it omitted; local registered additions made during
// the fetch stay; a hello can trigger auto-restore before the list resolves
// without either response reverting the success.
// Harness: useTerminalRegistrySync.fixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react-test-renderer';
import { harness, OTHER, P, rec, spec, summary } from './useTerminalRegistrySync.fixture.ts';

for (const hello of [false, true]) {
  test(`late list preserves new pty, failures, removals and remote additions (${hello ? 'with' : 'without'} hello)`, async () => {
    const h = harness([
      spec({ id: 'a', serverId: 'srv_old', status: 'dead' }),
      spec({ id: 'removed', serverId: 'srv_removed' }),
      spec({ id: 'failed', serverId: 'srv_failed' }),
      spec({ id: 'foreign', projectPath: OTHER, cwd: OTHER, serverId: 'srv_foreign' }),
    ]);
    try {
      const old = [rec({ id: 'a', serverId: 'srv_old' }), rec({ id: 'removed' }), rec({ id: 'failed' })];
      if (hello) h.emit({ type: 'hello', tabs: old });
      h.emit({ type: 'restored', projectPath: P, mode: 'relaunched', record: rec({ id: 'a', serverId: 'srv_new', label: 'updated label' }) });
      h.emit({ type: 'removed', projectPath: P, id: 'removed' });
      h.emit({ type: 'ended', projectPath: P, id: 'failed', ended: { at: 2, reason: 'restore-failed', detail: 'boom' } });
      h.emit({ type: 'upsert', projectPath: P, record: rec({ id: 'remote' }) });
      act(() => { h.ctx.setStatus('a', 'live'); });
      const current = h.ctx.terminals.find((t) => t.id === 'a');
      await h.answer(h.request('/api/terminal-tabs'), { tabs: old });
      assert.strictEqual(h.ctx.terminals.find((t) => t.id === 'a'), current);
      assert.equal(current?.label, 'updated label');
      assert.equal(current?.serverId, 'srv_new');
      assert.equal(current?.relaunchNonce, 1);
      assert.ok(h.ctx.terminals.some((t) => t.id === 'remote'));
      assert.ok(h.ctx.terminals.some((t) => t.id === 'foreign'));
      assert.ok(!h.ctx.terminals.some((t) => t.id === 'removed'));
      assert.equal(h.ctx.terminals.find((t) => t.id === 'failed')?.restoreReason, 'restore-failed: boom');
      assert.deepEqual(h.mounts, ['srv_old', 'srv_new']);
      assert.deepEqual(h.unmounts, ['srv_old']);
    } finally { h.dispose(); }
  });
}

test('a newer hello supersedes the entire old list, including records it omitted', async () => {
  const h = harness();
  try {
    h.emit({ type: 'hello', tabs: [rec({ id: 'remote' })] });
    await h.answer(h.request('/api/terminal-tabs'), { tabs: [rec({ id: 'obsolete' })] });
    assert.deepEqual(h.ctx.terminals.map((t) => t.id), ['remote']);
  } finally { h.dispose(); }
});

test('local registered additions during the list fetch remain protected', async () => {
  const h = harness();
  try {
    act(() => { h.ctx.addTerminal(spec({ id: 'local', serverId: 'srv_local' }), false); });
    h.emit({ type: 'hello', tabs: [] });
    await h.answer(h.request('/api/terminal-tabs'), { tabs: [] });
    assert.deepEqual(h.ctx.terminals.map((t) => t.id), ['local']);
  } finally { h.dispose(); }
});

test('hello can trigger auto-restore before the initial list resolves, without either response reverting success', async () => {
  const h = harness([spec({ id: 'a', serverId: 'srv_old' })], 'always');
  try {
    h.emit({ type: 'hello', tabs: [rec({ id: 'a', serverId: 'srv_old' })] });
    const restore = h.request('/api/terminal-tabs/restore');
    h.emit({ type: 'restored', projectPath: P, mode: 'relaunched', record: rec({ id: 'a', serverId: 'srv_new' }) });
    await h.answer(restore, summary(['a']));
    await h.answer(h.request('/api/terminal-tabs'), { tabs: [rec({ id: 'a', serverId: 'srv_old' })] });
    assert.equal(h.ctx.terminals[0]?.serverId, 'srv_new');
    assert.equal(h.ctx.terminals[0]?.restore, undefined);
    assert.equal(h.requests.filter((r) => r.url.pathname.endsWith('/restore')).length, 1);
  } finally { h.dispose(); }
});
