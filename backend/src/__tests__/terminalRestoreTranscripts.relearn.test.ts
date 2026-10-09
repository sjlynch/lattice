// Conversation re-learning against real Claude transcripts (the "claude! 2"
// tab, 2026-09-24). In interactive transcripts `sessionId` is the conversation
// and `session_id` the process that wrote the line, so a conversation switched
// inside the tab (/resume) is resumed by the id the process actually wrote to,
// and the relaunch records the re-learned id — which keeps working because
// `claude --resume Y` runs as process Y. The switch is still found several
// relaunches later (the floor is the tab's creation); the conversation written
// LAST wins while another tab's newer transcript is ignored; a prompt that
// merely mentions an id is not a line written by it; adopting an orphan pty by
// cwd takes over the session id its command carries, read per harness.
// Harness: helpers/terminalRestoreTranscripts.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { terminalRegistry } from '../terminalRegistry/store.js';
import { restoreProjectTerminals } from '../terminalRegistry/restore.js';
import { lastConversationWrittenBy } from '../terminalRegistry/interruption.js';
import { agentSessionFromCommand } from '../terminalRegistry/sessionIdentity.js';
import type { TerminalRecord } from '../terminalRegistry/types.js';
import {
  CLAUDE_LAUNCH,
  claudeLines,
  deadTab,
  harness,
  S,
  settle,
  writeClaudeTranscript,
  Y,
} from './helpers/terminalRestoreTranscripts.js';

test('claude: a conversation switched inside the tab (/resume) is resumed by the id it actually wrote to', async () => {
  // The process launched as S, then /resume'd conversation Y: Claude appends
  // to Y.jsonl with session_id=S, and S.jsonl never exists.
  const h = await harness();
  await writeClaudeTranscript(h.project, Y, S);
  await deadTab(h, CLAUDE_LAUNCH, { harness: 'claude', id: S, source: 'minted' });
  await restoreProjectTerminals(h.project, h.deps);
  await settle(h.spawns);
  assert.equal(h.spawns[0].initialCommand, `claude --dangerously-skip-permissions --resume ${Y}`);
  // …and the relaunch records the re-learned id, so the NEXT restart resumes
  // it directly (the resumed process runs as Y).
  assert.deepEqual(h.spawns[0].registry?.agentSession, { harness: 'claude', id: Y, source: 'transcript-scan' });
});

test('adopting an orphan pty by cwd takes over that pty\'s session id', async () => {
  const h = await harness();
  const r = await deadTab(h, CLAUDE_LAUNCH, { harness: 'claude', id: 'S1', source: 'minted' });
  await terminalRegistry.update(r.id, { serverId: undefined, serverInstanceId: undefined }, h.project);
  h.live.ids = ['tty_orphan'];
  h.live.sessions = [{
    id: 'tty_orphan', cwd: h.project, initialCommand: `claude --dangerously-skip-permissions --session-id ${S}`,
  }];
  await restoreProjectTerminals(h.project, h.deps);
  const after = (await terminalRegistry.get(r.id, h.project)) as TerminalRecord;
  assert.equal(after.serverId, 'tty_orphan');
  assert.deepEqual(after.agentSession, { harness: 'claude', id: S, source: 'command' });
});

test('claude: a switch made several relaunches ago is still found (floor is the tab\'s creation)', async () => {
  // Every relaunch since the switch was a fresh `--session-id S` nobody typed
  // into, so the conversation's file is OLDER than the last relaunch.
  const h = await harness();
  const r = await deadTab(h, CLAUDE_LAUNCH, { harness: 'claude', id: S, source: 'minted' });
  await writeClaudeTranscript(h.project, Y, S);
  await terminalRegistry.update(r.id, { restoredAt: Date.now() + 10 * 60_000, restoreCount: 3 }, h.project);
  await restoreProjectTerminals(h.project, h.deps);
  await settle(h.spawns);
  assert.equal(h.spawns[0].initialCommand, `claude --dangerously-skip-permissions --resume ${Y}`);
});

test('claude: the conversation written LAST wins; another tab\'s newer transcript is ignored', async () => {
  const past = new Date(Date.now() - 1000);
  // Never switched: another process's newer transcript must not hijack it.
  const h = await harness();
  const own = await writeClaudeTranscript(h.project, S, S);
  await fs.utimes(own, past, past);
  await writeClaudeTranscript(h.project, Y, 'someone-else');
  await deadTab(h, CLAUDE_LAUNCH, { harness: 'claude', id: S, source: 'minted' });
  await restoreProjectTerminals(h.project, h.deps);
  await settle(h.spawns);
  assert.equal(h.spawns[0].initialCommand, `claude --dangerously-skip-permissions --resume ${S}`);
  assert.equal(h.spawns[0].registry?.agentSession?.source, 'minted', 'no re-learn when it never switched');

  // Switched to Y after writing its own file: Y is newer and carries S's lines.
  const h2 = await harness();
  const own2 = await writeClaudeTranscript(h2.project, S, S);
  await fs.utimes(own2, past, past);
  await writeClaudeTranscript(h2.project, Y, S);
  await deadTab(h2, CLAUDE_LAUNCH, { harness: 'claude', id: S, source: 'minted' });
  await restoreProjectTerminals(h2.project, h2.deps);
  await settle(h2.spawns);
  assert.equal(h2.spawns[0].initialCommand, `claude --dangerously-skip-permissions --resume ${Y}`);
});

test('lastConversationWrittenBy reads the process id, not the conversation id', () => {
  const text = claudeLines(Y, 'P1') + claudeLines(Y, S) + '{"partial":';
  assert.equal(lastConversationWrittenBy(text, S), Y);
  assert.equal(lastConversationWrittenBy(text, 'P2'), null);
  // A prompt that merely MENTIONS the id is not a line written by it.
  const mention = JSON.stringify({ sessionId: Y, session_id: 'P1', message: { content: `"session_id":"${S}"` } });
  assert.equal(lastConversationWrittenBy(mention, S), null);
});

test('agentSessionFromCommand reads the id each harness\'s spawned command carries', () => {
  assert.deepEqual(agentSessionFromCommand(`claude --dangerously-skip-permissions --session-id ${S}`), { harness: 'claude', id: S, source: 'command' });
  assert.deepEqual(agentSessionFromCommand(`claude --resume ${Y} "continue"`), { harness: 'claude', id: Y, source: 'command' });
  assert.deepEqual(agentSessionFromCommand(`claude --resume=${Y}`), { harness: 'claude', id: Y, source: 'command' });
  assert.deepEqual(agentSessionFromCommand('pi --model "a/b" --session-id lattice-x'), { harness: 'pi', id: 'lattice-x', source: 'command' });
  assert.deepEqual(agentSessionFromCommand('codex resume thread-9 --yolo -c tui.x=1'), { harness: 'codex', id: 'thread-9', source: 'command' });
  assert.deepEqual(agentSessionFromCommand('codex resume thread-9'), { harness: 'codex', id: 'thread-9', source: 'command' });
  assert.deepEqual(agentSessionFromCommand('codex resume "thread-9"'), { harness: 'codex', id: 'thread-9', source: 'command' });
  assert.equal(agentSessionFromCommand('codex resume --last --yolo'), undefined);
  assert.equal(agentSessionFromCommand('codex resume --last --yolo continue'), undefined);
  assert.equal(agentSessionFromCommand('codex --yolo "fix --resume handling"'), undefined);
  assert.equal(agentSessionFromCommand('claude "explain --session-id"'), undefined);
  assert.equal(agentSessionFromCommand('npm run dev'), undefined);
  assert.equal(agentSessionFromCommand(undefined), undefined);
});
