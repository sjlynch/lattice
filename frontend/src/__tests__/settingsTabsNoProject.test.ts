import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_TABS,
  resolveSettingsTab,
  visibleSettingsTabs,
} from '../components/settings/settingsTabs.ts';

// Settings opens with no project: only the machine-global tabs are shown, and
// the default 'terminals' selection falls through to the first of them.

test('with a project every tab is visible and the selection is kept', () => {
  assert.deepEqual(
    visibleSettingsTabs(true).map((t) => t.id),
    SETTINGS_TABS.map((t) => t.id),
  );
  assert.equal(resolveSettingsTab('terminals', true), 'terminals');
  assert.equal(resolveSettingsTab('mcp', true), 'mcp');
});

test('with no project only global tabs are visible', () => {
  const ids = visibleSettingsTabs(false).map((t) => t.id);
  assert.ok(ids.length > 0);
  for (const t of visibleSettingsTabs(false)) assert.equal(t.scope, 'global');
  assert.ok(ids.includes('agents'));
  assert.ok(ids.includes('pi'));
  assert.ok(ids.includes('tools'));
  assert.ok(!ids.includes('terminals'));
  assert.ok(!ids.includes('prompts'));
});

test('a per-project selection resolves to the first global tab without a project', () => {
  const first = visibleSettingsTabs(false)[0].id;
  assert.equal(resolveSettingsTab('terminals', false), first);
  assert.equal(resolveSettingsTab('prompts', false), first);
  assert.equal(resolveSettingsTab('pi', false), 'pi');
});
