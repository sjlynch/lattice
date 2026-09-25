// Regression: 806a71a (written on a stale base) silently removed two
// createSession.ts fixes, and only the helpers themselves were tested, so
// nothing noticed:
//   - f5c9528: `recordSpawnedTerminal` must end the dead predecessor of a
//     re-seeded startup terminal (`endSupersededStartupRecords`), or every
//     executor restart under `restoreTerminalsOnOpen: 'never'` adds another dead
//     "session lost" startup tab.
//   - 86ab5ec: the Codex system prompt must be resolved for the real pty shell
//     (`resolveDefaultShell()`); without it the shell is always unknown and the
//     Append is flattened (line breaks → spaces, `"` → curly quotes) on bash /
//     pwsh too.
// Both are exercised through the public createSession.js entry points.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  proxyCreateSession,
  resolveHarnessSpawnBody,
  type CreateSessionResult,
} from '../terminalServerClient/createSession.js';
import { EXPECTED_TERMINAL_FINGERPRINT } from '../terminalServerLifecycle.js';
import { terminalRegistry } from '../terminalRegistry/store.js';
import type { TerminalRegistryEvent } from '../terminalRegistry/types.js';

assert.ok(process.env.LATTICE_TEST_HOME_ISOLATED, 'run with the isolateHome preload');

async function tempProject(settings: object = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-create-regress-'));
  await fs.mkdir(path.join(dir, '.lattice'), { recursive: true });
  await fs.writeFile(path.join(dir, '.lattice', 'userSettings.json'), JSON.stringify(settings));
  return dir;
}

test('a re-seeded startup terminal ends its dead predecessor from a replaced executor', async () => {
  const project = await tempProject();
  const old = await terminalRegistry.create({
    projectPath: project,
    cwd: project,
    label: 'npm run dev',
    owner: 'startup',
    kind: 'startup',
    startupId: 'dev',
    launch: { initialCommand: 'npm run dev' },
    serverId: 'tty_old',
    serverInstanceId: 'A',
  });
  const events: TerminalRegistryEvent[] = [];
  const unsubscribe = terminalRegistry.subscribe((e) => events.push(e));

  const original = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith('/health')) {
      return Response.json({
        ok: true, fingerprint: EXPECTED_TERMINAL_FINGERPRINT, protocolVersion: 1, instanceId: 'B',
        capabilities: { idempotentCreate: true, shutdownIfIdle: true },
      });
    }
    assert.ok(url.endsWith('/sessions'), url);
    return Response.json({ id: 'tty_new' });
  }) as typeof fetch;
  let result: CreateSessionResult;
  try {
    result = await proxyCreateSession({
      cwd: project,
      projectPath: project,
      initialCommand: 'npm run dev',
      registry: { owner: 'startup', kind: 'startup', startupId: 'dev', label: 'npm run dev' },
    });
  } finally {
    globalThis.fetch = original;
    unsubscribe();
  }

  if (!('id' in result)) throw new Error(`spawn failed: ${result.error}`);
  assert.equal(result.id, 'tty_new');
  const fresh = result.terminalId;
  assert.ok(fresh && fresh !== old.id);
  const ended = events.find((e) => e.type === 'ended' && e.id === old.id);
  assert.ok(ended && ended.type === 'ended', 'the superseded startup record was ended');
  assert.equal(ended.ended.reason, 'owner-finished');
  const tabs = (await terminalRegistry.list(project)).filter((r) => r.owner === 'startup');
  assert.deepEqual(tabs.map((r) => r.id), [fresh]);
});

async function codexDeveloperInstructions(shell: string): Promise<string> {
  const project = await tempProject({ harnessSystemPrompts: { codex: { append: 'a\n\nb "q"' } } });
  const prev = process.env.LATTICE_DEFAULT_SHELL;
  process.env.LATTICE_DEFAULT_SHELL = shell;
  try {
    const body = await resolveHarnessSpawnBody({ cwd: project, projectPath: project, initialCommand: 'codex' });
    const dev = body.codexSystemPromptConfigArgs?.find((a) => a.startsWith('developer_instructions='));
    assert.ok(dev, JSON.stringify(body.codexSystemPromptConfigArgs));
    return dev;
  } finally {
    if (prev === undefined) delete process.env.LATTICE_DEFAULT_SHELL;
    else process.env.LATTICE_DEFAULT_SHELL = prev;
  }
}

test('a Codex Append keeps its line breaks and straight quotes on a POSIX shell', async () => {
  const dev = await codexDeveloperInstructions('bash');
  assert.ok(dev.includes('a\n\nb "q"'), dev);
});

test('a Codex Append is flattened for cmd.exe', async () => {
  const dev = await codexDeveloperInstructions('cmd.exe');
  assert.ok(dev.includes('a b “q”'), dev);
  assert.doesNotMatch(dev, /[\r\n"]/);
});
