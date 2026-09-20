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
// once the cause is fixed; those are pruned after ENDED_RETENTION_MS.

import { randomUUID } from 'node:crypto';
import { ProjectStateManager } from '../projectStateManager.js';
import { homeProjectScratchDir } from '../projectPath.js';
import { listKnownProjects as listKnownTaskProjects } from '../tasks.js';
import { isAgentHarness } from '../harnesses.js';
import type {
  RestoreSummary,
  TerminalEndReason,
  TerminalEnded,
  TerminalOwner,
  TerminalRecord,
  TerminalRegistryEvent,
} from './types.js';

export const TERMINALS_FILENAME = 'terminals.json';
const FILE_VERSION = 1;
const ENDED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const OWNERS: ReadonlySet<string> = new Set<TerminalOwner>([
  'user', 'task', 'merge', 'startup', 'workflow-step', 'push', 'qa',
  'post-merge', 'prompt-customization',
]);
const END_REASONS: ReadonlySet<string> = new Set<TerminalEndReason>([
  'exit', 'closed', 'killed', 'owner-finished', 'cwd-missing', 'restore-failed',
]);

export function terminalsFile(projectPath: string): string {
  return homeProjectScratchDir(projectPath, TERMINALS_FILENAME);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// Every field is re-validated: the file is untrusted input (a crash mid-write,
// a hand edit). A record missing anything load-bearing is dropped, not
// "repaired" into a tab that would relaunch the wrong thing.
export function deserializeTerminalRecord(raw: unknown): TerminalRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const projectPath = str(r.projectPath);
  const cwd = str(r.cwd);
  const owner = str(r.owner);
  if (!id || !projectPath || !cwd || !owner || !OWNERS.has(owner)) return null;
  const launchRaw = (r.launch && typeof r.launch === 'object' ? r.launch : {}) as Record<string, unknown>;
  const launch: TerminalRecord['launch'] = {};
  if (str(launchRaw.initialCommand)) launch.initialCommand = launchRaw.initialCommand as string;
  if (isAgentHarness(launchRaw.harness)) launch.harness = launchRaw.harness;
  if (str(launchRaw.piModel)) launch.piModel = launchRaw.piModel as string;
  if (launchRaw.isQaRun === true) launch.isQaRun = true;
  if (str(launchRaw.taskId)) launch.taskId = launchRaw.taskId as string;
  const record: TerminalRecord = {
    id,
    projectPath,
    cwd,
    label: str(r.label) ?? id,
    order: num(r.order) ?? 0,
    owner: owner as TerminalOwner,
    launch,
    createdAt: num(r.createdAt) ?? Date.now(),
    updatedAt: num(r.updatedAt) ?? Date.now(),
  };
  if (r.kind === 'merge' || r.kind === 'startup') record.kind = r.kind;
  if (str(r.taskId)) record.taskId = r.taskId as string;
  if (str(r.startupId)) record.startupId = r.startupId as string;
  if (str(r.serverId)) record.serverId = r.serverId as string;
  if (str(r.serverInstanceId)) record.serverInstanceId = r.serverInstanceId as string;
  if (num(r.restoreCount) !== undefined) record.restoreCount = r.restoreCount as number;
  if (num(r.restoredAt) !== undefined) record.restoredAt = r.restoredAt as number;
  const as = r.agentSession as Record<string, unknown> | undefined;
  if (as && typeof as === 'object' && isAgentHarness(as.harness) && str(as.id)) {
    record.agentSession = {
      harness: as.harness,
      id: as.id as string,
      source: as.source === 'rollout-scan' ? 'rollout-scan' : 'minted',
      ...(as.ambiguous === true ? { ambiguous: true } : {}),
    };
  }
  const lb = r.lastBusy as Record<string, unknown> | undefined;
  if (lb && typeof lb === 'object' && typeof lb.busy === 'boolean' && num(lb.at) !== undefined) {
    record.lastBusy = { busy: lb.busy, at: lb.at as number };
  }
  const ended = r.ended as Record<string, unknown> | undefined;
  if (ended && typeof ended === 'object' && str(ended.reason) && END_REASONS.has(ended.reason as string)) {
    record.ended = {
      at: num(ended.at) ?? Date.now(),
      reason: ended.reason as TerminalEndReason,
      ...(num(ended.exitCode) !== undefined ? { exitCode: ended.exitCode as number } : {}),
      ...(str(ended.detail) ? { detail: ended.detail as string } : {}),
    };
  }
  return record;
}

