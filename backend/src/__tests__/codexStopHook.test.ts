import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
  renderCodexStopHookJson,
  installCodexStopHook,
  codexHooksJsonPath,
  isLatticeGeneratedCodexHooks,
} from '../codexStopHook.js';
import { CALLBACK_HOOK_TIMEOUT_S, callbackScriptPath } from '../callbackOutbox.js';

// The Codex Stop hook is the Codex analogue of the Claude Stop hook / Pi
// completion extension: a `<cwd>/.codex/hooks.json` whose `Stop` hook POSTs
// `/complete` on turn completion, so a Codex step/task advances even if the
// model forgets to curl. These pin the rendered JSON shape (Codex's hooks
// framework parses it) and the install policies (`always` vs `if-absent`).

const URL = 'http://127.0.0.1:5184/api/tasks/abc/complete?source=codex-stop-hook-task-complete';

test('renderCodexStopHookJson emits a valid Stop hook running the callback script unquoted (cmd /c on Windows)', () => {
  const json = renderCodexStopHookJson(URL);
  const parsed = JSON.parse(json) as {
    hooks: {
      Stop: { hooks: { type: string; command: string; commandWindows: string; timeout: number }[] }[];
    };
  };
  const entry = parsed.hooks.Stop[0].hooks[0];
  assert.equal(entry.type, 'command');
  // Codex spawns the hook argv directly (no shell): the URL must be UNQUOTED, and
  // Windows needs `cmd /c` to spawn node. camelCase `commandWindows` (JSON key).
  // The isolated test HOME has no whitespace, so this is the script form (the
  // retrying-curl fallback is only for a home path with a space in it).
  assert.equal(entry.command, `node ${callbackScriptPath().replace(/\\/g, '/')} ${URL}`);
  assert.equal(entry.commandWindows, `cmd /c ${entry.command}`);
  assert.ok(!entry.command.includes('"'), 'the URL must not be quoted (no shell to strip it)');
  assert.equal(entry.timeout, CALLBACK_HOOK_TIMEOUT_S);
});

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lattice-codex-hook-'));
}

test("installCodexStopHook('always') writes <dir>/.codex/hooks.json", async (t) => {
  const dir = await tmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const wrote = await installCodexStopHook(dir, URL, 'always');
  assert.equal(wrote, true);

  const onDisk = await fs.readFile(codexHooksJsonPath(dir), 'utf8');
  assert.equal(onDisk, renderCodexStopHookJson(URL));
});

test('installCodexStopHook is idempotent — an identical existing file is left untouched', async (t) => {
  const dir = await tmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await installCodexStopHook(dir, URL, 'always');
  const file = codexHooksJsonPath(dir);
  const before = await fs.stat(file);
  // Second install with the same URL is a no-op that still reports success.
  const wrote = await installCodexStopHook(dir, URL, 'always');
  assert.equal(wrote, true);
  const after = await fs.stat(file);
  assert.equal(before.mtimeMs, after.mtimeMs, 'identical content must not be rewritten');
});

