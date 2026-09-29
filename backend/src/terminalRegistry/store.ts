// The durable terminal-tab registry: one `terminals.json` per project under
// `~/.lattice/per-project/<hash>/`, holding a `TerminalRecord` for every tab
// the backend has ever created a pty for (sidebar launches, task agents,
// resolvers, one-shot runs, startup terminals). It is what survives a closed
// browser, a backend restart, a `Ctrl+C` of the dev server, and a reboot —
// the restore flow (restore.ts) rebuilds the sidebar from it.
//
// Ownership: the BACKEND is the sole creator of records (at pty creation, in
// `proxyCreateSession`). The frontend only patches decorations — label, order,
// the active tab — per record, so two browser tabs can never race a whole-list
// blob the way the old sessionStorage list could.
//
// Ended records: a tab that was closed / killed / whose owner finished / whose
// pty exited is simply removed (the `ended` event tells live clients why). A
// tab restore could not relaunch (`cwd-missing` / `restore-failed`) is KEPT
// with its `ended` marker so the sidebar can show why and the user can retry
// once the cause is fixed; those are pruned after ENDED_RETENTION_MS (the
// file codec lives in recordCodec.ts).

import { randomUUID } from 'node:crypto';
import { ProjectStateManager } from '../projectStateManager.js';
import { homeProjectScratchDir } from '../projectPath.js';
import { listKnownProjects as listKnownTaskProjects } from '../tasks.js';
import { deserializeTerminalRecords } from './recordCodec.js';
import type {
  RestoreSummary,
  TerminalEnded,
  TerminalRecord,
  TerminalRegistryEvent,
} from './types.js';

export { deserializeTerminalRecord, deserializeTerminalRecords } from './recordCodec.js';

export const TERMINALS_FILENAME = 'terminals.json';
const FILE_VERSION = 1;

export function terminalsFile(projectPath: string): string {
  return homeProjectScratchDir(projectPath, TERMINALS_FILENAME);
}

export type TerminalRegistrySubscriber = (event: TerminalRegistryEvent) => void;

export type NewTerminalRecordInput = Omit<
  TerminalRecord,
  'id' | 'order' | 'createdAt' | 'updatedAt'
> & { id?: string };

export class TerminalRegistryStore extends ProjectStateManager<TerminalRecord[], TerminalRegistrySubscriber> {
  private readonly listKnownProjects: () => Promise<string[]>;

  constructor(opts: { listKnownProjects?: () => Promise<string[]>; fileForProject?: (p: string) => string } = {}) {
    super({
      name: 'terminal-registry',
      fileForProject: opts.fileForProject ?? terminalsFile,
      defaultState: () => [],
      deserialize: deserializeTerminalRecords,
      snapshot: (records) => [...records],
    });
    this.listKnownProjects = opts.listKnownProjects ?? listKnownTaskProjects;
  }

  // The on-disk envelope is versioned; ProjectStateManager writes whatever
  // state we hold, so wrap/unwrap here.
  protected override async writeStateNow(projectPath: string, state: TerminalRecord[]): Promise<void> {
    await super.writeStateNow(projectPath, { version: FILE_VERSION, terminals: state } as unknown as TerminalRecord[]);
  }

  private emit(event: TerminalRegistryEvent): void {
    this.emitToSubscribers((fn) => fn(event));
  }

  // Restore-flow notifications (restore.ts). Plain fan-out; no state change.
  emitRestored(record: TerminalRecord, mode: 'adopted' | 'relaunched'): void {
    if (record.closePending || this.findInCacheById<TerminalRecord>(record.id, (r) => r.id)?.item.closePending) return;
    this.emit({ type: 'restored', projectPath: record.projectPath, record: { ...record }, mode });
  }

  emitRestoreFailed(record: TerminalRecord, reason: string): void {
    if (record.closePending || this.findInCacheById<TerminalRecord>(record.id, (r) => r.id)?.item.closePending) return;
    this.emit({ type: 'restore-failed', projectPath: record.projectPath, id: record.id, reason });
  }

