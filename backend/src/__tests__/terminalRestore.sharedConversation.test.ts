// One conversation, one live pty. Two harness processes resuming one
// conversation interleave their turns in a single transcript. A dead tab whose
// conversation another live tab already runs (the user `/resume`d it there —
// seen directly, or through the transcript lines the live process wrote) must
// not be relaunched into it: it ends restore-failed naming that tab. Two dead
// tabs on one conversation relaunch it once. Harness: helpers/terminalRestore.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { terminalRegistry } from '../terminalRegistry/store.js';
import { restoreProjectTerminals } from '../terminalRegistry/restore.js';
import { claudeTranscriptPath } from '../terminalRegistry/harnessPaths.js';
import { harness, record, settle } from './helpers/terminalRestore.js';

test('a relaunch never resumes a conversation a live tab already holds', async () => {
  const h = await harness();
  await record(h, { label: 'claude 7', serverId: 'tty_live', serverInstanceId: 'inst-B' });
  const dead = await record(h, { label: 'claude 6' });
  h.live.ids = ['tty_live'];
  await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.equal(h.spawns.length, 0);
  const ended = await terminalRegistry.get(dead.id, h.project);
  assert.equal(ended?.ended?.reason, 'restore-failed');
  assert.match(ended?.ended?.detail ?? '', /already open in tab "claude 7"/);
});

test('two dead tabs on one conversation relaunch it once', async () => {
  const h = await harness();
  const spawn = h.deps.createSession;
  h.deps.createSession = async (opts) => {
    const res = await spawn(opts);
    if ('id' in res) h.live.ids.push(res.id);
    return res;
  };
  const a = await record(h, { label: 'claude 1' });
  const b = await record(h, { label: 'claude 2' });
  await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.equal(h.spawns.length, 1);
  const states = await Promise.all([a, b].map((r) => terminalRegistry.get(r.id, h.project)));
  assert.equal(states.filter((s) => s?.ended?.reason === 'restore-failed').length, 1);
  assert.equal(states.filter((s) => s?.serverId?.startsWith('tty_new_')).length, 1);
});

test('an in-tab /resume is seen through the transcript: the live tab holds the dead tab\'s conversation', async () => {
  const h = await harness();
  // The live tab's process (pinned P7) resumed conversation C6, so its lines
  // land in C6's transcript tagged with session_id P7.
  const file = claudeTranscriptPath(h.project, 'C6');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ type: 'system', sessionId: 'C6', session_id: 'P7' })}\n`);
  await record(h, {
    label: 'claude 7', serverId: 'tty_live', serverInstanceId: 'inst-B',
    agentSession: { harness: 'claude', id: 'P7', source: 'minted' },
  });
  const dead = await record(h, { label: 'claude 6', agentSession: { harness: 'claude', id: 'C6', source: 'minted' } });
  h.live.ids = ['tty_live'];
  await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.equal(h.spawns.length, 0);
  assert.match((await terminalRegistry.get(dead.id, h.project))?.ended?.detail ?? '', /already open in tab "claude 7"/);
});
