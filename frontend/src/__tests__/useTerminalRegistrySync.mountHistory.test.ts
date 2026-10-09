// Bounded mount history: Sidebar's mounting gates (useMountedTerminalIds +
// SidebarPanes) over the real registry sync. Repeatedly removed viewed, startup
// and fallback tabs never accumulate ids, and a stale or absent activeId can't
// reinsert a retired one; published Sets are immutable and keep their identity
// when only decorations or unviewed (pre-spawned, lazy) membership change;
// surviving tabs keep remembered activation across panels and A -> B -> A;
// pending and failed registered closes retain history until removal is
// confirmed; startup/fallback mounting preserves the pending/failed restore
// gates (capturing a fallback pty doesn't recreate its pane); hidden panes are
// capped, the least recently active server-backed pane unmounting first while
// its pty keeps running server-side (startup tabs exempt).
// Harness: useTerminalRegistrySync.fixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react-test-renderer';
import { MAX_BACKGROUND_PANES } from '../components/sidebar/hooks/useMountedTerminalIds.ts';
import { harness, OTHER, P, rec, spec } from './useTerminalRegistrySync.fixture.ts';

test('mount history stays bounded while viewed, startup and fallback tabs are repeatedly removed', async () => {
  const h = harness();
  try {
    await h.answer(h.request('/api/terminal-tabs'), { tabs: [] });
    for (let i = 0; i < 10; i++) {
      const viewed = `viewed_${i}`;
      const startup = `startup_${i}`;
      const fallback = `fallback_${i}`;
      const lazy = `lazy_${i}`;
      act(() => {
        h.ctx.addTerminal(spec({ id: viewed, serverId: `srv_${viewed}` }));
        h.ctx.addTerminal(spec({ id: startup, kind: 'startup', serverId: `srv_${startup}` }), false);
        h.ctx.addTerminal(spec({ id: fallback, registered: false }), false);
        h.ctx.addTerminal(spec({ id: lazy, serverId: `srv_${lazy}` }), false);
      });
      assert.deepEqual(h.mountedIds, new Set([viewed, startup, fallback]));
      const beforeRemoval = h.mountedIds;

      h.emit({ type: 'removed', projectPath: P, id: viewed });
      assert.equal(h.ctx.activeId, viewed, 'the registry removes the tab before selection reconciles');
      assert.ok(!h.ctx.terminals.some((t) => t.id === viewed));
      assert.deepEqual(h.mountedIds, new Set([startup, fallback]), 'a stale activeId cannot reinsert the retired id');
      assert.deepEqual(beforeRemoval, new Set([viewed, startup, fallback]), 'published sets stay immutable');

      h.emit({ type: 'ended', projectPath: P, id: startup, ended: { at: 2, reason: 'closed' } });
      h.emit({ type: 'removed', projectPath: P, id: lazy });
      act(() => { h.ctx.closeTerminal(fallback); });
      assert.deepEqual(h.ctx.terminals, []);
      assert.deepEqual(h.mountedIds, new Set(), 'closed ids do not accumulate across cycles');
      act(() => { h.ctx.setActiveId(null); });
    }
    act(() => { h.ctx.setActiveId('already-removed'); });
    assert.deepEqual(h.mountedIds, new Set(), 'changing to an absent activeId cannot add it');
  } finally { h.dispose(); }
});

test('mount history keeps its identity when terminal decorations or unviewed membership change', () => {
  const h = harness([spec({ id: 'viewed', serverId: 'srv_viewed' })]);
  try {
    const mountedIds = h.mountedIds;
    act(() => { h.ctx.setStatus('viewed', 'live'); });
    assert.strictEqual(h.mountedIds, mountedIds);
    act(() => { h.ctx.addTerminal(spec({ id: 'unviewed', serverId: 'srv_unviewed' }), false); });
    assert.strictEqual(h.mountedIds, mountedIds, 'pre-spawned tabs stay lazy until viewed');
    h.emit({ type: 'removed', projectPath: P, id: 'unviewed' });
    assert.strictEqual(h.mountedIds, mountedIds, 'removing an unviewed tab does not change history');
    assert.deepEqual(h.mountedIds, new Set(['viewed']));
  } finally { h.dispose(); }
});

test('surviving tabs keep remembered activation across panels and A -> B -> A', () => {
  const h = harness([
    spec({ id: 'a', serverId: 'srv_a' }),
    spec({ id: 'lazy', serverId: 'srv_lazy' }),
    spec({ id: 'startup', kind: 'startup', serverId: 'srv_startup' }),
    spec({ id: 'b', projectPath: OTHER, cwd: OTHER, serverId: 'srv_b' }),
  ]);
  try {
    const initial = h.mountedIds;
    assert.deepEqual(initial, new Set(['a', 'startup']));
    act(() => { h.ctx.setActiveId(null); });
    h.switchPanel('startup');
    assert.strictEqual(h.mountedIds, initial, 'hidden regular tabs retain their viewed status');
    h.switchPanel('merging');
    assert.strictEqual(h.mountedIds, initial, 'an empty panel does not retire any ids');
    assert.deepEqual(h.paneIds, ['a', 'startup']);
    h.switchPanel('terminals');
    h.switchTo(OTHER);
    assert.strictEqual(h.mountedIds, initial, 'leaving a project does not retire its tabs');
    assert.deepEqual(h.paneIds, [], 'the other project remains lazy until viewed');
    act(() => { h.ctx.setActiveId('b'); });
    const bothProjects = h.mountedIds;
    assert.deepEqual(bothProjects, new Set(['a', 'startup', 'b']));
    act(() => { h.ctx.setActiveId(null); });
    h.switchTo(P);
    assert.strictEqual(h.mountedIds, bothProjects);
    assert.deepEqual(h.paneIds, ['a', 'startup'], 'returning to A mounts surviving viewed tabs without reactivation');
    assert.equal(h.mounts.filter((id) => id === 'srv_a').length, 2);
    assert.ok(!h.mountedIds.has('lazy'));
  } finally { h.dispose(); }
});

