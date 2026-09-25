import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeActivityHook } from '../activityHook.js';

test('decodeActivityHook emits subagent lifecycle only with an id', () => {
  assert.deepEqual(
    decodeActivityHook(
      {
        hook_event_name: 'SubagentStart',
        agent_id: 'sub-1',
        agent_type: 'Explore',
      },
      () => '/unused',
    ),
    {
      kind: 'lifecycle',
      lifecycle: 'spawn',
      subagentId: 'sub-1',
      subagentType: 'Explore',
    },
  );

  assert.deepEqual(
    decodeActivityHook(
      {
        hook_event_name: 'SubagentStop',
        agent_id: 'sub-1',
      },
      () => '/unused',
    ),
    {
      kind: 'lifecycle',
      lifecycle: 'stop',
      subagentId: 'sub-1',
      subagentType: undefined,
    },
  );

  assert.equal(
    decodeActivityHook({ hook_event_name: 'SubagentStart' }, () => '/unused'),
    null,
  );
  assert.equal(
    decodeActivityHook(
      { hook_event_name: 'SubagentStop', agent_id: '' },
      () => '/unused',
    ),
    null,
  );
});

test('decodeActivityHook maps PreToolUse/PostToolUse file activity', () => {
  const mapped: string[] = [];
  const mapFile = (raw: string): string | null => {
    mapped.push(raw);
    return `/project/${raw}`;
  };

  assert.deepEqual(
    decodeActivityHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: 'src/app.ts' },
      },
      mapFile,
    ),
    {
      kind: 'tool',
      files: ['/project/src/app.ts'],
      phase: 'start',
      tool: 'Read',
      subagentId: undefined,
      subagentType: undefined,
    },
  );

  assert.deepEqual(
    decodeActivityHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/app.ts' },
      },
      mapFile,
    ),
    {
      kind: 'tool',
      files: ['/project/src/app.ts'],
      phase: 'end',
      tool: 'Edit',
      subagentId: undefined,
      subagentType: undefined,
    },
  );
  assert.deepEqual(mapped, ['src/app.ts', 'src/app.ts']);
});

test('decodeActivityHook drops missing or unmappable file activity', () => {
  let called = false;
  assert.equal(
    decodeActivityHook(
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} },
      () => {
        called = true;
        return '/project/unused';
      },
    ),
    null,
  );
  assert.equal(called, false);

  assert.equal(
    decodeActivityHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: 'scratch.txt' },
      },
      () => null,
    ),
    null,
  );
});

test('decodeActivityHook preserves subagent attribution on tool-use', () => {
  assert.deepEqual(
    decodeActivityHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        agent_id: 'sub-2',
        agent_type: 'Plan',
        tool_input: { file_path: 'src/plan.ts' },
      },
      (raw) => `/mapped/${raw}`,
    ),
    {
      kind: 'tool',
      files: ['/mapped/src/plan.ts'],
      phase: 'start',
      tool: 'Write',
      subagentId: 'sub-2',
      subagentType: 'Plan',
    },
  );
});

test('decodeActivityHook maps notebook-path tool payloads with subagent attribution', () => {
  assert.deepEqual(
    decodeActivityHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'NotebookEdit',
        agent_id: 'sub-3',
        agent_type: 'general-purpose',
        tool_input: { notebook_path: 'notebooks/demo.ipynb' },
      },
      (raw) => `/repo/${raw}`,
    ),
    {
      kind: 'tool',
      files: ['/repo/notebooks/demo.ipynb'],
      phase: 'end',
      tool: 'NotebookEdit',
      subagentId: 'sub-3',
      subagentType: 'general-purpose',
    },
  );
});

test('decodeActivityHook maps every file on a Codex apply_patch', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/a.ts',
    '@@',
    '-x',
    '+y',
    '*** Add File: src/b.ts',
    '+new',
    '*** Delete File: src/old.ts',
    '*** End Patch',
  ].join('\n');
  const seen: Array<[string, boolean]> = [];
  assert.deepEqual(
    decodeActivityHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        agent_id: 'thread-2',
        agent_type: 'worker',
        tool_input: { command: patch },
      },
      (raw, { mustExist }) => {
        seen.push([raw, mustExist]);
        return `/p/${raw}`;
      },
    ),
    {
      kind: 'tool',
      files: ['/p/src/a.ts', '/p/src/b.ts', '/p/src/old.ts'],
      phase: 'start',
      tool: 'apply_patch',
      subagentId: 'thread-2',
      subagentType: 'worker',
    },
  );
  // Patch headers are authoritative — no existence check.
  assert.ok(seen.every(([, mustExist]) => mustExist === false));
});

test('decodeActivityHook keeps only confirmed files from a Codex shell command', () => {
  const seen: Array<[string, boolean]> = [];
  const result = decodeActivityHook(
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: "sed -n '1,200p' src/app.ts && cat README.md missing.ts" },
    },
    (raw, { mustExist }) => {
      seen.push([raw, mustExist]);
      return raw === 'missing.ts' ? null : `/p/${raw}`;
    },
  );
  assert.deepEqual(result, {
    kind: 'tool',
    files: ['/p/src/app.ts', '/p/README.md'],
    phase: 'end',
    tool: 'Bash',
    subagentId: undefined,
    subagentType: undefined,
  });
  // Shell paths are guesses: every candidate is checked for existence.
  assert.deepEqual(seen, [
    ['src/app.ts', true],
    ['README.md', true],
    ['missing.ts', true],
  ]);
});

test('decodeActivityHook drops a shell command that names no file', () => {
  assert.equal(
    decodeActivityHook(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } },
      () => '/p/x',
    ),
    null,
  );
});
