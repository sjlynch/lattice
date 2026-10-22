// One machine-wide picture for the Fleet view and `fleet` MCP tool: every
// project with something going on — live terminals, agents, runs, tasks in
// flight or touched in the last week — with its lanes, runs, agents and
// terminals. Pure over injected readers (tests drive it with fixtures).

import path from 'node:path';

import { canonicalProjectPath } from '../projectPath.js';
import type { AgentHarness } from '../shared/harnesses.js';
import type { FleetProject, FleetRun, FleetTerminal } from './types.js';

export const FLEET_RECENT_MS = 7 * 24 * 3600_000;
export const FLEET_MAX_PROJECTS = 40;
const LANES = ['backlog', 'open', 'in_progress', 'ready_to_merge', 'qa', 'done'] as const;

type TaskLike = {
  id: string; title: string; status: string; harness?: AgentHarness; model?: string; piModel?: string;
  createdAt?: number; updatedAt?: number; startedAt?: number; completedAt?: number; mergedAt?: number; doneAt?: number;
};
type PtyLike = {
  id?: unknown; cwd?: unknown; projectPath?: unknown; createdAt?: unknown; lastOutputAt?: unknown;
  lastTextOutputAt?: unknown; terminalTitle?: unknown; initialCommand?: unknown;
};
type RecordLike = { id: string; serverId?: string; label: string; owner?: string; taskId?: string; ended?: unknown; launch?: { harness?: AgentHarness } };

export type FleetSnapshotDeps = {
  knownProjects: () => Promise<string[]>;
  tasksOf: (project: string) => Promise<TaskLike[]>;
  workflowRuns: (project: string) => Array<{ id: string; workflowName: string; status: string; startedAt?: number; currentStepIndex?: number; totalSteps?: number }>;
  mergeRun: (project: string) => { id: string; status: string; startedAt?: number; processed: number; total: number } | null;
  agents: (project: string) => Array<{ agentId: string; label: string; harness?: AgentHarness; startedAt: number }>;
  ptys: () => Promise<unknown[] | null>;
  records: () => RecordLike[];
  busy: () => ReadonlySet<string>;
  harnessFor: (command: string | undefined) => AgentHarness | null;
  now: () => number;
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const taskActivity = (t: TaskLike) => Math.max(t.createdAt ?? 0, t.updatedAt ?? 0, t.startedAt ?? 0, t.completedAt ?? 0, t.mergedAt ?? 0, t.doneAt ?? 0);

export async function buildFleetProjects(deps: FleetSnapshotDeps): Promise<FleetProject[]> {
  const now = deps.now();
  const busy = deps.busy();
  const byServer = new Map<string, RecordLike>();
  for (const r of deps.records()) if (r.serverId && !r.ended) byServer.set(r.serverId, r);

  // Live ptys grouped by canonical project.
  const terminalsBy = new Map<string, FleetTerminal[]>();
  const displayPath = new Map<string, string>();
  for (const raw of (await deps.ptys().catch(() => null)) ?? []) {
    const p = raw as PtyLike;
    const id = str(p.id);
    const project = str(p.projectPath);
    if (!id || !project) continue;
    const key = canonicalProjectPath(project);
    displayPath.set(key, displayPath.get(key) ?? project);
    const rec = byServer.get(id);
    const command = str(p.initialCommand);
    const harness = rec?.launch?.harness ?? deps.harnessFor(command) ?? undefined;
    const label = rec?.label || str(p.terminalTitle) || (harness ?? path.basename(str(p.cwd) ?? '') ?? 'terminal');
    const list = terminalsBy.get(key) ?? [];
    list.push({
      id,
      ...(rec ? { tabId: rec.id } : {}),
      label,
      ...(rec?.owner ? { owner: rec.owner } : {}),
      ...(harness ? { harness } : {}),
      ...(rec?.taskId ? { taskId: rec.taskId } : {}),
      busy: busy.has(id),
      createdAt: num(p.createdAt) ?? 0,
      ...(num(p.lastTextOutputAt) ?? num(p.lastOutputAt) ? { lastOutputAt: num(p.lastTextOutputAt) ?? num(p.lastOutputAt) } : {}),
    });
    terminalsBy.set(key, list);
  }

  const candidates = new Map<string, string>();
  for (const p of await deps.knownProjects().catch(() => [] as string[])) candidates.set(canonicalProjectPath(p), p);
  for (const [key, p] of displayPath) if (!candidates.has(key)) candidates.set(key, p);

  const out: FleetProject[] = [];
  for (const [key, shown] of candidates) {
    const tasks = await deps.tasksOf(shown).catch(() => [] as TaskLike[]);
    const lanes: Record<string, number> = Object.fromEntries(LANES.map((l) => [l, 0]));
    let lastTask = 0;
    for (const t of tasks) {
      if (t.status in lanes) lanes[t.status]++;
      if (t.status !== 'deleted') lastTask = Math.max(lastTask, taskActivity(t));
    }
    const runs: FleetRun[] = deps.workflowRuns(shown).map((r) => ({
      id: r.id, kind: 'workflow' as const,
      label: r.totalSteps ? `${r.workflowName} · step ${Math.min((r.currentStepIndex ?? 0) + 1, r.totalSteps)}/${r.totalSteps}` : r.workflowName,
      status: r.status, ...(r.startedAt ? { startedAt: r.startedAt } : {}),
    }));
    const merge = deps.mergeRun(shown);
    if (merge) runs.push({ id: merge.id, kind: 'merge', label: `Merge run · ${merge.processed}/${merge.total}`, status: merge.status, ...(merge.startedAt ? { startedAt: merge.startedAt } : {}) });
    const agents = deps.agents(shown).map((a) => ({ agentId: a.agentId, label: a.label, ...(a.harness ? { harness: a.harness } : {}), startedAt: a.startedAt }));
    const terminals = (terminalsBy.get(key) ?? []).sort((a, b) => a.createdAt - b.createdAt);
    const inFlight = lanes.in_progress + lanes.ready_to_merge + lanes.qa;
    const lastActivityAt = Math.max(lastTask, ...terminals.map((t) => t.lastOutputAt ?? t.createdAt), ...runs.map((r) => r.startedAt ?? 0), ...agents.map((a) => a.startedAt));
    const live = terminals.length > 0 || agents.length > 0 || runs.length > 0 || inFlight > 0;
    if (!live && now - lastTask > FLEET_RECENT_MS) continue;
    out.push({
      path: displayPath.get(key) ?? shown,
      name: path.basename(shown.replace(/[\\/]+$/, '')) || shown,
      lanes,
      inProgress: tasks
        .filter((t) => t.status === 'in_progress')
        .sort((a, b) => taskActivity(b) - taskActivity(a))
        .slice(0, 12)
        .map((t) => ({ id: t.id, title: t.title, status: t.status, ...(t.harness ? { harness: t.harness } : {}), ...(t.model || t.piModel ? { model: t.model ?? t.piModel } : {}) })),
      runs,
      agents,
      terminals,
      lastActivityAt,
    });
  }
  const liveScore = (p: FleetProject) => p.terminals.filter((t) => t.busy).length + p.agents.length + p.runs.length + p.lanes.in_progress;
  return out
    .sort((a, b) => (liveScore(b) > 0 ? 1 : 0) - (liveScore(a) > 0 ? 1 : 0) || b.lastActivityAt - a.lastActivityAt)
    .slice(0, FLEET_MAX_PROJECTS);
}