test("installCodexStopHook('if-absent') skips (returns false) when a DIFFERENT file already exists", async (t) => {
  const dir = await tmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // Simulate a repo-tracked .codex/hooks.json we must not clobber.
  const file = codexHooksJsonPath(dir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const repoOwned = '{\n  "hooks": { "Stop": [] }\n}\n';
  await fs.writeFile(file, repoOwned, 'utf8');

  const wrote = await installCodexStopHook(dir, URL, 'if-absent');
  assert.equal(wrote, false, 'must not overwrite a pre-existing (repo-owned) file');
  assert.equal(await fs.readFile(file, 'utf8'), repoOwned, 'the existing file is preserved verbatim');
});

test("installCodexStopHook('if-absent') writes when no file exists yet", async (t) => {
  const dir = await tmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const wrote = await installCodexStopHook(dir, URL, 'if-absent');
  assert.equal(wrote, true);
  assert.equal(await fs.readFile(codexHooksJsonPath(dir), 'utf8'), renderCodexStopHookJson(URL));
});

test("installCodexStopHook('if-absent') no-ops (true) when our identical file is already present", async (t) => {
  const dir = await tmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await installCodexStopHook(dir, URL, 'always'); // ours
  const wrote = await installCodexStopHook(dir, URL, 'if-absent'); // re-setup
  assert.equal(wrote, true, 'a matching Lattice file is recognized as ours, not a foreign file');
});


// Regression: a Lattice-generated `.codex/hooks.json` can end up TRACKED on
// main (an agent commits it; the merge carries it over — this is what errored
// two tasks of an interview_eci merge run with "untracked working tree files
// would be overwritten by merge"). Every fresh worktree then checks it out, and
// a strict `if-absent` would leave a Stop hook pointing at a COMPLETED task's
// `/complete` URL — reporting the wrong task finished. A file we can positively
// identify as Lattice's is stale by definition, so it gets rewritten; anything
// else is still protected.

test('isLatticeGeneratedCodexHooks recognizes our completion URLs and nothing else', () => {
  assert.equal(isLatticeGeneratedCodexHooks(renderCodexStopHookJson(URL)), true);
  assert.equal(
    isLatticeGeneratedCodexHooks(
      renderCodexStopHookJson('http://127.0.0.1:5184/api/workflow-runs/wfrun_1/steps/0/complete'),
    ),
    true,
  );
  assert.equal(
    isLatticeGeneratedCodexHooks('{"hooks":{"Stop":[{"hooks":[{"command":"npm run lint"}]}]}}'),
    false,
    "a repo's own hooks file must not be mistaken for ours",
  );
  assert.equal(isLatticeGeneratedCodexHooks('{"hooks":{"Stop":[]}}'), false);
});

test("installCodexStopHook('if-absent') replaces a STALE Lattice-generated file", async (t) => {
  const dir = await tmpDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // A hooks.json Lattice wrote for a DIFFERENT task, now tracked on main and
  // checked out into this fresh worktree.
  const stale = renderCodexStopHookJson(
    'http://127.0.0.1:5184/api/tasks/t_old/complete?source=codex-stop-hook-task-complete',
  );
  const file = codexHooksJsonPath(dir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, stale, 'utf8');

  const wrote = await installCodexStopHook(dir, URL, 'if-absent');
  assert.equal(wrote, true, 'a stale Lattice file must be rewritten, not preserved');
  assert.equal(await fs.readFile(file, 'utf8'), renderCodexStopHookJson(URL));
});

test('renderCodexStopHookJson adds tool-use + subagent activity hooks when given an activity URL', () => {
  const ACTIVITY = 'http://127.0.0.1:5184/api/tasks/abc/activity?source=codex-tool-hook';
  type Entry = { type: string; command: string; commandWindows: string; timeout: number };
  const parsed = JSON.parse(renderCodexStopHookJson(URL, ACTIVITY)) as {
    hooks: Record<string, { matcher?: string; hooks: Entry[] }[]>;
  };
  // The Stop hook is unchanged.
  assert.equal(parsed.hooks.Stop[0].hooks[0].commandWindows, `cmd /c ${parsed.hooks.Stop[0].hooks[0].command}`);
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const block = parsed.hooks[event][0];
    assert.match(block.matcher ?? '', /apply_patch/);
    assert.match(block.matcher ?? '', /Bash/);
  }
  for (const event of ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop']) {
    const entry = parsed.hooks[event][0].hooks[0];
    // Posts the hook's stdin JSON, unquoted, cmd /c on Windows. `-d@-`, never
    // `--data-binary @-`: Codex 0.157 runs hooks through PowerShell, which
    // rejects a bare `@-` (splatting) before curl starts.
    assert.ok(entry.command.startsWith('curl '), entry.command);
    assert.ok(entry.command.includes(' -d@- '));
    assert.ok(!/\s@/.test(entry.command), 'no token may start with @ (PowerShell splatting)');
    assert.ok(entry.command.endsWith(` ${ACTIVITY}`));
    assert.ok(!entry.command.includes('"'), 'no quotes — Codex spawns the argv directly');
    assert.equal(entry.commandWindows, `cmd /c ${entry.command}`);
  }
  // Without an activity URL only the Stop hook is written (the old shape).
  assert.deepEqual(Object.keys(JSON.parse(renderCodexStopHookJson(URL)).hooks), ['Stop']);
});
