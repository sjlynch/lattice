import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
  installPiActivityExtension,
  PI_ACTIVITY_EXTENSION_FILE,
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
