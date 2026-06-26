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
      file: '/project/src/app.ts',
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
      file: '/project/src/app.ts',
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
      file: '/mapped/src/plan.ts',
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
      file: '/repo/notebooks/demo.ipynb',
      phase: 'end',
      tool: 'NotebookEdit',
      subagentId: 'sub-3',
      subagentType: 'general-purpose',
    },
  );
});
