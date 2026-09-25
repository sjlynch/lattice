import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  installPiActivityExtension,
  PI_ACTIVITY_EXTENSION_FILE,
  removeProjectPiActivityExtension,
  renderPiActivityExtension,
} from '../piActivity.js';

const URL = 'http://127.0.0.1:5184/api/tasks/abc/activity?source=pi-activity-extension';

test('renderPiActivityExtension embeds the URL as a JSON literal and handles the tool events', () => {
  const src = renderPiActivityExtension(URL);
  assert.ok(src.includes(`const ACTIVITY_URL = ${JSON.stringify(URL)};`));
  for (const ev of ['tool_execution_start', 'tool_execution_end', 'session_start', 'session_shutdown']) {
    assert.ok(src.includes(`pi.on("${ev}"`), `handles ${ev}`);
  }
  // Posts the Claude hook shape the activity routes already decode.
  assert.ok(src.includes('hook_event_name: phase'));
  assert.ok(src.includes('"PreToolUse"') && src.includes('"PostToolUse"'));
  assert.ok(src.includes('SubagentStart') && src.includes('SubagentStop'));
});

test('installPiActivityExtension writes .pi/extensions/lattice-activity.ts and is idempotent', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-pi-activity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await installPiActivityExtension({ dir, activityUrl: URL });
  const file = path.join(dir, '.pi', 'extensions', PI_ACTIVITY_EXTENSION_FILE);
  assert.equal(await fs.readFile(file, 'utf8'), renderPiActivityExtension(URL));
  const before = (await fs.stat(file)).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await installPiActivityExtension({ dir, activityUrl: URL });
  assert.equal((await fs.stat(file)).mtimeMs, before, 'an identical file is not rewritten');
});

// Load a rendered extension as a module and drive it with a fake Pi API,
// capturing what it POSTs.
async function driveExtension(
  src: string,
  run: (emit: (event: string, payload: unknown, ctx: unknown) => void) => void,
): Promise<Record<string, unknown>[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-pi-activity-run-'));
  const file = path.join(dir, 'ext.mjs');
  await fs.writeFile(file, src);
  const posted: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    posted.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  try {
    const mod = (await import(pathToFileURL(file).href)) as {
      default: (pi: { on: (e: string, h: (ev: unknown, ctx: unknown) => void) => void }) => void;
    };
    const handlers = new Map<string, (ev: unknown, ctx: unknown) => void>();
    mod.default({ on: (e, h) => handlers.set(e, h) });
    run((event, payload, ctx) => handlers.get(event)?.(payload, ctx));
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    globalThis.fetch = realFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
  return posted;
}

const ctxFor = (id: string, persisted: boolean) => ({
  cwd: '/proj',
  sessionManager: { getSessionId: () => id, getSessionFile: () => (persisted ? `/s/${id}.jsonl` : undefined) },
});

test('project mode: session lifecycle + session_id on every body; a subagent reports under its parent', async () => {
  const src = renderPiActivityExtension('http://127.0.0.1:5184/api/project-activity/T', { projectSession: true });
  const main = ctxFor('main-1', true);
  const sub = ctxFor('sub-1', false);
  const posted = await driveExtension(src, (emit) => {
    emit('session_start', { reason: 'startup' }, main);
    emit('agent_start', {}, main);
    emit('tool_execution_start', { toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts' } }, main);
    emit('session_start', { reason: 'startup' }, sub);
    emit('agent_start', {}, sub); // a subagent's run is not a turn of the parent
    emit('tool_execution_start', { toolCallId: 'c2', toolName: 'read', args: { path: 'b.ts' } }, sub);
    emit('agent_settled', {}, sub);
    emit('session_shutdown', { reason: 'quit' }, sub);
    emit('agent_settled', {}, main);
    emit('session_shutdown', { reason: 'reload' }, main); // same id resumes — no SessionEnd
    emit('session_shutdown', { reason: 'quit' }, main);
  });
  assert.deepEqual(
    posted.map((b) => [b.hook_event_name, b.session_id, b.agent_id ?? null]),
    [
      ['SessionStart', 'main-1', null],
      ['UserPromptSubmit', 'main-1', null],
      ['PreToolUse', 'main-1', null],
      ['SubagentStart', 'main-1', 'pi-sub-1'],
      ['PreToolUse', 'main-1', 'pi-sub-1'],
      ['SubagentStop', 'main-1', 'pi-sub-1'],
      ['Stop', 'main-1', null],
      ['SessionEnd', 'main-1', null],
    ],
  );
  assert.deepEqual(posted[2].tool_input, { file_path: 'a.ts' });
});

test('task mode posts no session lifecycle and no session_id (presence is the spawn registry)', async () => {
  const posted = await driveExtension(renderPiActivityExtension(URL), (emit) => {
    const main = ctxFor('main-2', true);
    emit('session_start', { reason: 'startup' }, main);
    emit('agent_start', {}, main);
    emit('tool_execution_start', { toolCallId: 'c1', toolName: 'edit', args: { path: 'a.ts' } }, main);
    emit('agent_settled', {}, main);
    emit('session_shutdown', { reason: 'quit' }, main);
  });
  assert.deepEqual(posted.map((b) => [b.hook_event_name, 'session_id' in b]), [['PreToolUse', false]]);
});

test('removeProjectPiActivityExtension deletes only a project-mode extension', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-pi-activity-rm-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.pi', 'extensions', PI_ACTIVITY_EXTENSION_FILE);
  await installPiActivityExtension({ dir, activityUrl: URL });
  await removeProjectPiActivityExtension(dir);
  assert.ok(await fs.stat(file), 'a task-mode file is left alone');
  await installPiActivityExtension({
    dir, activityUrl: 'http://127.0.0.1:5184/api/project-activity/T', projectSession: true,
  });
  await removeProjectPiActivityExtension(dir);
  await assert.rejects(fs.stat(file));
});
