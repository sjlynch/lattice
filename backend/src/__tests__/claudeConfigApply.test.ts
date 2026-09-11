import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyClaudeProjectConfig } from '../claudeTrust.js';
import { CLAUDE_GLOBAL_CONFIG, CLAUDE_JSON_BACKUP, toClaudeProjectKey } from '../claudeTrust/configFile.js';
import { MANAGED_MCP_MARKER, type ClaudeMcpServerConfig } from '../mcp/claudeInject.js';

const lockPath = path.join(os.homedir(), '.claude.json.lattice-lock');
const project = path.join(os.homedir(), 'example-project');
const key = toClaudeProjectKey(project);

async function setup(t: TestContext, config: string) {
  const previous = await fs.readFile(CLAUDE_GLOBAL_CONFIG).catch(() => null);
  const backup = await fs.readFile(CLAUDE_JSON_BACKUP).catch(() => null);
  await fs.mkdir(os.homedir(), { recursive: true });
  await fs.writeFile(CLAUDE_GLOBAL_CONFIG, config);
  await fs.unlink(CLAUDE_JSON_BACKUP).catch(() => {});
  t.after(async () => {
    if (previous) await fs.writeFile(CLAUDE_GLOBAL_CONFIG, previous);
    else await fs.unlink(CLAUDE_GLOBAL_CONFIG).catch(() => {});
    if (backup) await fs.writeFile(CLAUDE_JSON_BACKUP, backup);
  });
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')); });
  return warnings;
}

function denyLockCreation(t: TestContext, deny: () => boolean) {
  const open = fs.open.bind(fs);
  const mkdir = fs.mkdir.bind(fs);
  let attempts = 0;
  const denied = () => Object.assign(new Error(`EPERM: operation not permitted, lock '${lockPath}'`), { code: 'EPERM' });
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === lockPath) { attempts++; if (deny()) throw denied(); }
    return open(...args);
  });
  t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
    if (String(args[0]) === lockPath) { attempts++; if (deny()) throw denied(); }
    return mkdir(...args);
  });
  return () => attempts;
}

test('an already-trusted project needs no lock or write even when lock creation is denied', async (t) => {
  const original = JSON.stringify({ authMetadata: 'preserved', projects: { [key]: { hasTrustDialogAccepted: true, lastCost: 7 } } });
  const warnings = await setup(t, original);
  const attempts = denyLockCreation(t, () => true);
  await applyClaudeProjectConfig(project, { managed: null });
  await applyClaudeProjectConfig(project, { managed: {} });
  assert.equal(attempts(), 0);
  assert.equal(await fs.readFile(CLAUDE_GLOBAL_CONFIG, 'utf8'), original);
  assert.deepEqual(warnings, []);
});

test('identical managed MCP configuration also avoids lock and rewrite while preserving manual servers', async (t) => {
  const managed: Record<string, ClaudeMcpServerConfig> = {
    search: { type: 'stdio', command: 'node', args: ['search.js'], env: { API_KEY: 'private-config-value' } },
  };
  const original = JSON.stringify({ projects: { [key]: {
    hasTrustDialogAccepted: true,
    [MANAGED_MCP_MARKER]: ['search'],
    mcpServers: { manual: { type: 'http', url: 'https://example.invalid/mcp' }, ...managed },
  } } });
  const warnings = await setup(t, original);
  const attempts = denyLockCreation(t, () => true);
  await applyClaudeProjectConfig(project, { managed });
  assert.equal(attempts(), 0);
  assert.equal(await fs.readFile(CLAUDE_GLOBAL_CONFIG, 'utf8'), original);
  assert.deepEqual(warnings, []);
});

test('a required MCP update rereads under the lock and preserves edits made after its optimistic read', async (t) => {
  const initial = { projects: { [key]: {
    hasTrustDialogAccepted: true,
    [MANAGED_MCP_MARKER]: ['old'],
    mcpServers: { old: { type: 'stdio', command: 'old' }, manual: { type: 'stdio', command: 'manual' } },
  } } };
  const warnings = await setup(t, JSON.stringify(initial));
  const open = fs.open.bind(fs);
  let modified = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === lockPath && !modified) {
      modified = true;
      await fs.writeFile(CLAUDE_GLOBAL_CONFIG, JSON.stringify({
        ...initial, externalSetting: 'keep this',
        projects: { ...initial.projects, another: { lastSessionId: 'keep-session' } },
      }));
    }
    return open(...args);
  });
  await applyClaudeProjectConfig(project, { managed: { next: { type: 'stdio', command: 'new' } } });
  assert.equal(modified, true, 'a changed config must take the exclusive lock');
  const result = JSON.parse(await fs.readFile(CLAUDE_GLOBAL_CONFIG, 'utf8'));
  assert.equal(result.externalSetting, 'keep this');
  assert.equal(result.projects.another.lastSessionId, 'keep-session');
  assert.deepEqual(result.projects[key].mcpServers, {
    manual: { type: 'stdio', command: 'manual' }, next: { type: 'stdio', command: 'new' },
  });
  assert.deepEqual(result.projects[key][MANAGED_MCP_MARKER], ['next']);
  assert.deepEqual(warnings, []);
});

test('temporary permission errors recover before applying trust without a launch warning', async (t) => {
  const warnings = await setup(t, JSON.stringify({ projects: {}, preserve: 'original' }));
  let denials = 2;
  const attempts = denyLockCreation(t, () => denials-- > 0);
  await applyClaudeProjectConfig(project, { managed: null });
  const result = JSON.parse(await fs.readFile(CLAUDE_GLOBAL_CONFIG, 'utf8'));
  assert.equal(result.projects[key]?.hasTrustDialogAccepted, true);
  assert.equal(result.preserve, 'original');
  assert.equal(attempts(), 3);
  assert.deepEqual(warnings, []);
});

test('persistent lock denial stays nonfatal, preserves config, and a later call can recover', { timeout: 20_000 }, async (t) => {
  const original = JSON.stringify({ projects: {}, privateValue: 'never-log-this-config' });
  const warnings = await setup(t, original);
  let denied = true;
  const attempts = denyLockCreation(t, () => denied);
  await assert.doesNotReject(applyClaudeProjectConfig(project, { managed: { search: { type: 'stdio', command: 'search' } } }));
  assert.ok(attempts() > 1 && attempts() < 100, 'permission retries must be bounded');
  assert.equal(await fs.readFile(CLAUDE_GLOBAL_CONFIG, 'utf8'), original);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /EPERM/);
  assert.match(warnings[0], /MCP settings/);
  assert.doesNotMatch(warnings[0], /never-log-this-config/);
  denied = false;
  await applyClaudeProjectConfig(project, { managed: null });
  assert.equal(JSON.parse(await fs.readFile(CLAUDE_GLOBAL_CONFIG, 'utf8')).projects[key].hasTrustDialogAccepted, true);
});

test('invalid JSON without a backup is retained and parser diagnostics do not quote private contents', async (t) => {
  const original = 'private-config-never-log-this { invalid';
  const warnings = await setup(t, original);
  await assert.doesNotReject(applyClaudeProjectConfig(project, { managed: null }));
  assert.equal(await fs.readFile(CLAUDE_GLOBAL_CONFIG, 'utf8'), original);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /invalid JSON/);
  assert.doesNotMatch(warnings[0], /private-config-never-log-this/);
});
