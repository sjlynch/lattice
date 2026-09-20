// Pure reconciliation between the sidebar's local tab list and the backend's
// durable terminal-tab registry (`/api/terminal-tabs`, `/ws/terminal-tabs`).
// The registry is the source of truth for WHICH registered tabs exist and
// which pty backs each; the local list keeps transient per-pane state
// (connection status) and any unregistered fallback tabs.

import type { TerminalRecord, TerminalTabsEvent } from '../api/types/terminalTabs';
import type { TerminalSpec } from './terminalTypes';

function restoreStateFor(record: TerminalRecord): Pick<TerminalSpec, 'restore' | 'restoreReason'> {
  if (record.ended) {
    return {
      restore: 'failed',
      restoreReason: record.ended.detail
        ? `${record.ended.reason}: ${record.ended.detail}`
        : record.ended.reason,
    };
  }
  // A registered tab with no pty is waiting on a relaunch (or was never
  // relaunched because restore hasn't run yet). No pane may mount for it.
  return record.serverId ? {} : { restore: 'pending' };
}

// Project a registry record onto a tab spec. `prev` carries over transient
// status only when the same pty is still behind the tab.
export function recordToSpec(record: TerminalRecord, prev?: TerminalSpec): TerminalSpec {
  const samePty = !!prev && !!prev.serverId && prev.serverId === record.serverId;
  // A different live pty behind a tab whose pane may already have given up
  // on the old one: bump the nonce so the Sidebar remounts the pane. (Also
  // covers a `hello` snapshot that arrives after a relaunch this client's
  // socket missed.)
  const swappedPty = !!prev?.serverId && !!record.serverId && prev.serverId !== record.serverId;
  const relaunchNonce = swappedPty ? (prev?.relaunchNonce ?? 0) + 1 : prev?.relaunchNonce;
  return {
    id: record.id,
    label: record.label,
    cwd: record.cwd,
    projectPath: record.projectPath,
    initialCommand: record.launch.initialCommand,
    taskId: record.taskId,
    kind: record.kind,
    startupId: record.startupId,
    serverId: record.serverId,
    registered: true,
    ...(samePty && prev?.status ? { status: prev.status, exitCode: prev.exitCode } : {}),
    ...(prev?.restored ? { restored: true } : {}),
    ...(relaunchNonce ? { relaunchNonce } : {}),
    ...restoreStateFor(record),
  };
}

function sameProject(a: string | undefined, b: string): boolean {
  return a === b;
}

// Replace the project's registered tabs with the registry's records (in
// registry order), keep unregistered local tabs unless a record already owns
// their pty, and leave every other project's tabs untouched.
export function mergeRegistryTabs(
  terminals: TerminalSpec[],
  records: TerminalRecord[],
  projectPath: string,
): TerminalSpec[] {
  const prevById = new Map(terminals.map((t) => [t.id, t] as const));
  const recordServerIds = new Set(records.map((r) => r.serverId).filter(Boolean));
  // `records` is the registry's answer for THIS project (the fetch and the WS
  // subscription are both project-scoped), so every one is projected.
  const projected = records.map((r) => recordToSpec(r, prevById.get(r.id)));
  const others: TerminalSpec[] = [];
  const localUnregistered: TerminalSpec[] = [];
  for (const t of terminals) {
    if (!sameProject(t.projectPath, projectPath)) {
      others.push(t);
      continue;
    }
    if (t.registered) continue; // superseded by the registry's view
    if (t.serverId && recordServerIds.has(t.serverId)) continue; // a record owns this pty
    localUnregistered.push(t);
  }
  return [...others, ...projected, ...localUnregistered];
}

