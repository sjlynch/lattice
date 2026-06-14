import path from 'node:path';
import { generateWorkflowId } from '../ids.js';
import { ProjectStateManager } from '../projectStateManager.js';
import {
  normalizeSteps,
  normalizeWorkflows,
  normalizeWorkflowVariables,
} from './normalization.js';
import type {
  Workflow,
  WorkflowStep,
  WorkflowSubscriber,
  WorkflowVariable,
} from './types.js';

export const WORKFLOWS_FILENAME = 'workflows.json';

export function workflowsFile(projectPath: string): string {
  return path.join(projectPath, '.lattice', WORKFLOWS_FILENAME);
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
    variables?: WorkflowVariable[],
  ): Promise<Workflow> {
    const key = await this.loadIfNeeded(projectPath);
    const list = this.getCached(key) ?? [];
    const workflow: Workflow = {
      id: generateWorkflowId(),
      projectPath: key,
      name: name.trim() || 'Untitled workflow',
      steps: normalizeSteps(steps),
      variables: normalizeWorkflowVariables(variables),
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
    updates: { name?: string; steps?: WorkflowStep[]; variables?: WorkflowVariable[] },
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
        variables: updates.variables
          ? normalizeWorkflowVariables(updates.variables)
          : normalizeWorkflowVariables(prev.variables),
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
