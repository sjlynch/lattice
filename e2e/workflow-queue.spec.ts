import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

type Workflow = {
  id: string;
  name: string;
  projectPath: string;
};

type Task = {
  id: string;
};

type WorkflowRun = {
  id: string;
  workflowId: string;
  status: string;
};

const ACTIVE_FOLDER_KEY = 'lattice.activeFolder';
const runUrl = /\/api\/workflows\/[^/]+\/run$/;

let projectDir = '';
let holdTask: Task | null = null;
let firstWorkflow: Workflow | null = null;
let secondWorkflow: Workflow | null = null;

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

async function createDisposableProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-playwright-queue-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'Lattice Playwright']);
  git(dir, ['config', 'user.email', 'playwright@lattice.test']);
  await fs.writeFile(path.join(dir, 'README.md'), '# disposable e2e project\n', 'utf8');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  return path.resolve(dir);
}

function mergeStep(id: string) {
  return {
    id,
    title: 'Wait for the task lane, then merge',
    prompt: '',
    harness: 'claude',
    kind: 'merge',
  };
}

async function createWorkflow(
  request: APIRequestContext,
  name: string,
): Promise<Workflow> {
  return json<Workflow>(
    await request.post('/api/workflows', {
      data: {
        project: projectDir,
        name,
        steps: [mergeStep(`step-${crypto.randomUUID()}`)],
      },
    }),
  );
}

async function activeRuns(request: APIRequestContext): Promise<WorkflowRun[]> {
  return json<WorkflowRun[]>(
    await request.get('/api/workflow-runs/active', {
      params: { project: projectDir },
    }),
  );
}

async function removeLatticeProjectState(project: string): Promise<void> {
  const canonical = path.resolve(project);
  const hash = crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 12);
  const stateRoot = path.resolve(os.homedir(), '.lattice', 'per-project');
  const stateDir = path.resolve(stateRoot, hash);
  if (path.dirname(stateDir) !== stateRoot) {
    throw new Error(`refusing unsafe e2e state cleanup path: ${stateDir}`);
  }
  await fs.rm(stateDir, { recursive: true, force: true });
}

function savedWorkflowRow(page: Page, name: string) {
  return page.locator('.workflows-item').filter({ hasText: name });
}

test.beforeAll(async ({ request }) => {
  projectDir = await createDisposableProject();

  holdTask = await json<Task>(
    await request.post('/api/tasks', {
      data: {
        project: projectDir,
        title: 'Playwright queue gate',
        description: 'A disposable task used only to keep the first Merge step active.',
      },
    }),
  );
  await json<Task>(
    await request.patch(`/api/tasks/${holdTask.id}`, {
      data: { status: 'in_progress' },
    }),
  );

  const nonce = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  firstWorkflow = await createWorkflow(request, `E2E held workflow ${nonce}`);
  secondWorkflow = await createWorkflow(request, `E2E next workflow ${nonce}`);
});

test.afterAll(async ({ request }) => {
  // Finish or cancel any run before removing the disposable project/state.
  for (const run of await activeRuns(request).catch(() => [])) {
    await request.post(`/api/workflow-runs/${run.id}/cancel`).catch(() => undefined);
  }
  if (holdTask) {
    await request.delete(`/api/tasks/${holdTask.id}`).catch(() => undefined);
  }
  for (const workflow of [firstWorkflow, secondWorkflow]) {
    if (workflow) {
      await request.delete(`/api/workflows/${workflow.id}`).catch(() => undefined);
    }
  }

  // Let the backend's debounced stores flush their empty state before removal.
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (projectDir) {
    await removeLatticeProjectState(projectDir);
    const tempRoot = path.resolve(os.tmpdir());
    const resolvedProject = path.resolve(projectDir);
    if (path.dirname(resolvedProject) !== tempRoot) {
      throw new Error(`refusing unsafe e2e project cleanup path: ${resolvedProject}`);
    }
    await fs.rm(resolvedProject, { recursive: true, force: true });
    // Listing projects prunes the now-missing throwaway path from projects.json.
    await request.get('/api/projects').catch(() => undefined);
  }
});

test('workflow runs never overlap: manual Run queues behind the active run, which starts it after the slot frees', async ({
  context,
  page,
  request,
}) => {
  expect(firstWorkflow).not.toBeNull();
  expect(secondWorkflow).not.toBeNull();
  expect(holdTask).not.toBeNull();

  await context.addInitScript(
    ({ key, project }) => sessionStorage.setItem(key, project),
    { key: ACTIVE_FOLDER_KEY, project: projectDir },
  );

  const browserStarts: Array<{ url: string }> = [];
  const browserStartStatuses: number[] = [];
  page.on('request', (req) => {
    if (!runUrl.test(new URL(req.url()).pathname)) return;
    browserStarts.push({ url: req.url() });
  });
  page.on('response', (response) => {
    if (runUrl.test(new URL(response.url()).pathname)) {
      browserStartStatuses.push(response.status());
    }
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Open workflow editor' }).click();

  const firstRow = savedWorkflowRow(page, firstWorkflow!.name);
  const secondRow = savedWorkflowRow(page, secondWorkflow!.name);
  await expect(firstRow).toBeVisible();
  await expect(secondRow).toBeVisible();
  await firstRow.getByRole('button', { name: 'Add workflow to queue' }).click();

  await expect(page.locator('.workflows-queue-status')).toContainText('1 workflow queued');
  await page.getByRole('button', { name: 'Start queue' }).click();

  await expect.poll(() => browserStarts.length).toBe(1);
  await expect(page.locator('.workflows-runs-section').filter({ hasText: 'Active' }))
    .toContainText(firstWorkflow!.name);
  await expect.poll(async () => (await activeRuns(request)).length).toBe(1);
  expect((await activeRuns(request))[0].workflowId).toBe(firstWorkflow!.id);

  // One workflow run per project: a manual ▶ Run while workflow 1 is active
  // goes on the queue behind it (with a toast) instead of starting a second run.
  await secondRow.getByRole('button', { name: 'Run workflow now' }).click();
  await expect(page.locator('.task-error-toast')).toContainText(
    `Queued behind "${firstWorkflow!.name}"`,
  );
  await expect(page.locator('.workflows-runs-section').filter({ hasText: 'Queued' }))
    .toContainText(secondWorkflow!.name);

  // The backend is the authoritative second line of defence. Any start from
  // another tab/process — no opt-in flag needed — is rejected and creates no
  // second run.
  const conflict = await request.post(`/api/workflows/${secondWorkflow!.id}/run`, {
    data: {},
  });
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toMatchObject({ code: 'active-run-exists' });
  expect(await activeRuns(request)).toHaveLength(1);

  await page.waitForTimeout(300);
  expect(browserStarts).toHaveLength(1);

  // Releasing the only in-progress task lets workflow 1's Merge step finish;
  // only then may the queue issue workflow 2's start.
  await json<Task>(
    await request.patch(`/api/tasks/${holdTask!.id}`, {
      data: { status: 'qa' },
    }),
  );

  await expect.poll(() => browserStarts.length).toBeGreaterThanOrEqual(2);
  await expect.poll(() => browserStartStatuses.filter((status) => status === 200).length).toBe(2);
  await expect.poll(async () => (await activeRuns(request)).length).toBe(0);
  await expect(page.locator('.workflows-queue-status')).toContainText(
    'Queue saved workflows',
  );

  expect(browserStarts[browserStarts.length - 1].url).toContain(secondWorkflow!.id);
});
