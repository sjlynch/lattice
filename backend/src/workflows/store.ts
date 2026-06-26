import path from 'node:path';
import { generateWorkflowId } from '../ids.js';
import { ProjectStateManager } from '../projectStateManager.js';
import { listKnownProjects as listKnownTaskProjects } from '../tasks.js';
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

// Where a cross-project lookup found a workflow: the project key whose cached
// list holds it, the list itself, and the index within that list.
type WorkflowLookup = { project: string; list: Workflow[]; idx: number };

export type WorkflowStoreOptions = {
  // Source of the project roots to scan when a by-id lookup misses the
  // in-memory cache. Defaults to the global tasks projects index — a project
  // with workflows is always loaded as a task project when its UI opens, so it
  // appears there even across a backend restart. Injectable for tests.
  listKnownProjects?: () => Promise<string[]>;
};

export class WorkflowStore extends ProjectStateManager<Workflow[], WorkflowSubscriber> {
  private readonly listKnownProjects: () => Promise<string[]>;

  constructor(opts: WorkflowStoreOptions = {}) {
    super({
      name: 'workflows',
      fileForProject: workflowsFile,
      defaultState: () => [],
      deserialize: normalizeWorkflows,
      snapshot: (workflows) => [...workflows],
    });
    this.listKnownProjects = opts.listKnownProjects ?? listKnownTaskProjects;
  }

  public async listWorkflows(projectPath: string): Promise<Workflow[]> {
    const key = await this.loadIfNeeded(projectPath);
    return [...(this.getCached(key) ?? [])];
  }

  // Lazily load every known project's workflows.json into the cache. The
  // in-memory cache is empty for an unopened project (e.g. right after the
  // dev backend's tsc -w restart) — a by-id lookup would otherwise miss a
  // workflow that plainly exists on disk. Mirrors the task store's
  // loadAllKnown fallback.
  private async loadAllKnown(): Promise<void> {
    const projects = await this.listKnownProjects();
    for (const project of projects) {
      if (!this.isLoaded(project)) {
        // eslint-disable-next-line no-await-in-loop
        await this.loadIfNeeded(project);
      }
    }
  }

  // Resolve a workflow by id regardless of whether its project is currently
  // loaded — the shared cache-miss fallback lives in ProjectStateManager;
  // this supplies the workflow id accessor and the workflow load strategy.
  private withWorkflowAcrossProjects<T>(
    id: string,
    fn: (lookup: WorkflowLookup) => T | Promise<T>,
  ): Promise<T | null> {
    return this.withItemAcrossProjects<Workflow, T>(
      id,
      (w) => w.id,
      () => this.loadAllKnown(),
      ({ project, list, idx }) => fn({ project, list, idx }),
    );
  }

  public async getWorkflow(id: string): Promise<Workflow | null> {
    return this.withWorkflowAcrossProjects(id, ({ list, idx }) => list[idx]);
  }

  public async createWorkflow(
    projectPath: string,
    name: string,
    steps: WorkflowStep[] | undefined,
    variables?: WorkflowVariable[],
  ): Promise<Workflow> {
    const key = await this.loadIfNeeded(projectPath);
    // Read-modify-write under the per-project lock so two concurrent creates
    // (each reading `[]` and writing only its own entry) don't clobber.
    return this.runProjectWrite(key, () => {
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
    });
  }

  public async updateWorkflow(
    id: string,
    updates: { name?: string; steps?: WorkflowStep[]; variables?: WorkflowVariable[] },
  ): Promise<Workflow | null> {
    return this.withLockedItemAcrossProjects<Workflow, Workflow>(
      id,
      (w) => w.id,
      () => this.loadAllKnown(),
      ({ project, list, idx }) => {
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
      },
    );
  }

  public async deleteWorkflow(id: string): Promise<boolean> {
    const deleted = await this.withLockedItemAcrossProjects<Workflow, boolean>(
      id,
      (w) => w.id,
      () => this.loadAllKnown(),
      ({ project, list, idx }) => {
        const nextList = list.filter((_, i) => i !== idx);
        this.setCached(project, nextList);
        this.schedulePersist(project);
        this.notifyProject(project);
        return true;
      },
    );
    return deleted ?? false;
  }
}
