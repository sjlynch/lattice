// Fleet: every project on this machine — and on paired PCs — at once: the
// cross-project snapshot + activity feed, "prompt a project" agent launches,
// and the screen / input of any project's terminal. `machine` routes a call
// to a paired PC through this backend's peer proxy. Backend:
// backend/src/fleet.ts, routes/fleet.ts, peers.ts.

import { asJson, postJson } from './http';
import { onMachine } from './peers';
import type { FleetLaunchResult, FleetSnapshot, TerminalScreen } from './types';

export async function fetchFleet(since = 0): Promise<FleetSnapshot> {
  return asJson<FleetSnapshot>(await fetch(`/api/fleet${since > 0 ? `?since=${since}` : ''}`));
}

export type FleetLaunchRequest = {
  project: string;
  harness: 'claude' | 'codex' | 'pi';
  prompt: string;
  model?: string;
  effort?: string;
  piModel?: string;
  label?: string;
};

export function launchFleetAgent(req: FleetLaunchRequest, machine?: string): Promise<FleetLaunchResult> {
  return postJson<FleetLaunchResult>(onMachine(machine, '/api/fleet/agents'), req);
}

export async function fetchTerminalScreen(id: string, lines = 400, machine?: string): Promise<TerminalScreen> {
  return asJson<TerminalScreen>(await fetch(onMachine(machine, `/api/terminals/${encodeURIComponent(id)}/screen?lines=${lines}`)));
}

export function sendTerminalText(id: string, text: string, submit: boolean, machine?: string): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(onMachine(machine, `/api/terminals/${encodeURIComponent(id)}/input`), { text, submit });
}

// One task's full record, for the Fleet review queue (pinned to its project).
export async function fetchFleetTask(id: string, project: string, machine?: string): Promise<{ id: string; title: string; summary?: string; description?: string; status: string }> {
  return asJson(await fetch(onMachine(machine, `/api/tasks/${encodeURIComponent(id)}?project=${encodeURIComponent(project)}`)));
}

// File a task on a project's board (here or on a paired PC) and, with
// `launch`, start an agent on it in its own worktree there.
export async function fileFleetTask(
  project: string,
  task: { title: string; description: string },
  launch: { harness: string; model?: string; effort?: string; piModel?: string } | null,
  machine?: string,
): Promise<{ id: string; title: string; queued?: boolean; runError?: string }> {
  const created = await postJson<{ id: string; title: string }>(onMachine(machine, '/api/tasks'), { project, ...task });
  if (!launch) return created;
  // The task exists from here on: a failed start is reported, never thrown,
  // so the form can't be submitted again and file the task twice.
  try {
    const run = await postJson<{ accepted: boolean; queued: boolean }>(
      onMachine(machine, `/api/tasks/${encodeURIComponent(created.id)}/run?project=${encodeURIComponent(project)}`),
      launch,
    );
    return { ...created, queued: run.queued };
  } catch (err) {
    return { ...created, runError: err instanceof Error ? err.message : String(err) };
  }
}

// Merge every Ready-to-Merge task of a project (a merge run).
export function startFleetMergeRun(project: string, machine?: string): Promise<{ id: string }> {
  return postJson<{ id: string }>(onMachine(machine, '/api/merge-runs'), { project });
}
