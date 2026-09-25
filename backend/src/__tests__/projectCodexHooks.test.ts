import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {
  CODEX_HOOK_TRUST_BYPASS_FLAG,
  projectCodexHookConfigArgs,
  wantsProjectCodexHooks,
  withCodexHookTrustBypass,
} from '../projectCodexHooks.js';
import { withCodexActivityTitle } from '../codexTerminalActivity.js';
import { decodeAgentToken } from '../agentActivityTokens.js';
import { latticeHomeDir } from '../projectPath.js';

// A Codex tab the user opens in a project (sidebar "+" / startup terminal)
// carries the project-activity hooks as per-launch `--config hooks.<Event>=…`
// overrides — Codex's analogue of the project's `.claude/settings.local.json`.

const PROJECT = path.join(os.tmpdir(), 'lattice-codex-proj');
const ORIGIN = 'http://127.0.0.1:5184';

test('projectCodexHookConfigArgs points every activity event at the project-activity route', () => {
  const args = projectCodexHookConfigArgs(ORIGIN, PROJECT, 'win32');
  const events = args.map((a) => /^hooks\.(\w+)=/.exec(a)?.[1]);
  assert.deepEqual(events, [
    'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop',
    'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop',
  ]);
  for (const arg of args) {
    const url = /(http:\/\/\S+?)'/.exec(arg)?.[1] ?? '';
    assert.ok(url.startsWith(`${ORIGIN}/api/project-activity/`), arg);
    const meta = decodeAgentToken(url.slice(url.lastIndexOf('/') + 1));
    assert.equal(meta?.label, 'codex');
    assert.equal(meta?.projectPath, path.resolve(PROJECT));
    // PowerShell-safe: cmd /c curl (bare curl is Invoke-WebRequest), `-d@-`,
    // and TOML literal strings — no double quotes for the shell to mangle.
    assert.match(arg, /command='cmd \/c curl -s -m 2 -X POST -H Content-Type:application\/json -d@- /);
    assert.ok(!arg.includes('"'), arg);
  }
  assert.match(args[1], /timeout=3\}/, 'Codex clamps SessionEnd to 3 s');
  assert.match(args[4], /matcher='Bash\|apply_patch/);
  // POSIX gets the bare command.
  assert.match(projectCodexHookConfigArgs(ORIGIN, PROJECT, 'linux')[0], /command='curl -s /);
});

test('withCodexHookTrustBypass adds the flag once, after the TUI defaults', () => {
  const titled = withCodexActivityTitle('codex --yolo "hi there"')!;
  const bypassed = withCodexHookTrustBypass(titled);
  assert.ok(bypassed.startsWith(`${titled.slice(0, titled.indexOf(' --yolo'))} ${CODEX_HOOK_TRUST_BYPASS_FLAG} --yolo`), bypassed);
  assert.equal(withCodexHookTrustBypass(bypassed), bypassed);
  // The title rewrite still recognizes its own defaults (relaunch idempotency).
  assert.equal(withCodexActivityTitle(bypassed), bypassed);
  assert.equal(withCodexHookTrustBypass('codex resume abc'), `codex ${CODEX_HOOK_TRUST_BYPASS_FLAG} resume abc`);
});

test('wantsProjectCodexHooks: user/startup tabs in the project only, opt-out honoured', () => {
  const base = { cwd: PROJECT, projectPath: PROJECT, owner: undefined, instrumentProjectSessions: undefined };
  assert.equal(wantsProjectCodexHooks(base), true);
  assert.equal(wantsProjectCodexHooks({ ...base, cwd: path.join(PROJECT, 'sub') }), true);
  assert.equal(wantsProjectCodexHooks({ ...base, owner: 'startup' }), true);
  assert.equal(wantsProjectCodexHooks({ ...base, instrumentProjectSessions: false }), false);
  for (const owner of ['task', 'merge', 'workflow-step', 'push', 'qa', 'post-merge'] as const) {
    assert.equal(wantsProjectCodexHooks({ ...base, owner }), false, owner);
  }
  assert.equal(wantsProjectCodexHooks({ ...base, cwd: path.join(os.tmpdir(), 'elsewhere') }), false);
  const scratch = path.join(latticeHomeDir(), 'worktrees', 'abc', 'x');
  assert.equal(wantsProjectCodexHooks({ ...base, cwd: scratch, projectPath: path.dirname(scratch) }), false);
});

test('a Codex session reported through the project route gets a node and a beam per shell-read file', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { applyProjectActivityHook } = await import('../projectClaude/activity.js');
  const { subscribeAgentActivity } = await import('../agentActivity.js');
  const { listAgentSessions } = await import('../agentSessions.js');
  const project = await mkdtemp(path.join(os.tmpdir(), 'lattice-codex-route-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  await writeFile(path.join(project, 'notes.txt'), 'hi');
  const url = /(http:\/\/\S+?)'/.exec(projectCodexHookConfigArgs(ORIGIN, project)[0])![1];
  const token = url.slice(url.lastIndexOf('/') + 1);
  const events: { file?: string }[] = [];
  const unsubscribe = subscribeAgentActivity((e) => events.push(e as { file?: string }));
  t.after(unsubscribe);
  // The bodies Codex 0.157 actually sends (captured from a real run).
  const base = { session_id: 'codex-sess-1', cwd: project };
  applyProjectActivityHook(token, { ...base, hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(listAgentSessions(path.resolve(project)).length, 0, 'an idle session draws nothing');
  applyProjectActivityHook(token, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'read notes' });
  assert.deepEqual(
    listAgentSessions(path.resolve(project)).map((s) => s.harness),
    ['codex'],
    'the node is tagged codex so the graph draws it white',
  );
  applyProjectActivityHook(token, {
    ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: "Get-Content -LiteralPath 'notes.txt' -Raw" },
  });
  assert.deepEqual(events.map((e) => e.file && path.basename(e.file)), ['notes.txt']);
  applyProjectActivityHook(token, { ...base, hook_event_name: 'SessionEnd' });
  assert.equal(listAgentSessions(path.resolve(project)).length, 0);
});
