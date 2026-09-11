import { canonicalProjectPath } from '../projectPath.js';
import { matchesStoredProjectIdentity } from '../projectIdentity.js';
import type {
  MergeRun,
  MergeRunErrorEntry,
  MergeRunStatus,
} from './types.js';

function normalizeStatus(status: unknown): MergeRunStatus {
  return status === 'completed' || status === 'cancelled' || status === 'errored'
    ? status
    : 'errored';
}

export function normalizeLoadedRuns(raw: unknown, projectPath: string): MergeRun[] {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  const runs: MergeRun[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<MergeRun>;
    if (typeof candidate.id !== 'string' || !candidate.id) continue;
    if (typeof candidate.startedAt !== 'number') continue;
    if (candidate.projectPath !== undefined &&
        (typeof candidate.projectPath !== 'string' || !matchesStoredProjectIdentity(candidate.projectPath, projectPath))) continue;
    const status = normalizeStatus(candidate.status);
    const run: MergeRun = {
      id: candidate.id,
      projectPath: canonicalProjectPath(projectPath),
      status,
      startedAt: candidate.startedAt,
      finishedAt:
        typeof candidate.finishedAt === 'number'
          ? candidate.finishedAt
          : status === 'errored'
            ? now
            : undefined,
      total: typeof candidate.total === 'number' ? candidate.total : 0,
      processed: typeof candidate.processed === 'number' ? candidate.processed : 0,
      current: typeof candidate.current === 'string' ? candidate.current : undefined,
      merged: Array.isArray(candidate.merged)
        ? candidate.merged.filter((id): id is string => typeof id === 'string')
        : [],
      conflicted: Array.isArray(candidate.conflicted)
        ? candidate.conflicted.filter((id): id is string => typeof id === 'string')
        : [],
      errored: Array.isArray(candidate.errored)
        ? candidate.errored
            .filter(
              (e): e is MergeRunErrorEntry =>
                !!e &&
                typeof e === 'object' &&
                typeof (e as MergeRunErrorEntry).taskId === 'string' &&
                typeof (e as MergeRunErrorEntry).error === 'string',
            )
            .map((e) => ({ ...e }))
        : [],
      cancelRequested: !!candidate.cancelRequested || status !== candidate.status,
    };
    if (status === 'errored' && candidate.status === 'running') {
      run.current = undefined;
      run.errored.push({
        taskId: '(run)',
        error: 'merge run was interrupted by backend restart',
      });
    }
    if (candidate.resolvers && typeof candidate.resolvers === 'object') {
      run.resolvers = Object.fromEntries(Object.entries(candidate.resolvers).filter(([, r]) =>
        r && typeof r.sessionId === 'string' && Number.isFinite(r.lastProgressAt)).map(([id, r]) => [id, { ...r }]));
    }
    runs.push(run);
  }
  return runs;
}
