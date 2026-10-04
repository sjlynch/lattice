import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../claudeTrust/configFile.js';
import { homeProjectDir } from '../projectPath.js';
import { canonicalProjectPath } from '../projectPath.js';
import { runExclusive } from '../serializeWrites.js';
import type { AgentHarness } from '../harnesses.js';
import type { OpengrepFinding } from './parseOutput.js';
import type { ScanInputs } from './scanCache.js';

export type Recommendation = {
  findingId: string;
  action: 'fix' | 'suppress' | 'defer' | 'needs-review';
  rationale: string;
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
  proposedChange: string;
  checks: string[];
  assumptions: string[];
  contextFiles: string[];
  group: string;
  owner?: string;
  reviewAt?: string;
  stale?: boolean;
  applied?: { taskId?: string; at: number; action: string };
};
export type ReviewRun = {
  id: string; project: string; scanId: string; harness: AgentHarness; piModel?: string;
  status: 'running' | 'done' | 'failed' | 'cancelled'; createdAt: number; finishedAt?: number;
  serverId?: string; terminalId?: string; error?: string;
  findings: OpengrepFinding[]; inputs: ScanInputs; targets: string[]; recommendations: Recommendation[];
};
type Store = { version: 1; runs: ReviewRun[] };
const fileFor = (project: string) => path.join(homeProjectDir(project), 'opengrep-reviews.json');
export async function readReviewStore(project: string): Promise<Store> {
  try {
    const value = JSON.parse(await fs.readFile(fileFor(project), 'utf8')) as Store;
    if (value.version !== 1 || !Array.isArray(value.runs) || value.runs.some((r) => !r || typeof r.id !== 'string' || !/^sreview_\d+_[0-9a-f]+$/.test(r.id) || typeof r.project !== 'string' || canonicalProjectPath(r.project) !== canonicalProjectPath(project) || !Number.isFinite(r.createdAt) || !['claude', 'codex', 'pi'].includes(r.harness) || !Array.isArray(r.targets) || r.targets.some((p) => typeof p !== 'string') || !Array.isArray(r.findings) || !Array.isArray(r.recommendations) || !r.inputs?.files || typeof r.inputs.files !== 'object' || Array.isArray(r.inputs.files) || Object.values(r.inputs.files).some((s) => typeof s !== 'string') || typeof r.inputs.configuration !== 'string' || !['running', 'done', 'failed', 'cancelled'].includes(r.status))) throw new Error('Invalid security review store');
    for (const run of value.runs) {
      if (run.findings.some((f) => !f || typeof f.fingerprint !== 'string' || typeof f.path !== 'string' || typeof f.ruleId !== 'string' || !Number.isFinite(f.line) || typeof f.snippet !== 'string' || !Array.isArray(f.cwe) || !Array.isArray(f.references))) throw new Error('Invalid security review finding');
      validateRecommendations({ recommendations: run.recommendations }, run);
    }
    return value;
  } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, runs: [] }; throw err; }
}
export function updateReviewStore<T>(project: string, update: (store: Store) => T | Promise<T>) {
  return runExclusive(fileFor(project), async () => {
    const store = await readReviewStore(project);
    const value = await update(store);
    // Never evict a live run. Reports are durable even after their scans prune.
    const finished = store.runs.filter((r) => r.status !== 'running').sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
    store.runs = [...store.runs.filter((r) => r.status === 'running'), ...finished];
    await fs.mkdir(path.dirname(fileFor(project)), { recursive: true });
    await atomicWriteFile(fileFor(project), JSON.stringify(store, null, 2));
    return value;
  });
}
const text = (x: unknown, limit = 8000): string => typeof x === 'string' ? x.trim().slice(0, limit) : '';
const strings = (x: unknown): string[] => Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string').slice(0, 80).map((s) => s.slice(0, 2000)) : [];
export function validateRecommendations(raw: unknown, run: Pick<ReviewRun, 'findings' | 'inputs'>): Recommendation[] {
  const list = (raw as { recommendations?: unknown } | null)?.recommendations;
  if (!Array.isArray(list) || list.length > run.findings.length) throw new Error('Report must contain a recommendations array, at most one per finding');
  const byId = new Map(run.findings.map((f) => [f.fingerprint, f]));
  const seen = new Set<string>();
  const result: Recommendation[] = [];
  for (const item of list) {
    const r = item as Partial<Recommendation> | null;
    if (!r || !byId.has(r.findingId ?? '') || seen.has(r.findingId!) || !['fix', 'suppress', 'defer', 'needs-review'].includes(r.action ?? '') || !['high', 'medium', 'low'].includes(r.confidence ?? '') || !text(r.rationale) || !text(r.evidence)) throw new Error('Recommendation has an unknown/duplicate finding, invalid action/confidence, or missing rationale/evidence');
    if (r.contextFiles !== undefined && (!Array.isArray(r.contextFiles) || r.contextFiles.length > 4096 || r.contextFiles.some((p) => typeof p !== 'string'))) throw new Error('Invalid recommendation context files');
    const contextFiles = [...new Set(r.contextFiles ?? [])];
    if (contextFiles.some((p) => !Object.hasOwn(run.inputs.files, p))) throw new Error('Recommendation context must use scanned project-relative files');
    const proposedChange = text(r.proposedChange);
    const checks = strings(r.checks);
    if (r.action === 'fix' && (!proposedChange || !checks.length)) throw new Error('Fix recommendations need a proposed change and validation checks');
    seen.add(r.findingId!);
    result.push({ findingId: r.findingId!, action: r.action!, confidence: r.confidence!, rationale: text(r.rationale), evidence: text(r.evidence), proposedChange, checks, assumptions: strings(r.assumptions), contextFiles, group: text(r.group, 160) || byId.get(r.findingId!)!.path, owner: text(r.owner, 200) || undefined, reviewAt: text(r.reviewAt, 80) || undefined });
  }
  for (const f of run.findings) if (!seen.has(f.fingerprint)) result.push({ findingId: f.fingerprint, action: 'needs-review', confidence: 'low', rationale: 'The agent did not return a recommendation for this finding.', evidence: `${f.path}:${f.line}`, proposedChange: '', checks: [], assumptions: [], contextFiles: [], group: f.path });
  return result;
}
export function recommendationIsStale(r: Recommendation, run: Pick<ReviewRun, 'findings' | 'inputs'>, current: ScanInputs | null, byId?: ReadonlyMap<string, OpengrepFinding>) {
  const finding = byId ? byId.get(r.findingId) : run.findings.find((f) => f.fingerprint === r.findingId);
  return !current || !finding || current.configuration !== run.inputs.configuration ||
    [finding.path, ...r.contextFiles].some((p) => !run.inputs.files[p] || run.inputs.files[p] !== current.files[p]);
}
export function publicReview(run: ReviewRun, current: ScanInputs | null) {
  const { inputs: _inputs, ...publicRun } = run;
  const byId = new Map(run.findings.map((f) => [f.fingerprint, f]));
  return { ...publicRun, recommendations: run.recommendations.map((r) => ({ ...r, stale: recommendationIsStale(r, run, current, byId) })) };
}