  emitRestoreSummary(projectPath: string, summary: RestoreSummary): void {
    this.emit({ type: 'restore-summary', projectPath, summary });
  }

  async list(projectPath: string, opts: { includeEnded?: boolean } = {}): Promise<TerminalRecord[]> {
    const key = await this.loadIfNeeded(projectPath);
    const records = this.getCached(key) ?? [];
    const visible = opts.includeEnded ? records : records.filter((r) => !r.ended);
    return visible.map((r) => ({ ...r })).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  // Every record (ended ones included — callers filter) across every project
  // loaded in this process (the exit watcher's working set).
  loadedRecords(): Array<{ projectKey: string; record: TerminalRecord }> {
    const out: Array<{ projectKey: string; record: TerminalRecord }> = [];
    for (const [projectKey, records] of this.cacheEntries()) {
      for (const record of records) out.push({ projectKey, record });
    }
    return out;
  }

  async create(input: NewTerminalRecordInput): Promise<TerminalRecord> {
    const key = await this.loadIfNeeded(input.projectPath);
    return this.runProjectWrite(key, () => {
      const records = this.getCached(key) ?? [];
      const now = Date.now();
      const order = records.reduce((max, r) => Math.max(max, r.order), -1) + 1;
      const record: TerminalRecord = {
        ...input,
        id: input.id ?? `tab_${randomUUID()}`,
        order,
        createdAt: now,
        updatedAt: now,
      };
      this.setCached(key, [...records, record]);
      this.schedulePersist(key);
      this.emit({ type: 'upsert', projectPath: record.projectPath, record: { ...record } });
      return { ...record };
    });
  }

  private async locate(id: string, projectPath?: string): Promise<{ key: string; idx: number } | null> {
    if (projectPath) {
      const key = await this.loadIfNeeded(projectPath);
      const idx = (this.getCached(key) ?? []).findIndex((r) => r.id === id);
      return idx >= 0 ? { key, idx } : null;
    }
    const found = this.findInCacheById<TerminalRecord>(id, (r) => r.id);
    if (found) return { key: found.project, idx: found.idx };
    // Not loaded anywhere yet — load every known project and retry once.
    let projects: string[] = [];
    try { projects = await this.listKnownProjects(); } catch { /* best effort */ }
    for (const p of projects) {
      try { await this.loadIfNeeded(p); } catch { /* skip unreadable */ }
    }
    const again = this.findInCacheById<TerminalRecord>(id, (r) => r.id);
    return again ? { key: again.project, idx: again.idx } : null;
  }

  async get(id: string, projectPath?: string): Promise<TerminalRecord | null> {
    const loc = await this.locate(id, projectPath);
    if (!loc) return null;
    const record = (this.getCached(loc.key) ?? [])[loc.idx];
    return record ? { ...record } : null;
  }

  // The shared body of every single-record write (call it inside
  // runProjectWrite): re-find `id` in the cached list, hand `fn` a copy of the
  // list to change, then cache + persist that copy. Returns `null` — and
  // writes nothing — when the record is gone or `fn` declines with `null`;
  // otherwise `fn`'s result, so the caller can emit after the write.
  private writeRecordList<R>(
    key: string,
    id: string,
    fn: (list: TerminalRecord[], idx: number) => R | null,
  ): R | null {
    const records = this.getCached(key) ?? [];
    const idx = records.findIndex((r) => r.id === id);
    if (idx < 0) return null;
    const list = [...records];
    const result = fn(list, idx);
    if (result === null) return null;
    this.setCached(key, list);
    this.schedulePersist(key);
    return result;
  }

  async update(
    id: string,
    patch: Partial<Omit<TerminalRecord, 'id' | 'projectPath' | 'createdAt'>>,
    projectPath?: string,
  ): Promise<TerminalRecord | null> {
    return this.updateRecord(id, patch, projectPath, false);
  }

  // Only the actual spawn's bookkeeping may hand a late PTY to close intent;
  // an adoption from a stale restore snapshot must not claim an unrelated PTY.
  async recordRelaunch(
    id: string,
    patch: Partial<Omit<TerminalRecord, 'id' | 'projectPath' | 'createdAt'>>,
    projectPath?: string,
  ): Promise<TerminalRecord | null> {
    return this.updateRecord(id, patch, projectPath, true);
  }

  private async updateRecord(
    id: string,
    patch: Partial<Omit<TerminalRecord, 'id' | 'projectPath' | 'createdAt'>>,
    projectPath: string | undefined,
    fromSpawn: boolean,
  ): Promise<TerminalRecord | null> {
    const loc = await this.locate(id, projectPath);
    if (!loc) return null;
    return this.runProjectWrite(loc.key, async () => {
      const next = this.writeRecordList(loc.key, id, (list, idx) => {
        const current = list[idx]!;
        if (current.closePending) {
          // Stale restore/discovery writes cannot clear close intent or erase
          // its PTY. A spawn already in flight may hand off its new PTY to the
          // tombstone, so even an unconfirmed cleanup remains retryable.
          patch = {
            ...(patch.label !== undefined ? { label: patch.label } : {}),
            ...(patch.order !== undefined ? { order: patch.order } : {}),
            ...('relaunching' in patch && patch.relaunching === undefined ? { relaunching: undefined } : {}),
            ...(fromSpawn && !current.serverId && patch.serverId ? {
              serverId: patch.serverId, serverInstanceId: patch.serverInstanceId,
            } : {}),
          };
          if (Object.keys(patch).length === 0) return null;
        }
        const patched: TerminalRecord = { ...list[idx]!, ...patch, updatedAt: Date.now() };
        // `undefined` in a patch clears the field on disk too.
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete (patched as Record<string, unknown>)[k];
        }
        list[idx] = patched;
        return patched;
      });
      if (!next) return null;
      if (next.closePending) await this.writeStateNow(loc.key, this.getCached(loc.key) ?? []);
      this.emit({ type: 'upsert', projectPath: next.projectPath, record: { ...next } });
      return { ...next };
    });
  }

