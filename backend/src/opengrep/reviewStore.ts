import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../claudeTrust/configFile.js';
import { canonicalProjectPath, homeProjectDir } from '../projectPath.js';
import { runExclusive } from '../serializeWrites.js';
import type { AgentHarness } from '../harnesses.js';

// Conversation content belongs to the harness, not a second report in Lattice.
export type ReviewRun = {
  id: string; project: string; scanId: string; harness: AgentHarness; piModel?: string;
  status: 'running' | 'awaiting-decision' | 'closed' | 'failed' | 'cancelled';
  createdAt: number; updatedAt: number; lastTurnAt?: number; finishedAt?: number;
  findingCount: number; serverId?: string; terminalId?: string; error?: string;
};
type Store = { version: 1; runs: ReviewRun[] };
export const reviewStoreFile = (project: string) => path.join(homeProjectDir(project), 'opengrep-review-sessions.json');
export const isActiveReview = (run: Pick<ReviewRun, 'status'>) => run.status === 'running' || run.status === 'awaiting-decision';

function metadata(raw: unknown, project: string): ReviewRun {
  const r = raw as ReviewRun | null;
  if (!r || typeof r.id !== 'string' || !/^sreview_\d+_[0-9a-f]+$/.test(r.id) || typeof r.project !== 'string'
    || canonicalProjectPath(r.project) !== canonicalProjectPath(project) || typeof r.scanId !== 'string'
    || !Number.isFinite(r.createdAt) || !Number.isFinite(r.updatedAt)
    || !Number.isInteger(r.findingCount) || r.findingCount < 0
    || !['claude', 'codex', 'pi'].includes(r.harness)
    || !['running', 'awaiting-decision', 'closed', 'failed', 'cancelled'].includes(r.status)) throw new Error('Invalid security review session store');
  for (const key of ['lastTurnAt', 'finishedAt'] as const) if (r[key] !== undefined && !Number.isFinite(r[key])) throw new Error('Invalid security review timestamp');
  for (const key of ['piModel', 'serverId', 'terminalId', 'error'] as const) if (r[key] !== undefined && typeof r[key] !== 'string') throw new Error('Invalid security review metadata');
  // Whitelist fields on both read and write; never persist report payloads.
  return { id: r.id, project: canonicalProjectPath(project), scanId: r.scanId, harness: r.harness,
    piModel: r.piModel, status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt,
    lastTurnAt: r.lastTurnAt, finishedAt: r.finishedAt, findingCount: r.findingCount,
    serverId: r.serverId, terminalId: r.terminalId, error: r.error };
}
export async function readReviewStore(project: string): Promise<Store> {
  try {
    const value = JSON.parse(await fs.readFile(reviewStoreFile(project), 'utf8')) as Store;
    if (value.version !== 1 || !Array.isArray(value.runs)) throw new Error('Invalid security review session store');
    return { version: 1, runs: value.runs.map((r) => metadata(r, project)) };
  } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, runs: [] }; throw err; }
}
export function updateReviewStore<T>(project: string, update: (store: Store) => T | Promise<T>) {
  return runExclusive(reviewStoreFile(project), async () => {
    const store = await readReviewStore(project);
    const value = await update(store);
    const ended = store.runs.filter((r) => !isActiveReview(r)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
    store.runs = [...store.runs.filter(isActiveReview), ...ended].map((r) => metadata(r, project));
    await fs.mkdir(path.dirname(reviewStoreFile(project)), { recursive: true });
    await atomicWriteFile(reviewStoreFile(project), JSON.stringify(store, null, 2));
    return value;
  });
}
