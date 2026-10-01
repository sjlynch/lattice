import { test, expect, type Page } from '@playwright/test';
import type { Workflow, WorkflowStep } from '../frontend/src/api/types/workflows';

// All API/WS traffic is intercepted: editing, saving and reloading these
// workflows never touches the user's projects or launches an agent.
const PROJECT = 'C:/lattice-workflow-editor-fixture';

async function openEditor(page: Page, steps: WorkflowStep[]) {
  let workflow: Workflow = {
    id: 'editor-fixture', name: 'Drag editor fixture', projectPath: PROJECT,
    steps, variables: [{ id: 'instructions', name: 'user_instructions', value: '' }], createdAt: 0,
  };
  let settings = { startupTerminals: [], workflowStepsCollapsed: Object.fromEntries(steps.map((step) => [step.id, true])) };
  await page.routeWebSocket('**/ws/**', () => {});
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (pathname === '/api/workflows') json = [workflow];
    else if (pathname === '/api/workflows/editor-fixture') {
      if (route.request().method() === 'PATCH') workflow = { ...workflow, ...route.request().postDataJSON() };
      json = workflow;
    } else if (pathname === '/api/settings') {
      if (route.request().method() === 'PATCH') settings = { ...settings, ...route.request().postDataJSON() };
      json = settings;
    } else if (pathname === '/api/default-root') json = { path: PROJECT };
    else if (pathname === '/api/scan') json = { root: PROJECT, nodes: [{ id: PROJECT, path: PROJECT, name: 'fixture', kind: 'dir' }], links: [] };
    else if (pathname === '/api/git-history') json = { isRepo: true, commits: [], uncommitted: { changes: [] }, deletedPaths: [], signature: 'fixture' };
    else if (pathname === '/api/check-git') json = { hasGit: true };
    else if (pathname === '/api/tasks') json = { tasks: [] };
    else if (/\/active$/.test(pathname)) json = [];
    else if (pathname === '/api/terminals') json = [];
    else if (pathname === '/api/pi-models') json = { menu: [], models: [] };
    else if (pathname === '/api/terminal-tabs') json = { tabs: [] };
    else if (pathname === '/api/terminal-tabs/restore') json = { status: 'ok', adopted: 0, queued: 0, dropped: [] };
    await route.fulfill({ json });
  });
  await page.addInitScript((project) => sessionStorage.setItem('lattice.activeFolder', project), PROJECT);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open workflow editor' }).click();
  await page.getByRole('button', { name: 'Maximize', exact: true }).click();
  await page.locator('.workflows-item-name').filter({ hasText: workflow.name }).click();
  await expect(page.locator('.workflows-default-prompts')).toBeVisible();
  return () => workflow;
}

const agent = (id: string, title: string): WorkflowStep => ({ id, title, prompt: 'Review code and file tasks.', kind: 'agent', harness: 'claude' });

async function titles(page: Page) {
  return page.locator('.workflows-step-title').evaluateAll((elements) => elements.map((element) => (element as HTMLInputElement).value));
}

test('chips append on click and insert on drag; frozen steps remain editable and survive saving', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const saved = await openEditor(page, [agent('a', 'Review A'), agent('b', 'Review B')]);
  const chips = page.locator('.workflows-default-prompts');
  const rows = page.locator('.workflows-step');

  await chips.getByRole('button', { name: 'Start', exact: true }).click();
  expect(await titles(page)).toEqual(['Review A', 'Review B', 'Start all open tasks']);
  await chips.getByRole('button', { name: 'Merge', exact: true }).dragTo(rows.nth(1), { targetPosition: { x: 10, y: 4 } });
  expect(await titles(page)).toEqual(['Review A', 'Merge all tasks', 'Review B', 'Start all open tasks']);
  await chips.getByRole('button', { name: 'Opengrep', exact: true }).dragTo(rows.first(), { targetPosition: { x: 10, y: 4 } });
  await expect(rows.first().locator('[data-tool="opengrep"]')).toBeVisible();
  await expect(rows.first()).toHaveClass(/collapsed/);
  const reviewB = rows.nth(3);
  const box = await reviewB.boundingBox();
  await chips.getByRole('button', { name: 'Run tests', exact: true }).dragTo(reviewB, { targetPosition: { x: 10, y: box!.height - 4 } });
  await chips.getByRole('button', { name: 'Push', exact: true }).dragTo(page.locator('.workflows-add-step'));
  expect(await titles(page)).toEqual(['Opengrep Triage', 'Review A', 'Merge all tasks', 'Review B', 'Run tests', 'Start all open tasks', 'Push to remote']);
  await expect(page.locator('.quick-add-drop-before')).toHaveCount(0);

  // Existing rows still move rather than copying themselves.
  await rows.nth(5).locator('.workflows-step-grip').dragTo(rows.first(), { targetPosition: { x: 10, y: 4 } });
  expect(await titles(page)).toEqual(['Start all open tasks', 'Opengrep Triage', 'Review A', 'Merge all tasks', 'Review B', 'Run tests', 'Push to remote']);
  for (let index = 0; index < 7; index++) await rows.nth(index).locator('.workflows-step-freeze').click();
  await expect(page.locator('.workflows-step.frozen')).toHaveCount(7);
  const frost = await rows.first().evaluate((element) => ({
    surface: getComputedStyle(element).backgroundImage,
    texture: getComputedStyle(element, '::after').backgroundImage,
    overlayPointerEvents: getComputedStyle(element, '::after').pointerEvents,
  }));
  expect(frost.surface).toContain('radial-gradient');
  expect(frost.texture).toContain('data:image/svg+xml');
  expect(frost.overlayPointerEvents).toBe('none');
  await rows.nth(2).locator('.workflows-step-title').fill('Edited while frozen');
  await page.screenshot({ path: testInfo.outputPath('frozen-steps.png') });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Discard', exact: true })).toHaveCount(0);
  expect(saved().steps.every((step) => step.frozen)).toBe(true);
  expect(new Set(saved().steps.map((step) => step.id)).size).toBe(7);
  expect(saved().steps[1].tools).toEqual(['opengrep']);
  expect(saved().steps[1].prompt).toContain('{{user_instructions}}');
  expect(saved().steps[5]).toMatchObject({ kind: 'test', harness: 'claude', prompt: '' });
  await page.reload();
  await page.getByRole('button', { name: 'Open workflow editor' }).click();
  await page.locator('.workflows-item-name').filter({ hasText: 'Drag editor fixture' }).click();
  await expect(page.locator('.workflows-step.frozen')).toHaveCount(7);
  await rows.first().locator('.workflows-step-freeze').click();
  await expect(rows.first()).not.toHaveClass(/frozen/);
  expect(errors).toEqual([]);
});