  // Persist intent BEFORE abort/kill IO. Unlike end('closed'), this keeps the
  // identity needed by a later DELETE, and emits no premature removal event.
  async requestClose(id: string, projectPath?: string): Promise<TerminalRecord | null> {
    const loc = await this.locate(id, projectPath);
    if (!loc) return null;
    return this.runProjectWrite(loc.key, async () => {
      const next = this.writeRecordList(loc.key, id, (list, idx) => {
        const record = list[idx]!;
        const now = Date.now();
        const at = record.closePending ? record.ended!.at : now;
        list[idx] = { ...record, closePending: true, ended: { reason: 'closed', at }, updatedAt: now };
        return list[idx]!;
      });
      if (!next) return null;
      // Let errors propagate: a best-effort flush is insufficient for close
      // ownership. The cache still blocks restore, and persistence can retry.
      await this.writeStateNow(loc.key, this.getCached(loc.key) ?? []);
      this.emit({ type: 'upsert', projectPath: next.projectPath, record: { ...next } });
      return { ...next };
    });
  }

  // Mark a record ended. Reasons that mean "gone for good" remove the record;
  // restore failures keep it (with the marker) so the UI can show the reason.
  async end(id: string, ended: Omit<TerminalEnded, 'at'> & { at?: number }, projectPath?: string): Promise<boolean> {
    const loc = await this.locate(id, projectPath);
    if (!loc) return false;
    return this.runProjectWrite(loc.key, () => {
      const done = this.writeRecordList(loc.key, id, (list, idx) => {
        const record = list[idx]!;
        // Only a confirmed close may discard pending ownership. A stale
        // restore failure / owner cleanup must not turn it into a lost PTY.
        if (record.closePending && ended.reason !== 'closed') return null;
        // Re-ending an already-ended record for the same reason keeps its
        // original timestamp, so the retention prune still counts from the
        // FIRST failure rather than restarting on every retry.
        const at = ended.at
          ?? (record.ended?.reason === ended.reason ? record.ended.at : Date.now());
        const full: TerminalEnded = { ...ended, at };
        const keep = full.reason === 'cwd-missing' || full.reason === 'restore-failed';
        if (keep) {
          list[idx] = { ...record, ended: full, serverId: undefined, updatedAt: full.at };
          delete list[idx]!.serverId;
        } else {
          list.splice(idx, 1);
        }
        return { record, full, keep };
      });
      if (!done) return false;
      const { record, full, keep } = done;
      this.emit({
        type: 'ended',
        projectPath: record.projectPath,
        id,
        ended: full,
        ...(record.agentSession?.id ? { agentSessionId: record.agentSession.id } : {}),
      });
      if (!keep) this.emit({ type: 'removed', projectPath: record.projectPath, id });
      return true;
    });
  }

