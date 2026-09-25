// A freshly seeded startup terminal supersedes the dead record of the same
// startup command. Without this, the ONLY code that ended a dead `startup`
// record was the restore pass (restore.ts `checkOwner`), and restore does not
// run with `restoreTerminalsOnOpen: 'never'` (or an `ask` the user declined):
// the exit watcher skips the record because its executor instance changed, the
// sidebar re-seeds a fresh pty beside it, and every executor restart added
// another dead "session lost" `npm run dev` tab.
//
// Conservative on purpose: only records whose pty is DEFINITELY gone are ended
// — no pty at all, or a pty of a different (replaced) executor instance. A
// same-instance record is left to the exit watcher, which sees whether its pty
// is still alive; ending a live one here would orphan a running process with
// no tab to kill it from.

import type { TerminalRegistryStore } from './store.js';
import type { TerminalRecord } from './types.js';

export function isSupersededStartupRecord(
  record: TerminalRecord,
  fresh: Pick<TerminalRecord, 'id' | 'startupId'>,
  currentInstanceId: string | undefined,
): boolean {
  if (record.id === fresh.id || record.ended) return false;
  if (record.owner !== 'startup' || !fresh.startupId || record.startupId !== fresh.startupId) return false;
  if (!record.serverId) return true;
  return !!currentInstanceId && record.serverInstanceId !== currentInstanceId;
}

// Ends (as `owner-finished`, which removes the record and its tab) every older
// record of `fresh`'s startup command whose pty is dead. Returns the count.
export async function endSupersededStartupRecords(
  store: Pick<TerminalRegistryStore, 'list' | 'end'>,
  fresh: TerminalRecord,
  currentInstanceId: string | undefined,
): Promise<number> {
  if (fresh.owner !== 'startup' || !fresh.startupId) return 0;
  const records = await store.list(fresh.projectPath);
  let n = 0;
  for (const record of records) {
    if (!isSupersededStartupRecord(record, fresh, currentInstanceId)) continue;
    const ended = await store.end(record.id, {
      reason: 'owner-finished',
      detail: 'superseded by a re-seeded startup terminal',
    }, fresh.projectPath);
    if (ended) n += 1;
  }
  return n;
}
