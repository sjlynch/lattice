import { test, expect, type Page } from '@playwright/test';

// FloatingPanel pop-outs against the isolated backend (no project fixture, no
// coding harness): a panel moves into its own browser window and back without
// remounting. Fleet is the main subject because its state (the filter text,
// the PCs view) lives INSIDE the panel, so a remount would visibly lose it.
// Checks: the popup gets the panel's title and the main window's stylesheets
// (standards mode), stays interactive, the panel leaves the main window while
// out and comes back with its state when the popup is closed or "Return to
// main window" is pressed — and the elements React created inside the popup
// keep working afterwards. Also: a blocked popup is an error toast with the
// panel left in place; a confirm asked from a popped-out panel opens in the
// popup; Escape layering in a popped-out task board; a titlebar drag released
// past the window's edge pops out; a main-window reload closes its pop-outs.

async function openFleet(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Fleet' }).click();
  await expect(page.locator('.floating-panel')).toBeVisible();
}

async function popOut(page: Page): Promise<Page> {
  const popupPromise = page.context().waitForEvent('page');
  await page.getByRole('button', { name: 'Pop out into its own window' }).click();
  const popup = await popupPromise;
  await expect(popup.locator('.floating-panel.popped-out')).toBeVisible();
  return popup;
}

test('pop out Fleet: styled, interactive, state kept, back on popup close', async ({ page }) => {
  await openFleet(page);
  await page.getByLabel('Filter projects').fill('before-popout');

  const popup = await popOut(page);
  // Moved, not copied: the main window no longer shows it.
  await expect(page.locator('.floating-panel')).toHaveCount(0);
  await expect(popup).toHaveTitle(/Fleet · every project/);

  // The main window's stylesheets apply in the popup.
  const look = await popup.locator('.floating-panel').evaluate((el) => {
    const s = getComputedStyle(el);
    const bar = getComputedStyle(el.querySelector('.floating-panel-titlebar')!);
    return { bg: s.backgroundColor, position: s.position, bar: bar.display, mode: document.compatMode };
  });
  expect(look).toEqual({ bg: 'rgb(35, 39, 46)', position: 'fixed', bar: 'flex', mode: 'CSS1Compat' });

  // State survived the move, and the panel is live in the popup.
  const filter = popup.getByLabel('Filter projects');
  await expect(filter).toHaveValue('before-popout');
  await filter.fill('typed-in-popup');
  await popup.getByRole('button', { name: /^PCs/ }).click();
  await expect(popup.locator('.fleet-peers')).toBeVisible();
  // Elements created while popped out (the PCs view) get the styles too.
  await expect(popup.locator('.fleet-peers')).toHaveCSS('display', /flex|block|grid/);

  // Closing the popup window returns the panel, state intact.
  await popup.close();
  await expect(page.locator('.floating-panel')).toBeVisible();
  await expect(page.getByLabel('Filter projects')).toHaveValue('typed-in-popup');
  await expect(page.locator('.fleet-peers')).toBeVisible();
  // ...and still interactive, including elements the popup's document created.
  await page.getByLabel('Filter projects').fill('back-in-main');
  await expect(page.getByLabel('Filter projects')).toHaveValue('back-in-main');
  await page.getByRole('button', { name: /^PCs/ }).click();
  await expect(page.locator('.fleet-peers')).toHaveCount(0);

  // The popup's placement is remembered beside the panel's in-window geometry.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('lattice.fleet.popout') ?? 'null'));
  expect(saved).toEqual(expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }));
});

test('"Return to main window" closes the popup; a blocked popup shows an error and stays put', async ({ page }) => {
  await openFleet(page);
  await page.getByLabel('Filter projects').fill('round-trip');

  const popup = await popOut(page);
  const closed = popup.waitForEvent('close');
  await popup.getByRole('button', { name: 'Return to main window' }).click();
  await closed;
  await expect(page.locator('.floating-panel')).toBeVisible();
  await expect(page.getByLabel('Filter projects')).toHaveValue('round-trip');

  // A popup blocker makes window.open return null.
  await page.evaluate(() => {
    window.open = () => null;
  });
  await page.getByRole('button', { name: 'Pop out into its own window' }).click();
  await expect(page.locator('.floating-panel .task-error-toast')).toContainText('blocked the pop-out window');
  await expect(page.locator('.floating-panel')).toBeVisible();
  await expect(page.getByLabel('Filter projects')).toHaveValue('round-trip');
});

test('a confirm asked from a popped-out panel opens in the popup; closing the panel closes the popup', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.floating-panel')).toBeVisible();
  const popup = await popOut(page);

  // An unsaved edit, then Close: the Save / Discard / Cancel question is asked
  // where the user is — in the popup, not behind it in the main window.
  await popup.locator('.settings-checkbox-row input[type="checkbox"]').first().click();
  await popup.getByRole('button', { name: 'Close', exact: true }).click();
  const modal = popup.locator('.modal');
  await expect(modal).toContainText('unsaved settings changes');
  await expect(page.locator('.modal')).toHaveCount(0);

  const closed = popup.waitForEvent('close');
  await modal.getByRole('button', { name: 'Discard' }).click();
  await closed;
  await expect(page.locator('.floating-panel')).toHaveCount(0);
});

test('a popped-out task board: Escape closes its overlay first, then the board and its popup', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open task board' }).click();
  const popup = await popOut(page);

  await popup.getByRole('button', { name: 'Add task' }).first().click();
  await expect(popup.locator('.taskboard-newform')).toBeVisible();
  await popup.keyboard.type('typed in the popup');
  await expect(popup.locator('.taskboard-newform input').first()).toHaveValue('typed in the popup');

  // Innermost first: the overlay closes, the board stays.
  await popup.keyboard.press('Escape');
  await expect(popup.locator('.taskboard-newform')).toHaveCount(0);
  await expect(popup.locator('.floating-panel')).toBeVisible();

  // Then the board itself — which closes its popup (the press can race the close).
  const closed = popup.waitForEvent('close');
  await popup.keyboard.press('Escape').catch(() => {});
  await closed;
  await expect(page.locator('.floating-panel')).toHaveCount(0);
});

test('reloading the main window closes its pop-outs', async ({ page }) => {
  await openFleet(page);
  const popup = await popOut(page);
  const closed = popup.waitForEvent('close');
  await page.reload();
  await closed;
  await expect(page.getByRole('button', { name: 'Open Fleet' })).toBeVisible();
});

test('dragging the titlebar past the window edge arms a pop-out; releasing there opens it', async ({ page }) => {
  await openFleet(page);
  const title = (await page.locator('.floating-panel-title').boundingBox())!;
  const viewport = page.viewportSize()!;
  await page.mouse.move(title.x + 20, title.y + 5);
  await page.mouse.down();
  await page.mouse.move(title.x + 120, title.y + 5, { steps: 3 });
  await expect(page.locator('.floating-panel.popout-armed')).toHaveCount(0);
  await page.mouse.move(viewport.width + 200, 300, { steps: 5 });
  await expect(page.locator('.floating-panel.popout-armed')).toBeVisible();
  const popupPromise = page.context().waitForEvent('page');
  await page.mouse.up();
  const popup = await popupPromise;
  await expect(popup.locator('.floating-panel.popped-out')).toBeVisible();
  await expect(popup.getByLabel('Filter projects')).toBeVisible();
});
