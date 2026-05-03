// Persistent workflow definitions per project.
//
// A Workflow is an ordered chain of prompts. When run, each step becomes a
// regular Lattice task; finishing one auto-spawns the next (see workflowRuns.ts).
// This module mirrors the in-memory cache + 100 ms debounced persist + WS
// listener pattern from tasks.ts.

import fs from 'node:fs/promises';
import path from 'node:path';

const WORKFLOWS_FILENAME = 'workflows.json';

function workflowsFile(projectPath: string): string {
  return path.join(projectPath, '.lattice', WORKFLOWS_FILENAME);
}

export type WorkflowStepMode = 'sequential' | 'parallel';

export type WorkflowStep = {
  id: string;
  title: string;
  prompt: string;
  // 'parallel' is reserved for the future fan-out-per-file executor; the
  // current run engine treats every step as sequential. Schema-only support
  // is intentional — UI can author parallel steps so the data is ready when
  // the executor lands.
  mode: WorkflowStepMode;
};

export type Workflow = {
  id: string;
  name: string;
  projectPath: string;
  steps: WorkflowStep[];
  createdAt: number;
};

const cache = new Map<string, Workflow[]>();
const loaded = new Map<string, boolean>();
const persistTimers = new Map<string, NodeJS.Timeout>();
const listeners = new Set<(projectPath: string, workflows: Workflow[]) => void>();

async function ensureLoaded(projectPath: string): Promise<void> {
  if (loaded.get(projectPath)) return;
  loaded.set(projectPath, true);
  try {
    const raw = await fs.readFile(workflowsFile(projectPath), 'utf8');
    const parsed = JSON.parse(raw) as Workflow[];
    if (Array.isArray(parsed)) cache.set(projectPath, parsed);
  } catch {
    cache.set(projectPath, []);
  }
}

function schedulePersist(projectPath: string): void {
  if (persistTimers.has(projectPath)) return;
  persistTimers.set(
    projectPath,
    setTimeout(async () => {
      persistTimers.delete(projectPath);
      const list = cache.get(projectPath) ?? [];
      const file = workflowsFile(projectPath);
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(list, null, 2), 'utf8');
      } catch (e) {
        console.error('[workflows] persist failed for', projectPath, e);
      }
    }, 100),
  );
}

function notify(projectPath: string): void {
  const list = cache.get(projectPath) ?? [];
  const snapshot = [...list];
  for (const fn of listeners) fn(projectPath, snapshot);
}

export function subscribe(
  fn: (projectPath: string, workflows: Workflow[]) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function normalizeSteps(steps: WorkflowStep[] | undefined): WorkflowStep[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((s, i) => ({
    id: s.id || `step_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
    title: typeof s.title === 'string' ? s.title : '',
    prompt: typeof s.prompt === 'string' ? s.prompt : '',
    mode: s.mode === 'parallel' ? 'parallel' : 'sequential',
  }));
}

export async function listWorkflows(projectPath: string): Promise<Workflow[]> {
  await ensureLoaded(projectPath);
  return [...(cache.get(projectPath) ?? [])];
}

export async function getWorkflow(id: string): Promise<Workflow | null> {
  for (const list of cache.values()) {
    const found = list.find((w) => w.id === id);
    if (found) return found;
  }
  return null;
}

export async function createWorkflow(
  projectPath: string,
  name: string,
  steps: WorkflowStep[] | undefined,
): Promise<Workflow> {
  await ensureLoaded(projectPath);
  const list = cache.get(projectPath) ?? [];
  const w: Workflow = {
    id: `wf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    projectPath,
    name: name.trim() || 'Untitled workflow',
    steps: normalizeSteps(steps),
    createdAt: Date.now(),
  };
  list.push(w);
  cache.set(projectPath, list);
  schedulePersist(projectPath);
  notify(projectPath);
  return w;
}

export async function updateWorkflow(
  id: string,
  updates: { name?: string; steps?: WorkflowStep[] },
): Promise<Workflow | null> {
  for (const [project, list] of cache.entries()) {
    const idx = list.findIndex((w) => w.id === id);
    if (idx === -1) continue;
    const prev = list[idx];
    const next: Workflow = {
      ...prev,
      name:
        typeof updates.name === 'string' && updates.name.trim()
          ? updates.name.trim()
          : prev.name,
      steps: updates.steps ? normalizeSteps(updates.steps) : prev.steps,
    };
    list[idx] = next;
    schedulePersist(project);
    notify(project);
    return next;
  }
  return null;
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  for (const [project, list] of cache.entries()) {
    const idx = list.findIndex((w) => w.id === id);
    if (idx === -1) continue;
    list.splice(idx, 1);
    schedulePersist(project);
    notify(project);
    return true;
  }
  return false;
}