test('pending and failed registered closes retain mount history until removal is confirmed', async () => {
  const h = harness([spec({ id: 'a', serverId: 'srv_a' })]);
  try {
    const mountedIds = h.mountedIds;
    act(() => { h.ctx.closeTerminal('a'); });
    assert.equal(h.ctx.terminals[0]?.closeState, 'closing');
    assert.strictEqual(h.mountedIds, mountedIds);
    assert.deepEqual(h.paneIds, ['a']);
    await h.answer(h.request('/api/terminal-tabs/a'), { error: 'kill unconfirmed' }, 503);
    assert.equal(h.ctx.terminals[0]?.closeState, 'failed');
    assert.equal(h.ctx.terminals[0]?.serverId, 'srv_a');
    assert.strictEqual(h.mountedIds, mountedIds);
    assert.deepEqual(h.paneIds, ['a']);
    assert.deepEqual(h.unmounts, []);
    act(() => { h.ctx.closeTerminal('a'); });
    assert.strictEqual(h.mountedIds, mountedIds);
    await h.answer(h.request('/api/terminal-tabs/a', P, 1), { ok: true });
    assert.deepEqual(h.ctx.terminals, []);
    assert.deepEqual(h.mountedIds, new Set());
    assert.deepEqual(h.unmounts, ['srv_a']);
  } finally { h.dispose(); }
});

test('startup and fallback mounting preserve pending and failed restore gates', () => {
  const h = harness([
    spec({ id: 'active', serverId: 'srv_active' }),
    spec({ id: 'lazy', serverId: 'srv_lazy' }),
    spec({ id: 'startup', kind: 'startup', serverId: 'srv_startup' }),
    spec({ id: 'fallback', registered: false }),
    spec({ id: 'pending', restore: 'pending' }),
    spec({ id: 'failed', restore: 'failed' }),
    spec({ id: 'startup-pending', kind: 'startup', restore: 'pending' }),
    spec({ id: 'startup-failed', kind: 'startup', restore: 'failed' }),
  ]);
  try {
    assert.deepEqual(h.mountedIds, new Set(['active', 'startup', 'fallback', 'startup-pending', 'startup-failed']));
    assert.deepEqual(h.paneIds, ['active', 'startup', 'fallback']);
    const mountedIds = h.mountedIds;
    act(() => { h.ctx.setServerId('fallback', 'srv_fallback'); });
    assert.strictEqual(h.mountedIds, mountedIds, 'capturing a fallback pty preserves its mount history');
    assert.deepEqual(h.unmounts, [], 'capturing a fallback pty does not recreate its pane');
    for (const id of ['pending', 'failed']) {
      act(() => { h.ctx.setActiveId(id); });
      assert.ok(h.mountedIds.has(id), 'activation is remembered while restore gates the pane');
      assert.deepEqual(h.paneIds, ['active', 'startup', 'fallback']);
    }
    act(() => { h.ctx.setActiveId(null); });
    const beforeRestore = h.mountedIds;
    h.emit({ type: 'restored', projectPath: P, mode: 'relaunched', record: rec({ id: 'pending' }) });
    assert.strictEqual(h.mountedIds, beforeRestore);
    assert.deepEqual(h.paneIds, ['active', 'startup', 'fallback', 'pending'], 'a surviving viewed tab mounts once restore succeeds');
    assert.ok(!h.mountedIds.has('lazy'));
  } finally { h.dispose(); }
});

test('hidden panes are capped: the least recently active server-backed pane unmounts first', () => {
  const ids = Array.from({ length: MAX_BACKGROUND_PANES + 3 }, (_, i) => `t${i}`);
  const h = harness([
    spec({ id: 'startup', kind: 'startup', serverId: 'srv_startup' }),
    ...ids.map((id) => spec({ id, serverId: `srv_${id}` })),
  ]);
  try {
    // View every tab once, in order; t0 is the least recently active.
    for (const id of ids) act(() => { h.ctx.setActiveId(id); });
    const active = ids.at(-1)!;
    const kept = ids.slice(-(MAX_BACKGROUND_PANES + 1));
    assert.deepEqual(h.mountedIds, new Set(['startup', ...kept]),
      'active + MAX_BACKGROUND_PANES hidden panes; startup terminals are exempt');
    assert.ok(h.unmounts.includes('srv_t0') && h.unmounts.includes('srv_t1'),
      'evicted panes unmount (the pty keeps running server-side)');
    const before = h.mountedIds;
    act(() => { h.ctx.setActiveId(active); });
    assert.strictEqual(h.mountedIds, before, 'no change → same Set identity');
    // Re-activating an evicted tab remounts it and evicts the next-oldest.
    act(() => { h.ctx.setActiveId('t0'); });
    assert.ok(h.mountedIds.has('t0'));
    assert.ok(!h.mountedIds.has(kept[0]));
  } finally {
    h.dispose();
  }
});