  async remove(id: string, projectPath?: string): Promise<boolean> {
    const loc = await this.locate(id, projectPath);
    if (!loc) return false;
    return this.runProjectWrite(loc.key, () => {
      const record = this.writeRecordList(loc.key, id, (list, idx) => list.splice(idx, 1)[0]!);
      if (!record) return false;
      this.emit({ type: 'removed', projectPath: record.projectPath, id });
      return true;
    });
  }

  // End every LOADED record matching `predicate`. Used by the pty-kill paths
  // (worktree teardown, run cleanup) and the exit watcher, which only ever
  // reason about ptys of projects already loaded in this process.
  async endWhere(
    predicate: (record: TerminalRecord) => boolean,
    ended: Omit<TerminalEnded, 'at'>,
  ): Promise<number> {
    const targets = this.loadedRecords().filter(({ record }) => !record.ended && predicate(record));
    let n = 0;
    for (const { projectKey, record } of targets) {
      if (await this.end(record.id, ended, projectKey)) n += 1;
    }
    return n;
  }

  async reorder(projectPath: string, ids: string[]): Promise<TerminalRecord[]> {
    const key = await this.loadIfNeeded(projectPath);
    return this.runProjectWrite(key, () => {
      const records = this.getCached(key) ?? [];
      const rank = new Map(ids.map((id, i) => [id, i]));
      // Unlisted records keep their relative order after the listed ones —
      // the UI only knows about its own project's visible tabs.
      const sorted = [...records].sort((a, b) => {
        const ra = rank.get(a.id);
        const rb = rank.get(b.id);
        if (ra !== undefined && rb !== undefined) return ra - rb;
        if (ra !== undefined) return -1;
        if (rb !== undefined) return 1;
        return a.order - b.order || a.createdAt - b.createdAt;
      });
      let changed = false;
      const next = sorted.map((r, i) => {
        if (r.order === i) return r;
        changed = true;
        return { ...r, order: i };
      });
      if (changed) {
        this.setCached(key, next);
        this.schedulePersist(key);
      }
      return next.map((r) => ({ ...r }));
    });
  }

  // Record busy transitions from the terminal-activity signal (`busyServerIds`
  // is the machine-wide set of working agent ptys). Persisted only on change,
  // so an idle board costs no writes.
  async noteBusy(busyServerIds: ReadonlySet<string>, now = Date.now()): Promise<void> {
    for (const { projectKey, record } of this.loadedRecords()) {
      if (record.ended || !record.serverId) continue;
      const busy = busyServerIds.has(record.serverId);
      if (record.lastBusy?.busy === busy) continue;
      await this.runProjectWrite(projectKey, () => {
        this.writeRecordList(projectKey, record.id, (list, idx) => {
          // The verdict is about the pty the snapshot named. A record relaunched
          // onto a new pty (or ended) since then must not inherit it — a
          // relaunch clears `lastBusy` precisely so the dead pty's state can't
          // leak into the interruption verdict for the new one.
          const cur = list[idx]!;
          if (cur.ended || cur.serverId !== record.serverId) return null;
          list[idx] = { ...cur, lastBusy: { busy, at: now } };
          return true;
        });
      });
    }
  }

  async flushAll(): Promise<void> {
    for (const [key] of this.cacheEntries()) await this.flushPersist(key);
  }
}

export const terminalRegistry = new TerminalRegistryStore();

export function subscribeTerminalRegistry(fn: TerminalRegistrySubscriber): () => void {
  return terminalRegistry.subscribe(fn);
}
