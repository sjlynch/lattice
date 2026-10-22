// The Fleet activity log: one bounded, machine-wide feed of what happened in
// every project — task lane moves, agents starting on tasks, workflow and
// merge runs, agent sessions coming and going, terminals opening and closing.
// Built by listening to the per-project event sources that already exist
// (nothing new is emitted anywhere); read by GET /api/fleet with a `since`
// cursor. In memory only: a restart starts a fresh feed.

import { canonicalProjectPath } from '../projectPath.js';
import { subscribe as subscribeTasks, type Task } from '../tasks.js';
import { subscribeTaskSpawned } from '../taskSpawnEvents.js';
import { subscribe as subscribeWorkflowRuns } from '../workflowRuns.js';
import { subscribe as subscribeMergeRuns } from '../mergeRuns.js';
import { subscribeAgentSessions, type AgentSession } from '../agentSessions.js';
import { subscribeTerminalRegistry } from '../terminalRegistry.js';
import { registerMemGauge } from '../memDiag/gauges.js';
import type { FleetEvent, FleetEventKind } from './types.js';

export const FLEET_EVENT_CAP = 500;

export type FleetEventLog = {
  push: (projectPath: string, kind: FleetEventKind, text: string, ref?: string, at?: number) => void;
  since: (seq: number, limit?: number) => FleetEvent[];
  seq: () => number;
};

export function createFleetEventLog(cap = FLEET_EVENT_CAP, now: () => number = Date.now): FleetEventLog {
  const events: FleetEvent[] = [];
  let seq = 0;
  return {
    push(projectPath, kind, text, ref, at) {
      events.push({ seq: ++seq, at: at ?? now(), projectPath: canonicalProjectPath(projectPath), kind, text, ...(ref ? { ref } : {}) });
      if (events.length > cap) events.splice(0, events.length - cap);
    },
    // Events after `seq`, oldest first; the newest `limit` when more.
    since(after, limit = 200) {
      const out = events.filter((e) => e.seq > after);
      return out.length > limit ? out.slice(out.length - limit) : out;
    },
    seq: () => seq,
  };
}

const LANE_LABEL: Record<string, string> = {
  backlog: 'Backlog', open: 'Open', in_progress: 'In progress', ready_to_merge: 'Ready to merge',
  qa: 'QA', done: 'Done', deleted: 'Deleted',
};
const lane = (s: string) => LANE_LABEL[s] ?? s;
const quote = (s: string) => `“${s.length > 80 ? `${s.slice(0, 79)}…` : s}”`;

// Turns the existing per-project feeds into log entries. Task boards are
// diffed against the last status seen per task; a board's first snapshot only
// seeds that map (a boot or first load is not "activity").
export function wireFleetEvents(log: FleetEventLog): () => void {
  const statuses = new Map<string, Map<string, string>>();
  const sessions = new Map<string, Map<string, AgentSession>>();
  const terminals = new Map<string, string>();
  registerMemGauge('fleet.taskStatuses', () => [...statuses.values()].reduce((n, m) => n + m.size, 0));
  registerMemGauge('fleet.terminalLabels', () => terminals.size);

  const offs = [
    subscribeTasks((projectPath: string, tasks: Task[]) => {
      const key = canonicalProjectPath(projectPath);
      const prev = statuses.get(key);
      const next = new Map(tasks.map((t) => [t.id, t.status as string]));
      statuses.set(key, next);
      if (!prev) return;
      for (const t of tasks) {
        const was = prev.get(t.id);
        if (was === undefined) log.push(key, 'task', `New task ${quote(t.title)} in ${lane(t.status)}`, t.id);
        else if (was !== t.status) log.push(key, 'task', `${quote(t.title)}: ${lane(was)} → ${lane(t.status)}`, t.id);
      }
    }),
    subscribeTaskSpawned((ev) => {
      log.push(ev.projectPath, 'task-run', `Agent started on ${quote(ev.title)}`, ev.taskId);
    }),
    subscribeWorkflowRuns((ev) => {
      if (!('run' in ev)) return;
      const r = ev.run;
      const name = quote(r.workflowName);
      if (ev.type === 'started') log.push(r.projectPath, 'workflow', `Workflow ${name} started`, r.id);
      else if (ev.type === 'completed') log.push(r.projectPath, 'workflow', `Workflow ${name} finished`, r.id);
      else if (ev.type === 'errored') log.push(r.projectPath, 'workflow', `Workflow ${name} failed${r.error ? `: ${r.error.slice(0, 120)}` : ''}`, r.id);
      else if (ev.type === 'cancelled') log.push(r.projectPath, 'workflow', `Workflow ${name} cancelled`, r.id);
    }),
    subscribeMergeRuns((ev) => {
      if (ev.type === 'conflict') { log.push(ev.projectPath, 'merge', 'Merge conflict: a resolver agent is working on it', ev.taskId); return; }
      if (!('run' in ev)) return;
      const r = ev.run;
      if (ev.type === 'started') log.push(r.projectPath, 'merge', `Merge run started (${r.total} task${r.total === 1 ? '' : 's'})`, r.id);
      else if (ev.type === 'completed') log.push(r.projectPath, 'merge', `Merge run finished: ${r.merged.length} merged${r.conflicted.length ? `, ${r.conflicted.length} conflicted` : ''}${r.errored.length ? `, ${r.errored.length} failed` : ''}`, r.id);
      else if (ev.type === 'cancelled') log.push(r.projectPath, 'merge', 'Merge run cancelled', r.id);
    }),
    subscribeAgentSessions((projectPath, list) => {
      const key = canonicalProjectPath(projectPath);
      const prev = sessions.get(key) ?? new Map<string, AgentSession>();
      const next = new Map(list.map((s) => [s.agentId, s]));
      sessions.set(key, next);
      if (!next.size) sessions.delete(key);
      for (const [id, s] of next) if (!prev.has(id)) log.push(key, 'agent', `${s.label} started${s.harness ? ` (${s.harness})` : ''}`, id);
      for (const [id, s] of prev) if (!next.has(id)) log.push(key, 'agent', `${s.label} finished`, id);
    }),
    subscribeTerminalRegistry((ev) => {
      if (ev.type === 'upsert') {
        if (!terminals.has(ev.record.id) && !ev.record.ended) {
          terminals.set(ev.record.id, ev.record.label);
          if (ev.record.owner === 'user' || ev.record.owner === 'startup') log.push(ev.projectPath, 'terminal', `Terminal opened: ${ev.record.label}`, ev.record.id);
        }
      } else if (ev.type === 'ended' || ev.type === 'removed') {
        const label = terminals.get(ev.id);
        terminals.delete(ev.id);
        if (label && ev.type === 'ended' && ev.ended.reason !== 'owner-finished') log.push(ev.projectPath, 'terminal', `Terminal ${ev.ended.reason === 'exit' ? 'exited' : 'closed'}: ${label}`, ev.id);
      }
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}