export function deserializeTerminalRecords(raw: unknown): TerminalRecord[] | null {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { terminals?: unknown }).terminals)
      ? (raw as { terminals: unknown[] }).terminals
      : null;
  if (!list) return null;
  const now = Date.now();
  const out: TerminalRecord[] = [];
  for (const item of list) {
    const rec = deserializeTerminalRecord(item);
    if (!rec) continue;
    // Prune long-ended leftovers so the file can't grow forever.
    if (rec.ended && now - rec.ended.at > ENDED_RETENTION_MS) continue;
    out.push(rec);
  }
  return out.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
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
    this.emit({ type: 'restored', projectPath: record.projectPath, record: { ...record }, mode });
  }

  emitRestoreFailed(record: TerminalRecord, reason: string): void {
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

  // Every non-ended record across every project loaded in this process (the
  // exit watcher's working set).
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

  async update(
    id: string,
    patch: Partial<Omit<TerminalRecord, 'id' | 'projectPath' | 'createdAt'>>,
    projectPath?: string,
  ): Promise<TerminalRecord | null> {
    const loc = await this.locate(id, projectPath);
    if (!loc) return null;
    return this.runProjectWrite(loc.key, () => {
      const records = this.getCached(loc.key) ?? [];
      const idx = records.findIndex((r) => r.id === id);
      if (idx < 0) return null;
      const next: TerminalRecord = { ...records[idx]!, ...patch, updatedAt: Date.now() };
      // `undefined` in a patch clears the field on disk too.
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete (next as Record<string, unknown>)[k];
      }
      const list = [...records];
      list[idx] = next;
      this.setCached(loc.key, list);
      this.schedulePersist(loc.key);
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
      const records = this.getCached(loc.key) ?? [];
      const idx = records.findIndex((r) => r.id === id);
      if (idx < 0) return false;
      const record = records[idx]!;
      // Re-ending an already-ended record for the same reason keeps its
      // original timestamp, so the retention prune still counts from the
      // FIRST failure rather than restarting on every retry.
      const at = ended.at
        ?? (record.ended?.reason === ended.reason ? record.ended.at : Date.now());
      const full: TerminalEnded = { ...ended, at };
      const keep = full.reason === 'cwd-missing' || full.reason === 'restore-failed';
      const list = [...records];
      if (keep) {
        list[idx] = { ...record, ended: full, serverId: undefined, updatedAt: full.at };
        delete list[idx]!.serverId;
      } else {
        list.splice(idx, 1);
      }
      this.setCached(loc.key, list);
      this.schedulePersist(loc.key);
      this.emit({ type: 'ended', projectPath: record.projectPath, id, ended: full });
      if (!keep) this.emit({ type: 'removed', projectPath: record.projectPath, id });
      return true;
    });
  }

  async remove(id: string, projectPath?: string): Promise<boolean> {
    const loc = await this.locate(id, projectPath);
    if (!loc) return false;
    return this.runProjectWrite(loc.key, () => {
      const records = this.getCached(loc.key) ?? [];
      const idx = records.findIndex((r) => r.id === id);
      if (idx < 0) return false;
      const record = records[idx]!;
      const list = [...records];
      list.splice(idx, 1);
      this.setCached(loc.key, list);
      this.schedulePersist(loc.key);
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
        const records = this.getCached(projectKey) ?? [];
        const idx = records.findIndex((r) => r.id === record.id);
        if (idx < 0) return;
        const list = [...records];
        list[idx] = { ...list[idx]!, lastBusy: { busy, at: now } };
        this.setCached(projectKey, list);
        this.schedulePersist(projectKey);
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
