// Local dispositions are presentation policy, never scanner exclusions. Keep
// their audit trail outside the checkout and refuse to overwrite corrupt state.
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../fsAtomic.js';
import { runExclusive } from '../serializeWrites.js';
import { canonicalProjectPath, homeProjectDir } from '../projectPath.js';
import { fingerprintMatches, ruleMatches, type OpengrepFinding, type ParsedOpengrepOutput } from './parseOutput.js';
import type { DigestFilter } from './digest.js';

export type FindingDisposition = {
  status: 'open' | 'ignored' | 'deferred';
  scope: 'local' | 'settings' | 'source';
  reason: string;
  updatedAt: number;
  owner?: string;
  reviewAt?: string;
  expired?: boolean;
};
export type TriageEvent = FindingDisposition & { fingerprint: string; path: string; ruleId: string };
type TriageState = { version: 1; entries: Record<string, TriageEvent>; history: TriageEvent[] };
const empty = (): TriageState => ({ version: 1, entries: {}, history: [] });
export function findingKey(f: Pick<OpengrepFinding, 'fingerprint' | 'path'>): string { return `${f.path}\0${f.fingerprint}`; }
export function triageFile(project: string) { return path.join(homeProjectDir(project), 'opengrep-triage.json'); }
export async function readTriage(project: string): Promise<TriageState> {
  try {
    const state = JSON.parse(await fs.readFile(triageFile(project), 'utf8')) as TriageState;
    if (state.version !== 1 || !state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries) || !Array.isArray(state.history)) throw new Error('Invalid security triage state');
    for (const item of [...Object.values(state.entries), ...state.history]) {
      if (!item || !['open', 'ignored', 'deferred'].includes(item.status) || item.scope !== 'local' || typeof item.reason !== 'string' || typeof item.fingerprint !== 'string' || typeof item.path !== 'string' || typeof item.ruleId !== 'string' || !Number.isFinite(item.updatedAt)) throw new Error('Invalid security triage entry');
    }
    return state;
  } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw err; }
}
export function effectiveDisposition(entry: FindingDisposition, now = Date.now()): FindingDisposition {
  const expires = entry.reviewAt ? Date.parse(entry.reviewAt) : NaN;
  return entry.status !== 'open' && Number.isFinite(expires) && expires <= now ? { ...entry, status: 'open', expired: true } : entry;
}
export function validateDisposition(input: unknown): FindingDisposition {
  const value = input as Partial<FindingDisposition> | null;
  if (!value || !['open', 'ignored', 'deferred'].includes(value.status ?? '')) throw new Error('Choose open, ignored or deferred');
  const status = value.status as FindingDisposition['status'];
  const reason = typeof value.reason === 'string' ? value.reason.trim().slice(0, 4000) : '';
  const owner = typeof value.owner === 'string' ? value.owner.trim().slice(0, 200) : undefined;
  const reviewAt = typeof value.reviewAt === 'string' ? value.reviewAt : undefined;
  if (status !== 'open' && !reason) throw new Error('A reason is required');
  if (reviewAt && (!Number.isFinite(Date.parse(reviewAt)) || Date.parse(reviewAt) <= Date.now())) throw new Error('Choose a future review date');
  if (status === 'deferred' && (!owner || !reviewAt)) throw new Error('Deferred findings need an owner and future review date');
  return { status, scope: 'local', reason: reason || 'Reopened by user', owner, reviewAt, updatedAt: Date.now() };
}
export async function setFindingDisposition(project: string, finding: OpengrepFinding, input: unknown) {
  const canonical = canonicalProjectPath(project);
  const disposition = validateDisposition(input);
  return runExclusive(triageFile(canonical), async () => {
    const state = await readTriage(canonical);
    const event: TriageEvent = { ...disposition, fingerprint: finding.fingerprint, path: finding.path, ruleId: finding.ruleId };
    state.entries[findingKey(finding)] = event;
    state.history.push(event); state.history = state.history.slice(-10_000);
    await fs.mkdir(path.dirname(triageFile(canonical)), { recursive: true });
    await atomicWriteFile(triageFile(canonical), JSON.stringify(state, null, 2));
    return event;
  });
}
export async function withFindingTriage(project: string, parsed: ParsedOpengrepOutput, filter: DigestFilter): Promise<ParsedOpengrepOutput> {
  const state = await readTriage(project);
  return { ...parsed, findings: parsed.findings.map((f) => {
    let triage: FindingDisposition | undefined;
    if (f.nativeIgnored) triage = { status: 'ignored', scope: 'source', reason: 'Inline scanner suppression in source', updatedAt: 0 };
    else if (filter.ignoreRuleIds.some((r) => ruleMatches(f.ruleId, r)) || filter.ignoreFingerprints.some((fp) => fingerprintMatches(f.fingerprint, fp))) triage = { status: 'ignored', scope: 'settings', reason: 'Ignored in Settings → Tools (local to Lattice)', updatedAt: 0 };
    else { const entry = state.entries[findingKey(f)]; if (entry) triage = effectiveDisposition(entry); }
    return { ...f, triage: triage ?? { status: 'open', scope: 'local', reason: '', updatedAt: 0 } };
  }) };
}
