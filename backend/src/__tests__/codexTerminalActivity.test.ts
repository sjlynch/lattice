import assert from 'node:assert/strict';
import test from 'node:test';
import { withCodexActivityTitle, codexTitleIsWorking } from '../codexTerminalActivity.js';
import { proxyCreateSession } from '../terminalServerClient/createSession.js';

test('status title default preserves Codex prompts, paths, and later user overrides', () => {
  for (const executable of ['codex', 'CODEX.cmd', '"C:\\Program Files\\Codex\\codex.exe"',
    "'/opt/Codex Tools/codex'", '/usr/local/bin/codex']) {
    const tail = ' --yolo --config "tui.terminal_title=[]" "Read TASK.md and implement it"';
    const command = `  ${executable}${tail}`;
    const rewritten = withCodexActivityTitle(command)!;
    assert.equal(rewritten, `  ${executable} --config "tui.terminal_title=['status']"${tail}`);
    assert.equal(withCodexActivityTitle(rewritten), rewritten, 'rewriting is idempotent');
  }
  for (const command of [undefined, '', 'claude --foo', 'pi --approve', 'echo codex', 'codex-other']) {
    assert.equal(withCodexActivityTitle(command), command);
  }
});

test('only the exact explicit Working title counts as active work', () => {
  assert.equal(codexTitleIsWorking('Working'), true);
  for (const title of [undefined, null, '', 'Ready', 'Action Required', '[ ! ] Action Required',
    '[ . ] Action Required', 'Working directory', 'project', {}, ' Working', 'Working\n']) {
    assert.equal(codexTitleIsWorking(title), false);
  }
});

test('new Codex sessions on retained executors receive status configuration before allocation', async (t) => {
  const commands: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/health')) return Response.json({ ok: true, fingerprint: 'legacy-executor' });
    assert.ok(url.endsWith('/sessions'), 'no executor shutdown or extra API calls');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body));
    commands.push(body.initialCommand);
    assert.equal(body.requestId, undefined, 'legacy allocation remains single-attempt');
    return Response.json({ id: 'retained-session' });
  });
  const opts = { initialCommand: 'codex --yolo "fixture prompt"' };
  assert.deepEqual(await proxyCreateSession(opts), { id: 'retained-session' });
  assert.equal(opts.initialCommand, 'codex --yolo "fixture prompt"', 'caller options unchanged');
  assert.deepEqual(commands, [withCodexActivityTitle(opts.initialCommand)]);
});
