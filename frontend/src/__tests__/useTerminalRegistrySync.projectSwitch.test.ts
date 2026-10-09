// The terminal registry's project fence: switching projects fences stale list,
// restore and socket callbacks — including A -> B -> A — so an old visit can
// neither replace the current project's tabs nor publish a restore notice.
// Harness: useTerminalRegistrySync.fixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react-test-renderer';
import type { RestoreSummary } from '../api/types/terminalTabs';
import { harness, OTHER, P, rec, spec, summary } from './useTerminalRegistrySync.fixture.ts';

test('project switches fence stale list, restore and socket callbacks, including A -> B -> A', async () => {
  const h = harness([spec({ id: 'a', serverId: 'srv_old' })]);
  try {
    const firstList = h.request('/api/terminal-tabs');
    const firstSocket = h.socket();
    let oldRestore!: Promise<RestoreSummary | null>;
    act(() => { oldRestore = h.ctx.restoreTabs(); });
    const firstRestore = h.request('/api/terminal-tabs/restore');
    h.switchTo(OTHER);
    h.emit({ type: 'hello', tabs: [rec({ id: 'b', projectPath: OTHER, cwd: OTHER })] }, h.socket(OTHER));
    let otherRestore!: Promise<RestoreSummary | null>;
    act(() => { otherRestore = h.ctx.restoreTabs(); });
    const secondRestore = h.request('/api/terminal-tabs/restore', OTHER);
    h.switchTo(P);
    h.emit({ type: 'hello', tabs: [rec({ id: 'a', serverId: 'srv_new' })] });
    let currentRestore!: Promise<RestoreSummary | null>;
    act(() => { currentRestore = h.ctx.restoreTabs(); });
    const currentRequest = h.request('/api/terminal-tabs/restore', P, 1);
    const current = h.ctx.terminals.find((t) => t.id === 'a');
    h.emit({ type: 'removed', projectPath: P, id: 'a' }, firstSocket);
    await h.answer(firstList, { tabs: [rec({ id: 'a', serverId: 'srv_old' })] });
    await h.answer(firstRestore, summary(['a']));
    await oldRestore;
    await h.answer(secondRestore, summary(['b']));
    await otherRestore;
    assert.strictEqual(h.ctx.terminals.find((t) => t.id === 'a'), current);
    assert.equal(h.ctx.terminals.find((t) => t.id === 'b')?.serverId, 'srv_b');
    assert.equal(h.ctx.lastRestore, null, 'old visits cannot publish restore notices');
    await h.answer(currentRequest, { ...summary([]), adopted: 1 });
    await currentRestore;
  } finally { h.dispose(); }
});
