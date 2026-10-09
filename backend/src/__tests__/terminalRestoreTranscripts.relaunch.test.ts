// Restore relaunch commands decided by REAL harness files (the decision matrix
// with the detector stubbed is terminalRestore.*.test.ts). The path encodings
// match the directories the harnesses actually create; Claude resumes a
// conversation whose transcript exists at Claude's own path — even an empty
// one, since `--session-id` with an id Claude already has a file for fails
// "already in use" — and relaunches under the same id, fresh, when it never
// reached a first turn; Pi always targets the pinned id (`--session-id X` is
// create-or-resume); Codex resumes a discovered thread by id, else `--last`;
// every relaunch command passes back through the spawn chokepoint without a
// second session id (a stacked fresh --session-id would open a new
// conversation instead of the old one). Harness:
// helpers/terminalRestoreTranscripts.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { restoreProjectTerminals } from '../terminalRegistry/restore.js';
import { buildRestoreCommand } from '../terminalRegistry/restoreCommand.js';
import { assignHarnessSessionId } from '../terminalRegistry/sessionIdentity.js';
import {
  claudeProjectDirName,
  claudeTranscriptPath,
  piSessionDirName,
} from '../terminalRegistry/harnessPaths.js';
import type { AgentSessionRef, TerminalLaunch } from '../terminalRegistry/types.js';
import { CLAUDE_LAUNCH, deadTab, harness, S, settle, writeClaudeTranscript } from './helpers/terminalRestoreTranscripts.js';

test('path encodings match the directories the harnesses actually create', () => {
  // Claude: every non-alphanumeric → '-' (so `\.lattice` becomes `--lattice`
  // and `-_` becomes `--`). Pi: only `/ \ :` → '-', wrapped in `--…--`.
  const worktree = 'C:\\Users\\dev\\.lattice\\worktrees\\fd51909fc777\\bug-a-banned-ip-_254g8';
  assert.equal(claudeProjectDirName(worktree), 'C--Users-dev--lattice-worktrees-fd51909fc777-bug-a-banned-ip--254g8');
  assert.equal(piSessionDirName(worktree), '--C--Users-dev-.lattice-worktrees-fd51909fc777-bug-a-banned-ip-_254g8--');
  assert.equal(claudeProjectDirName('C:\\development\\ody\\rewrite'), 'C--development-ody-rewrite');
});

test('claude: a transcript at Claude\'s own path → relaunch resumes that conversation', async () => {
  const h = await harness();
  await writeClaudeTranscript(h.project, S);
  await deadTab(h, CLAUDE_LAUNCH, { harness: 'claude', id: S, source: 'minted' });
  await restoreProjectTerminals(h.project, h.deps);
  await settle(h.spawns);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].initialCommand, `claude --dangerously-skip-permissions --resume ${S}`);
});

test('claude: no transcript (never reached a first turn) → relaunch under the same id, fresh', async () => {
  const h = await harness();
  await deadTab(h, CLAUDE_LAUNCH, { harness: 'claude', id: S, source: 'minted' });
  await restoreProjectTerminals(h.project, h.deps);
  await settle(h.spawns);
  assert.equal(h.spawns[0].initialCommand, `claude --dangerously-skip-permissions --session-id ${S}`);
});

test('claude: an empty transcript file still counts as existing (resume, not a clashing --session-id)', async () => {
  // `--session-id` with an id Claude already has a file for fails "already in
  // use", so any existing file must pick --resume.
  const h = await harness();
  const file = claudeTranscriptPath(h.project, S);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '');
  await deadTab(h, CLAUDE_LAUNCH, { harness: 'claude', id: S, source: 'minted' });
  await restoreProjectTerminals(h.project, h.deps);
  await settle(h.spawns);
  assert.equal(h.spawns[0].initialCommand, `claude --dangerously-skip-permissions --resume ${S}`);
});

test('every relaunch command passes back through the spawn chokepoint without a second session id', () => {
  // proxyCreateSession runs assignHarnessSessionId on EVERY command, relaunches
  // included. If it stacked a fresh --session-id onto a resume, the relaunch
  // would open a new conversation instead of the old one.
  const cases: Array<{ launch: TerminalLaunch; session?: AgentSessionRef; transcript?: boolean }> = [
    { launch: CLAUDE_LAUNCH, session: { harness: 'claude', id: S, source: 'minted' }, transcript: true },
    { launch: CLAUDE_LAUNCH, session: { harness: 'claude', id: S, source: 'minted' }, transcript: false },
    {
      launch: { initialCommand: 'pi --model "my-vllm/meta-llama/Llama-3.1-8B-Instruct"', harness: 'pi' },
      session: { harness: 'pi', id: 'lattice-11111111-2222-4333-8444-555555555555', source: 'minted' },
    },
    { launch: { initialCommand: 'codex --yolo', harness: 'codex' }, session: { harness: 'codex', id: 'abc', source: 'rollout-scan' } },
    { launch: { initialCommand: 'codex --yolo', harness: 'codex' } },
  ];
  for (const c of cases) {
    const built = buildRestoreCommand({ launch: c.launch, agentSession: c.session, claudeTranscriptExists: c.transcript });
    assert.ok(built.command, `${c.launch.initialCommand} builds a command`);
    const again = assignHarnessSessionId(built.command);
    assert.equal(again.command, built.command, `${built.command} is not re-pinned`);
    assert.equal(again.agentSession, undefined, `${built.command} claims no new identity`);
  }
});

test('pi: the relaunch always targets the pinned id (Pi creates or resumes it)', async () => {
  const h = await harness();
  const id = 'lattice-11111111-2222-4333-8444-555555555555';
  await deadTab(h, { initialCommand: 'pi', harness: 'pi' }, { harness: 'pi', id, source: 'minted' });
  await restoreProjectTerminals(h.project, h.deps);
  await settle(h.spawns);
  assert.equal(h.spawns[0].initialCommand, `pi --session-id ${id}`);
});

test('codex: a discovered thread id resumes by id; an undiscovered one falls back to --last', async () => {
  const h = await harness();
  await deadTab(h, { initialCommand: 'codex --yolo', harness: 'codex' }, { harness: 'codex', id: 'thread-1', source: 'rollout-scan' });
  await restoreProjectTerminals(h.project, h.deps);
  await settle(h.spawns);
  assert.equal(h.spawns[0].initialCommand, 'codex resume thread-1 --yolo');

  const h2 = await harness();
  await deadTab(h2, { initialCommand: 'codex --yolo', harness: 'codex' });
  await restoreProjectTerminals(h2.project, h2.deps);
  await settle(h2.spawns);
  assert.equal(h2.spawns[0].initialCommand, 'codex resume --last --yolo');
});
