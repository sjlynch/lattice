// Persistent workflow definitions per project.
//
// A Workflow is an ordered chain of prompts. When run, each step becomes a
// regular Lattice task; finishing one auto-spawns the next (see workflowRuns.ts).
// Storage remains `<project>/.lattice/workflows.json`; ProjectStateManager owns
// the canonical-project cache, lazy disk load, debounced persistence, and
// subscriber fan-out mechanics.

import path from 'node:path';
import { generateWorkflowId } from './ids.js';
import { canonicalProjectPath } from './projectPath.js';
import { ProjectStateManager } from './projectStateManager.js';
import {
  isAgentHarness,
  normalizeAgentHarness,
  type AgentHarness,
} from './harnesses.js';

const WORKFLOWS_FILENAME = 'workflows.json';

function workflowsFile(projectPath: string): string {
  return path.join(projectPath, '.lattice', WORKFLOWS_FILENAME);
}

export type WorkflowStepMode = 'sequential' | 'parallel';
export type WorkflowStepHarness = AgentHarness;
export type WorkflowRunHarnessOverride = WorkflowStepHarness | null;

export type WorkflowStep = {
  id: string;
  title: string;
  prompt: string;
  // 'parallel' is reserved for the future fan-out-per-file executor; the
  // current run engine treats every step as sequential. Schema-only support
  // is intentional — UI can author parallel steps so the data is ready when
  // the executor lands.
  mode: WorkflowStepMode;
  harness: WorkflowStepHarness;
};

export type Workflow = {
  id: string;
  name: string;
  projectPath: string;
  steps: WorkflowStep[];
  createdAt: number;
};

export type WorkflowSubscriber = (
  projectPath: string,
  workflows: Workflow[],
) => void;

export function normalizeWorkflowStepHarness(value: unknown): WorkflowStepHarness {
  return normalizeAgentHarness(value);
}

export function normalizeWorkflowRunHarnessOverride(
  value: unknown,
): WorkflowRunHarnessOverride {
  return isAgentHarness(value) ? value : null;
}

function normalizeSteps(steps: WorkflowStep[] | undefined): WorkflowStep[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((s, i) => {
    const step = (s && typeof s === 'object' ? s : {}) as Partial<WorkflowStep>;
    return {
      ...step,
      id: step.id || `step_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
      title: typeof step.title === 'string' ? step.title : '',
      prompt: typeof step.prompt === 'string' ? step.prompt : '',
      mode: step.mode === 'parallel' ? 'parallel' : 'sequential',
      harness: normalizeWorkflowStepHarness(step.harness),
    };
  });
}

function normalizeWorkflows(raw: unknown, projectPath: string): Workflow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((w) => {
    const item = (w && typeof w === 'object' ? w : {}) as Partial<Workflow>;
    const embeddedProject =
      typeof item.projectPath === 'string' && item.projectPath
        ? canonicalProjectPath(item.projectPath)
        : projectPath;
    return {
      ...item,
      id: typeof item.id === 'string' && item.id ? item.id : generateWorkflowId(),
      projectPath: embeddedProject,
      name:
        typeof item.name === 'string' && item.name.trim()
          ? item.name.trim()
          : 'Untitled workflow',
      steps: normalizeSteps(item.steps),
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
    };
  });
}

export class WorkflowStore extends ProjectStateManager<Workflow[], WorkflowSubscriber> {
  constructor() {
    super({
      name: 'workflows',
      fileForProject: workflowsFile,
      defaultState: () => [],
      deserialize: normalizeWorkflows,
      snapshot: (workflows) => [...workflows],
    });
  }

  public async listWorkflows(projectPath: string): Promise<Workflow[]> {
    const key = await this.loadIfNeeded(projectPath);
    return [...(this.getCached(key) ?? [])];
  }

  public async getWorkflow(id: string): Promise<Workflow | null> {
    for (const list of this.cacheValues()) {
      const found = list.find((w) => w.id === id);
      if (found) return found;
    }
    return null;
  }

  public async createWorkflow(
    projectPath: string,
    name: string,
    steps: WorkflowStep[] | undefined,
  ): Promise<Workflow> {
    const key = await this.loadIfNeeded(projectPath);
    const list = this.getCached(key) ?? [];
    const workflow: Workflow = {
      id: generateWorkflowId(),
      projectPath: key,
      name: name.trim() || 'Untitled workflow',
      steps: normalizeSteps(steps),
      createdAt: Date.now(),
    };
    const next = [...list, workflow];
    this.setCached(key, next);
    this.schedulePersist(key);
    this.notifyProject(key);
    return workflow;
  }

  public async updateWorkflow(
    id: string,
    updates: { name?: string; steps?: WorkflowStep[] },
  ): Promise<Workflow | null> {
    for (const [project, list] of this.cacheEntries()) {
      const idx = list.findIndex((w) => w.id === id);
      if (idx === -1) continue;
      const prev = list[idx];
      const nextWorkflow: Workflow = {
        ...prev,
        name:
          typeof updates.name === 'string' && updates.name.trim()
            ? updates.name.trim()
            : prev.name,
        steps: updates.steps ? normalizeSteps(updates.steps) : prev.steps,
      };
      const nextList = list.map((w, i) => (i === idx ? nextWorkflow : w));
      this.setCached(project, nextList);
      this.schedulePersist(project);
      this.notifyProject(project);
      return nextWorkflow;
    }
    return null;
  }

  public async deleteWorkflow(id: string): Promise<boolean> {
    for (const [project, list] of this.cacheEntries()) {
      const idx = list.findIndex((w) => w.id === id);
      if (idx === -1) continue;
      const nextList = list.filter((_, i) => i !== idx);
      this.setCached(project, nextList);
      this.schedulePersist(project);
      this.notifyProject(project);
      return true;
    }
    return false;
  }
}

const workflowStore = new WorkflowStore();

export function subscribe(fn: WorkflowSubscriber): () => void {
  return workflowStore.subscribe(fn);
}

export async function listWorkflows(projectPath: string): Promise<Workflow[]> {
  return workflowStore.listWorkflows(projectPath);
}

export async function getWorkflow(id: string): Promise<Workflow | null> {
  return workflowStore.getWorkflow(id);
}

export async function createWorkflow(
  projectPath: string,
  name: string,
  steps: WorkflowStep[] | undefined,
): Promise<Workflow> {
  return workflowStore.createWorkflow(projectPath, name, steps);
}

export async function updateWorkflow(
  id: string,
  updates: { name?: string; steps?: WorkflowStep[] },
): Promise<Workflow | null> {
  return workflowStore.updateWorkflow(id, updates);
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  return workflowStore.deleteWorkflow(id);
}
