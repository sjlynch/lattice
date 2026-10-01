import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Editor-only fixture: saves definitions in a disposable project and never
// runs a harness. The default Playwright servers use their own HOME and ports.
test('parallel toggles form a matching vertical rail, respect actions and survive saving', async ({ context, page, request }) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-playwright-parallel-'));
  let workflowId: string | undefined;
  const name = `Parallel editor ${Date.now()}`;
  const review = (id: string) => ({ id, title: `Review ${id}`, prompt: 'Review code and file tasks.', harness: 'claude', kind: 'agent' });
  try {
    const created = await request.post('/api/workflows', { data: { project, name,
      steps: [review('a'), review('b'), review('c'),
        ...['start', 'merge', 'test', 'push'].map((kind) => ({ id: kind, title: kind, prompt: '', harness: 'claude', kind })),
        review('d'), review('e')] } });
    expect(created.ok()).toBe(true);
    workflowId = (await created.json()).id;
    await context.addInitScript((dir) => sessionStorage.setItem('lattice.activeFolder', dir), project);
    await page.goto('/');
    await page.getByRole('button', { name: 'Open workflow editor' }).click();
    await page.locator('.workflows-item').filter({ hasText: name }).locator('.workflows-item-name').click();
    const toggles = page.getByRole('button', { name: 'Run step in parallel', exact: true });
    await expect(toggles).toHaveCount(5);
    await expect(page.locator('.parallel-group-member')).toHaveCount(0);
    await toggles.nth(0).click();
    await expect(toggles.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.parallel-group-member')).toHaveCount(0);
    await toggles.nth(1).click();
    await expect(page.locator('.parallel-group-member')).toHaveCount(2);
    await expect(page.locator('.workflows-parallel-label')).toHaveText('Parallel · 2 steps');
    const colors = await page.locator('.parallel-group-start').evaluate((el) => ({
      rail: getComputedStyle(el, '::before').backgroundColor,
      icon: getComputedStyle(el.querySelector('.workflows-step-parallel')!).color,
    }));
    expect(colors.rail).toBe(colors.icon);
    await page.locator('.workflows-step-freeze').nth(1).click();
    await expect(page.locator('.parallel-group-member.frozen')).toHaveCount(1);
    await expect(page.locator('.parallel-group-member')).toHaveCount(2);
    await toggles.nth(2).click();
    await toggles.nth(3).click();
    await toggles.nth(4).click();
    await expect(page.locator('.workflows-parallel-label')).toHaveText(['Parallel · 3 steps', 'Parallel · 2 steps']);
    await expect(page.locator('.parallel-group-member .workflows-step-control')).toHaveCount(0);
    // Turning off the middle member breaks the first group despite Freeze.
    await toggles.nth(1).click();
    await expect(page.locator('.parallel-group-member')).toHaveCount(2);
    await toggles.nth(1).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Discard', exact: true })).toHaveCount(0);
    const response = await request.get('/api/workflows', { params: { project } });
    const saved = (await response.json()).find((wf: { id: string }) => wf.id === workflowId);
    expect(saved.steps.map((step: { parallel?: boolean }) => step.parallel === true))
      .toEqual([true, true, true, false, false, false, false, true, true]);
    expect(saved.steps[1].frozen).toBe(true);
    await page.reload();
    await page.getByRole('button', { name: 'Open workflow editor' }).click();
    await page.locator('.workflows-item').filter({ hasText: name }).locator('.workflows-item-name').click();
    await expect(page.locator('.parallel-group-member')).toHaveCount(5);
  } finally {
    await page.close();
    if (workflowId) await request.delete(`/api/workflows/${workflowId}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const resolved = path.resolve(project);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir())) throw new Error(`Unsafe fixture cleanup: ${resolved}`);
    await fs.rm(resolved, { recursive: true, force: true });
    await request.get('/api/projects');
  }
});