// Apply one live registry event to the list. `restore-summary` and `hello`
// are handled by the context (they are not list edits).
export function applyTerminalTabsEvent(
  terminals: TerminalSpec[],
  ev: TerminalTabsEvent,
): TerminalSpec[] {
  switch (ev.type) {
    case 'upsert': {
      const idx = terminals.findIndex((t) => t.id === ev.record.id);
      if (idx >= 0) {
        const next = [...terminals];
        next[idx] = recordToSpec(ev.record, terminals[idx]);
        return next;
      }
      if (ev.record.ended) return terminals;
      // A pty another browser tab (or a backend spawn we never saw an event
      // for) created: adopt it, dropping any unregistered local tab on the
      // same pty.
      const spec = recordToSpec(ev.record);
      return [...terminals.filter((t) => !(t.serverId && t.serverId === ev.record.serverId && !t.registered)), spec];
    }
    case 'restored': {
      const idx = terminals.findIndex((t) => t.id === ev.record.id);
      const spec: TerminalSpec = {
        ...recordToSpec(ev.record),
        restored: true,
        restore: undefined,
        restoreReason: undefined,
      };
      if (idx < 0) return [...terminals, spec];
      const prev = terminals[idx]!;
      const next = [...terminals];
      // Same pty re-attached: keep the pane's status. A different pty (a
      // relaunch, or an orphan adopted onto the record) is a fresh
      // connection: status resets and the nonce bump remounts the pane.
      // A tab that was already unmounted as `restore: pending` (no serverId)
      // simply mounts fresh, so no bump is needed there.
      next[idx] = prev.serverId === ev.record.serverId
        ? { ...spec, status: prev.status, exitCode: prev.exitCode, relaunchNonce: prev.relaunchNonce }
        : { ...spec, relaunchNonce: prev.serverId ? (prev.relaunchNonce ?? 0) + 1 : prev.relaunchNonce };
      return next;
    }
    case 'restore-failed':
      return terminals.map((t) =>
        t.id === ev.id ? { ...t, restore: 'failed', restoreReason: ev.reason, serverId: undefined } : t,
      );
    case 'ended': {
      const reason = ev.ended.reason;
      if (reason === 'cwd-missing' || reason === 'restore-failed') {
        return terminals.map((t) =>
          t.id === ev.id
            ? { ...t, restore: 'failed', restoreReason: ev.ended.detail ? `${reason}: ${ev.ended.detail}` : reason, serverId: undefined }
            : t,
        );
      }
      if (reason === 'exit') {
        // The pane (if mounted) also sees the exit frame; keep the tab so the
        // user can read the final output, like today.
        return terminals.map((t) =>
          t.id === ev.id && t.status !== 'exited' && t.status !== 'dead'
            ? { ...t, status: 'exited', exitCode: ev.ended.exitCode }
            : t,
        );
      }
      return terminals.filter((t) => t.id !== ev.id);
    }
    case 'removed':
      // An exited tab stays until the user closes it; anything else is gone.
      return terminals.filter((t) => t.id !== ev.id || t.status === 'exited' || t.status === 'dead');
    default:
      return terminals;
  }
}

// The registered ids of one project's tabs, in list order — the payload for
// the order PATCH.
export function registeredOrder(terminals: TerminalSpec[], projectPath: string): string[] {
  return terminals
    .filter((t) => t.registered && sameProject(t.projectPath, projectPath))
    .map((t) => t.id);
}

// How many of a project's records would need a RELAUNCH (for 'ask' mode):
// non-ended, non-startup records whose pty is not in the live set. A record
// whose pty is still alive re-attaches on its own, so it is nothing to ask
// about. `liveServerIds === null` means the live set could not be read; then
// every candidate counts (prompting is the safe side).
export function restorableCount(
  records: TerminalRecord[],
  liveServerIds: ReadonlySet<string> | null = null,
): number {
  return records.filter((r) => {
    if (r.ended || r.owner === 'startup') return false;
    // Another client's restore pass already has this one in flight.
    if (r.relaunching) return false;
    if (liveServerIds && r.serverId && liveServerIds.has(r.serverId)) return false;
    return true;
  }).length;
}
