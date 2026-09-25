import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodeTaskActivity } from '../routes/tasks/activity.js';
import { buildAgentActivityEvents } from '../routes/agentActivity.js';
import { canonicalProjectPath } from '../projectPath.js';

// Which file a Codex/Pi/Claude shell or patch tool use beams to, end to end
// through the task route's decode + worktree mapping, against a real worktree
// that has BOTH a root and a frontend/ package.json.

async function makeWorktree(t: TestContext) {
  // realpath: the mapping compares against the physical project path.
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-shell-cwd-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const wt = path.join(base, 'wt');
  await fs.mkdir(path.join(wt, 'frontend', 'src'), { recursive: true });
  await fs.writeFile(path.join(wt, 'package.json'), '{}');
  await fs.writeFile(path.join(wt, 'frontend', 'package.json'), '{}');
  await fs.writeFile(path.join(wt, 'frontend', 'src', 'real.ts'), '');
  const task = { worktreePath: wt, projectPath: path.join(base, 'repo') };
  const root = canonicalProjectPath(task.projectPath);
  return { base, wt, task, root };
}

function filesOf(result: ReturnType<typeof decodeTaskActivity>): string[] {
  return result && result.kind === 'tool' ? result.files : [];
}

test('a leading cd in a shell command beams to the file under that dir, not the root one', async (t) => {
  const { wt, task, root } = await makeWorktree(t);
  const fePkg = path.join(root, 'frontend', 'package.json');

  const cd = decodeTaskActivity(task, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    cwd: wt,
    tool_input: { command: 'cd frontend && cat package.json' },
  });
  assert.deepEqual(filesOf(cd), [fePkg]);

  const wrapped = decodeTaskActivity(task, {
    hook_event_name: 'PreToolUse',
    tool_name: 'exec_command',
    tool_input: { cmd: ['bash', '-lc', "cd frontend && sed -n '1,80p' package.json"] },
  });
  assert.deepEqual(filesOf(wrapped), [fePkg]);

  // A cd we can't follow drops the candidates instead of guessing the root.
  const twoCds = decodeTaskActivity(task, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'cd frontend && cd src && cat package.json' },
  });
  assert.equal(twoCds, null);
});

test('a shell tool workdir, and a hook cwd inside the worktree, are honoured', async (t) => {
  const { base, wt, task, root } = await makeWorktree(t);
  const fePkg = path.join(root, 'frontend', 'package.json');

  const workdir = decodeTaskActivity(task, {
    hook_event_name: 'PreToolUse',
    tool_name: 'exec_command',
    cwd: wt,
    tool_input: { cmd: 'cat package.json', workdir: 'frontend' },
  });
  assert.deepEqual(filesOf(workdir), [fePkg]);

  // A subagent running in frontend/ reports its own cwd.
  const subCwd = decodeTaskActivity(task, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: path.join(wt, 'frontend'),
    tool_input: { command: 'cat package.json' },
  });
  assert.deepEqual(filesOf(subCwd), [fePkg]);

  // A cwd outside the worktree is ignored — paths resolve at the worktree root.
  const outside = decodeTaskActivity(task, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: base,
    tool_input: { command: 'cat package.json' },
  });
  assert.deepEqual(filesOf(outside), [path.join(root, 'package.json')]);
});

test('the per-tool-use cap counts existing files, not raw candidates', async (t) => {
  const { task, root } = await makeWorktree(t);
  const junk = Array.from({ length: 9 }, (_, i) => `missing${i}.ts`).join(' ');
  const result = decodeTaskActivity(task, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: `rg -n ${junk} frontend/src/real.ts` },
  });
  assert.deepEqual(filesOf(result), [path.join(root, 'frontend', 'src', 'real.ts')]);
});

test('apply_patch Move / Delete / Add targets beam only while they exist', async (t) => {
  const { task, root } = await makeWorktree(t);
  // PostToolUse of a move: a.ts is gone, b.ts is there.
  const move = '*** Begin Patch\n*** Update File: frontend/src/a.ts\n*** Move to: frontend/src/real.ts\n@@\n-x\n+y\n*** End Patch';
  const post = decodeTaskActivity(task, {
    hook_event_name: 'PostToolUse',
    tool_name: 'apply_patch',
    tool_input: { command: move },
  });
  assert.deepEqual(filesOf(post), [path.join(root, 'frontend', 'src', 'real.ts')]);

  // PostToolUse of a delete: nothing left to beam to.
  const del = decodeTaskActivity(task, {
    hook_event_name: 'PostToolUse',
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Delete File: frontend/src/gone.ts\n*** End Patch' },
  });
  assert.equal(del, null);

  // PreToolUse of an add: the target doesn't exist yet; the updated file does.
  const add = decodeTaskActivity(task, {
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: {
      command: '*** Begin Patch\n*** Add File: frontend/src/new.ts\n+x\n*** Update File: package.json\n@@\n-a\n+b\n*** End Patch',
    },
  });
  assert.deepEqual(filesOf(add), [path.join(root, 'package.json')]);
});

// A workflow step's session sits in its step dir outside the project and cds
// into the project; relative paths after that cd used to resolve under the
// step dir and be dropped.
test('a non-worktree session that cds into the project beams to the project file', async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-shell-cwd-agent-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const project = path.join(base, 'proj');
  const stepDir = path.join(base, 'step');
  await fs.mkdir(path.join(project, 'backend', 'src'), { recursive: true });
  await fs.mkdir(stepDir, { recursive: true });
  await fs.writeFile(path.join(project, 'backend', 'src', 'x.ts'), '');
  const events = buildAgentActivityEvents(
    { projectPath: project, label: 'step' },
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `cd "${project}"; cat backend/src/x.ts` },
    },
    { agentId: 'wf:test', cwd: stepDir },
  );
  assert.deepEqual(
    events.map((e) => e.file),
    [path.join(canonicalProjectPath(project), 'backend', 'src', 'x.ts')],
  );
});
