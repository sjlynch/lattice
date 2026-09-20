import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TerminalRecord } from '../api/types/terminalTabs';
import type { TerminalSpec } from '../terminal/terminalTypes';
import {
  applyTerminalTabsEvent,
  mergeRegistryTabs,
  recordToSpec,
  registeredOrder,
  restorableCount,
} from '../terminal/terminalRegistrySync.ts';

const P = 'C:\\proj';
const OTHER = 'C:\\other';

function rec(over: Partial<TerminalRecord> & { id: string }): TerminalRecord {
  return {
    projectPath: P,
    cwd: P,
    label: over.id,
    order: 0,
    owner: 'user',
    launch: { initialCommand: 'claude', harness: 'claude' },
    serverId: `srv_${over.id}`,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function spec(over: Partial<TerminalSpec> & { id: string }): TerminalSpec {
  return { label: over.id, cwd: P, projectPath: P, ...over };
}

test('recordToSpec projects a record and derives its restore state', () => {
  const live = recordToSpec(rec({ id: 'a', taskId: 't', kind: 'merge' }));
  assert.equal(live.registered, true);
  assert.equal(live.serverId, 'srv_a');
  assert.equal(live.restore, undefined);
  assert.equal(live.taskId, 't');
  assert.equal(live.kind, 'merge');
  assert.equal(live.initialCommand, 'claude');

  const pending = recordToSpec(rec({ id: 'b', serverId: undefined }));
  assert.equal(pending.restore, 'pending');

  const failed = recordToSpec(rec({ id: 'c', serverId: undefined, ended: { at: 1, reason: 'cwd-missing', detail: 'C:\\gone' } }));
  assert.equal(failed.restore, 'failed');
  assert.equal(failed.restoreReason, 'cwd-missing: C:\\gone');
});

test('recordToSpec keeps the pane status only while the same pty backs the tab', () => {
  const prev = spec({ id: 'a', serverId: 'srv_a', status: 'live', registered: true });
  assert.equal(recordToSpec(rec({ id: 'a' }), prev).status, 'live');
  assert.equal(recordToSpec(rec({ id: 'a' }), prev).relaunchNonce, undefined);
  const swapped = recordToSpec(rec({ id: 'a', serverId: 'srv_new' }), prev);
  assert.equal(swapped.status, undefined);
  assert.equal(swapped.relaunchNonce, 1, 'a swapped pty (e.g. via a late hello) remounts the pane');
  // A tab that was pending (no pty) simply mounts when its pty arrives.
  const pending = spec({ id: 'p', registered: true, restore: 'pending' });
  assert.equal(recordToSpec(rec({ id: 'p' }), pending).relaunchNonce, undefined);
});

test('mergeRegistryTabs replaces the project slice, keeps other projects and unregistered fallbacks', () => {
  const local: TerminalSpec[] = [
    spec({ id: 'other', projectPath: OTHER, cwd: OTHER, serverId: 'srv_o' }),
    spec({ id: 'stale-registered', registered: true, serverId: 'srv_stale' }),
    spec({ id: 'local-fallback', serverId: 'srv_fallback' }),
    spec({ id: 'local-dup', serverId: 'srv_b' }), // an unregistered tab on a pty the registry owns
  ];
  const merged = mergeRegistryTabs(local, [rec({ id: 'a' }), rec({ id: 'b' })], P);
  assert.deepEqual(merged.map((t) => t.id), ['other', 'a', 'b', 'local-fallback']);
  assert.equal(merged.find((t) => t.id === 'a')?.registered, true);
});

test('mergeRegistryTabs keeps a registered tab created after the snapshot was requested', () => {
  // The fetch was answered before `fresh` existed; a plain merge would drop it
  // as "unknown to the registry" and the user's brand-new tab would vanish.
  const local: TerminalSpec[] = [
    spec({ id: 'a', registered: true, serverId: 'srv_a' }),
    spec({ id: 'fresh', registered: true, serverId: 'srv_fresh' }),
    spec({ id: 'gone', registered: true, serverId: 'srv_gone' }),
  ];
  const merged = mergeRegistryTabs(local, [rec({ id: 'a' })], P, new Set(['fresh']));
  assert.deepEqual(merged.map((t) => t.id), ['a', 'fresh']);
  // Once the registry lists it, the record wins (no duplicate).
  const later = mergeRegistryTabs(merged, [rec({ id: 'a' }), rec({ id: 'fresh' })], P, new Set(['fresh']));
  assert.deepEqual(later.map((t) => t.id), ['a', 'fresh']);
});

test('upsert adds unknown live records, updates known ones, ignores unknown ended ones', () => {
  let list = [spec({ id: 'a', registered: true, serverId: 'srv_a', status: 'live' })];
  list = applyTerminalTabsEvent(list, { type: 'upsert', projectPath: P, record: rec({ id: 'a', label: 'renamed' }) });
  assert.equal(list[0]!.label, 'renamed');
  assert.equal(list[0]!.status, 'live');
  list = applyTerminalTabsEvent(list, { type: 'upsert', projectPath: P, record: rec({ id: 'b' }) });
  assert.deepEqual(list.map((t) => t.id), ['a', 'b']);
  list = applyTerminalTabsEvent(list, {
    type: 'upsert', projectPath: P, record: rec({ id: 'z', serverId: undefined, ended: { at: 1, reason: 'restore-failed' } }),
  });
  assert.deepEqual(list.map((t) => t.id), ['a', 'b']);
});

test('ended: closed/killed/owner-finished remove; exit marks exited; restore failures mark failed', () => {
  const base = () => [
    spec({ id: 'a', registered: true, serverId: 'srv_a' }),
    spec({ id: 'b', registered: true, serverId: 'srv_b', status: 'live' }),
  ];
  const closed = applyTerminalTabsEvent(base(), { type: 'ended', projectPath: P, id: 'a', ended: { at: 1, reason: 'closed' } });
  assert.deepEqual(closed.map((t) => t.id), ['b']);
  const exited = applyTerminalTabsEvent(base(), { type: 'ended', projectPath: P, id: 'b', ended: { at: 1, reason: 'exit', exitCode: 0 } });
  assert.equal(exited[1]!.status, 'exited');
  assert.equal(exited[1]!.exitCode, 0);
  const failed = applyTerminalTabsEvent(base(), { type: 'ended', projectPath: P, id: 'a', ended: { at: 1, reason: 'restore-failed', detail: 'boom' } });
  assert.equal(failed[0]!.restore, 'failed');
  assert.equal(failed[0]!.restoreReason, 'restore-failed: boom');
  assert.equal(failed[0]!.serverId, undefined);
});

test('removed drops a tab unless it is sitting on its final output', () => {
  const list = [
    spec({ id: 'a', registered: true, status: 'exited' }),
    spec({ id: 'b', registered: true, status: 'live' }),
  ];
  const afterA = applyTerminalTabsEvent(list, { type: 'removed', projectPath: P, id: 'a' });
  assert.deepEqual(afterA.map((t) => t.id), ['a', 'b']);
  const afterB = applyTerminalTabsEvent(list, { type: 'removed', projectPath: P, id: 'b' });
  assert.deepEqual(afterB.map((t) => t.id), ['a']);
});

test('restored clears pending state, marks the tab, and resets status on a relaunch', () => {
  const list = [spec({ id: 'a', registered: true, restore: 'pending', serverId: 'srv_dead', status: 'dead' })];
  const relaunched = applyTerminalTabsEvent(list, { type: 'restored', projectPath: P, record: rec({ id: 'a', serverId: 'srv_new' }), mode: 'relaunched' });
  assert.equal(relaunched[0]!.restore, undefined);
  assert.equal(relaunched[0]!.restored, true);
  assert.equal(relaunched[0]!.serverId, 'srv_new');
  assert.equal(relaunched[0]!.status, undefined);
  assert.equal(relaunched[0]!.relaunchNonce, 1, 'a different pty bumps the nonce so the pane remounts');
  const wasPending = [spec({ id: 'q', registered: true, restore: 'pending' })];
  const mounted = applyTerminalTabsEvent(wasPending, { type: 'restored', projectPath: P, record: rec({ id: 'q' }), mode: 'relaunched' });
  assert.equal(mounted[0]!.relaunchNonce, undefined, 'a pending tab had no pane to remount');

  const adoptedList = [spec({ id: 'b', registered: true, serverId: 'srv_b', status: 'live' })];
  const adopted = applyTerminalTabsEvent(adoptedList, { type: 'restored', projectPath: P, record: rec({ id: 'b' }), mode: 'adopted' });
  assert.equal(adopted[0]!.status, 'live');
  assert.equal(adopted[0]!.restored, true);
  assert.equal(adopted[0]!.relaunchNonce, undefined, 'the same pty keeps the pane');

  // An orphan pty adopted onto a record that pointed at a dead one.
  const orphanList = [spec({ id: 'o', registered: true, serverId: 'srv_dead', status: 'dead' })];
  const orphan = applyTerminalTabsEvent(orphanList, { type: 'restored', projectPath: P, record: rec({ id: 'o', serverId: 'srv_orphan' }), mode: 'adopted' });
  assert.equal(orphan[0]!.relaunchNonce, 1);
  assert.equal(orphan[0]!.status, undefined);

  // A record this browser tab never saw (restored from another tab) is added.
  const added = applyTerminalTabsEvent([], { type: 'restored', projectPath: P, record: rec({ id: 'c' }), mode: 'relaunched' });
  assert.deepEqual(added.map((t) => t.id), ['c']);
});

test('restore-failed marks the tab and drops its stale pty id', () => {
  const list = [spec({ id: 'a', registered: true, restore: 'pending', serverId: 'srv_old' })];
  const out = applyTerminalTabsEvent(list, { type: 'restore-failed', projectPath: P, id: 'a', reason: 'no slot' });
  assert.equal(out[0]!.restore, 'failed');
  assert.equal(out[0]!.restoreReason, 'no slot');
  assert.equal(out[0]!.serverId, undefined);
});

test('registeredOrder lists only the project\'s registered tabs in order; restorableCount skips startup + ended', () => {
  const list = [
    spec({ id: 'x', registered: true }),
    spec({ id: 'y' }),
    spec({ id: 'z', registered: true, projectPath: OTHER }),
    spec({ id: 'w', registered: true }),
  ];
  assert.deepEqual(registeredOrder(list, P), ['x', 'w']);
  const records = [
    rec({ id: 'a' }),
    rec({ id: 's', owner: 'startup' }),
    rec({ id: 'e', ended: { at: 1, reason: 'cwd-missing' } }),
    rec({ id: 'b', serverId: 'srv_b' }),
    rec({ id: 'p', serverId: undefined }),
  ];
  assert.equal(restorableCount(records), 3, 'no live set → every candidate counts');
  assert.equal(restorableCount(records, null), 3, 'unreadable live set → same');
  assert.equal(restorableCount(records, new Set(['srv_a'])), 2, 'a live pty is nothing to ask about');
  assert.equal(restorableCount(records, new Set(['srv_a', 'srv_b'])), 1, 'only the pty-less record remains');
  // A relaunch another browser tab already has in flight is nothing to ask about.
  assert.equal(restorableCount([...records, rec({ id: 'q', serverId: undefined, relaunching: true })], new Set(['srv_a', 'srv_b'])), 1);
});