test('chips can fill an empty workflow; cancelled and unrelated drops add nothing', async ({ page }) => {
  await openEditor(page, []);
  const start = page.locator('.workflows-default-prompts').getByRole('button', { name: 'Start', exact: true });
  await start.dragTo(page.locator('.workflows-add-step'));
  expect(await titles(page)).toEqual(['Start all open tasks']);
  await start.dragTo(page.locator('.workflows-editor-name'));
  expect(await titles(page)).toEqual(['Start all open tasks']);
  await expect(page.locator('.quick-add-drop-before')).toHaveCount(0);
  await page.locator('.workflows-editor-steps').evaluate((element) => {
    for (const [type, value] of [['text/plain', 'Start'], ['application/x-lattice-workflow-quick-add', '{bad json']]) {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData(type, value);
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    }
  });
  expect(await titles(page)).toEqual(['Start all open tasks']);
  await start.click();
  expect(await titles(page)).toEqual(['Start all open tasks', 'Start all open tasks']);
});

test('a chip highlights and inserts in the gap beside expanded, frozen parallel steps', async ({ page }) => {
  await openEditor(page, [
    { ...agent('a', 'Review A'), parallel: true, frozen: true },
    { ...agent('b', 'Review B'), parallel: true },
  ]);
  await expect(page.locator('.parallel-group-member')).toHaveCount(2);
  await page.locator('.workflows-step-collapse').first().click();
  await expect(page.locator('.workflows-step-prompt')).toBeVisible();
  const chip = await page.locator('.workflows-default-prompts').getByRole('button', { name: 'Merge', exact: true }).boundingBox();
  const row = await page.locator('.workflows-step').first().boundingBox();
  await page.mouse.move(chip!.x + chip!.width / 2, chip!.y + chip!.height / 2);
  await page.mouse.down();
  await page.mouse.move(chip!.x + chip!.width / 2, chip!.y - 12, { steps: 5 });
  await page.mouse.move(row!.x + 10, row!.y + row!.height / 2, { steps: 10 });
  // Native drag auto-scroll can move the rows on the way up from the chips.
  // Measure the gap again once the pointer is safely inside the list.
  const currentRow = await page.locator('.workflows-step').first().boundingBox();
  await page.mouse.move(currentRow!.x + 10, currentRow!.y + currentRow!.height + 4, { steps: 5 });
  await expect(page.locator('.workflows-step-slot').nth(1)).toHaveClass(/quick-add-drop-before/);
  const marker = await page.locator('.quick-add-drop-before').evaluate((element) => getComputedStyle(element, '::after').backgroundColor);
  expect(marker).toBe('rgb(106, 169, 255)');
  await page.mouse.up();
  expect(await titles(page)).toEqual(['Review A', 'Merge all tasks', 'Review B']);
  await expect(page.locator('.quick-add-drop-before')).toHaveCount(0);
  await expect(page.locator('.parallel-group-member')).toHaveCount(0);
  await expect(page.locator('.workflows-step').first()).toHaveClass(/frozen/);
});
