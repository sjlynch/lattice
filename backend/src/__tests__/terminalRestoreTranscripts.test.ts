import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { terminalRegistry } from '../terminalRegistry/store.js';
import { restoreProjectTerminals, type RestoreDeps } from '../terminalRegistry/restore.js';
import { detectInterruption } from '../terminalRegistry/interruption.js';
import { buildRestoreCommand } from '../terminalRegistry/restoreCommand.js';
import { assignHarnessSessionId } from '../terminalRegistry/sessionIdentity.js';
import {
  claudeProjectDirName,
  claudeTranscriptPath,
  piSessionDirName,
} from '../terminalRegistry/harnessPaths.js';
import type { CreateSessionOptions, CreateSessionResult } from '../terminalServerClient/createSession.js';
import type { AgentSessionRef, TerminalLaunch, TerminalRecord } from '../terminalRegistry/types.js';

// The restore flow end to end against REAL harness files. terminalRestore.test.ts
// covers the decision matrix with the interruption detector stubbed; here the
// production `detectInterruption` reads transcripts laid out exactly where the
// harness writes them, so a drift in the path encoding or the resume/fresh
// choice shows up as the wrong relaunch command.
//
// Harness facts these fixtures mirror (checked on Windows, 2026-09-24,
// Claude Code 2.1.281 / Pi 0.80.7 / Codex 0.155.1):
//   - Claude: ~/.claude/projects/<cwd, non-alnum → '-'>/<id>.jsonl, created on
//     the first turn. In interactive transcripts `sessionId` is the
//     conversation and `session_id` the process that wrote the line.
//   - Pi: `--session-id X` writes <sessions>/<ts>_X.jsonl and reuses it on the
//     next launch with the same id (create-or-resume).

// Every harness home points into a throwaway dir for this file, so fixtures
// can never land in a developer's real ~/.claude / ~/.pi / ~/.codex even if
// one of these variables is set in their shell.
const harnessHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-harness-home-'));
const savedEnv: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries({
  CLAUDE_CONFIG_DIR: path.join(harnessHome, 'claude'),
  PI_CODING_AGENT_DIR: path.join(harnessHome, 'pi'),
  CODEX_HOME: path.join(harnessHome, 'codex'),
  PI_CODING_AGENT_SESSION_DIR: undefined,
})) {
  savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
test.after(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(harnessHome, { recursive: true, force: true });
});

let counter = 0;

type Harness = {
  project: string;
  deps: RestoreDeps;
  spawns: CreateSessionOptions[];
  live: { ids: string[]; sessions: Array<{ id: string; cwd: string; initialCommand?: string }> };
};

async function harness(): Promise<Harness> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), `lattice-restore-tx-${++counter}-`));
  const h: Harness = { project, spawns: [], live: { ids: [], sessions: [] }, deps: undefined as unknown as RestoreDeps };
  h.deps = {
    readLiveSessions: async () => ({ instanceId: 'inst-B', serverIds: new Set(h.live.ids) }),
    listLiveSessions: async () => h.live.sessions,
    createSession: async (opts): Promise<CreateSessionResult> => {
      h.spawns.push(opts);
      const id = `tty_new_${h.spawns.length}`;
      if (opts.registry?.existingId) {
        await terminalRegistry.update(opts.registry.existingId, {
          serverId: id, serverInstanceId: 'inst-B', ended: undefined, restoredAt: Date.now(),
        }, opts.projectPath);
      }
      return { id, terminalId: opts.registry?.existingId };
    },
    killSession: async () => true,
    enqueue: ((args: { thunk: () => Promise<unknown> }) => ({ queued: false, done: args.thunk() })) as unknown as RestoreDeps['enqueue'],
    getTask: async () => null,
    getUserSettings: async () => ({}),
    // The production detector — the point of this file.
    detectInterruption,
    dirExists: async (p) => { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } },
    now: Date.now,
  };
  return h;
}

// A dead user tab from the previous executor instance, ready to relaunch.
function deadTab(h: Harness, launch: TerminalLaunch, agentSession?: AgentSessionRef) {
  return terminalRegistry.create({
    projectPath: h.project,
    cwd: h.project,
    label: launch.harness ?? 'terminal',
    owner: 'user',
    launch,
    ...(agentSession ? { agentSession } : {}),
    serverId: 'tty_old',
    serverInstanceId: 'inst-A',
  });
}

const settle = () => new Promise((r) => setTimeout(r, 20));

// Minimal interactive-Claude transcript lines: a finished turn.
function claudeLines(conversationId: string, processId: string): string {
  const base = { sessionId: conversationId, session_id: processId, cwd: 'x', version: '2.1.281' };
  return [
    { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: conversationId },
    { ...base, type: 'user', message: { role: 'user', content: 'hello' }, uuid: 'u1' },
    { ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, uuid: 'a1' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n';
}

async function writeClaudeTranscript(cwd: string, conversationId: string, processId = conversationId) {
  const file = claudeTranscriptPath(cwd, conversationId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, claudeLines(conversationId, processId));
  return file;
}

const CLAUDE_LAUNCH: TerminalLaunch = { initialCommand: 'claude --dangerously-skip-permissions', harness: 'claude' };
const S = '5db2444b-3d99-4837-a5d1-74f9f848de72';
const Y = '42ae6ee1-0c41-45b4-8bc4-dfad5e661bcb';

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
  await settle();
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].initialCommand, `claude --dangerously-skip-permissions --resume ${S}`);
});

test('claude: no transcript (never reached a first turn) → relaunch under the same id, fresh', async () => {
  const h = await harness();
  await deadTab(h, CLAUDE_LAUNCH, { harness: 'claude', id: S, source: 'minted' });
  await restoreProjectTerminals(h.project, h.deps);
  await settle();
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
  await settle();
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
  await settle();
  assert.equal(h.spawns[0].initialCommand, `pi --session-id ${id}`);
});

test('codex: a discovered thread id resumes by id; an undiscovered one falls back to --last', async () => {
  const h = await harness();
  await deadTab(h, { initialCommand: 'codex --yolo', harness: 'codex' }, { harness: 'codex', id: 'thread-1', source: 'rollout-scan' });
  await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.equal(h.spawns[0].initialCommand, 'codex resume thread-1 --yolo');

  const h2 = await harness();
  await deadTab(h2, { initialCommand: 'codex --yolo', harness: 'codex' });
  await restoreProjectTerminals(h2.project, h2.deps);
  await settle();
  assert.equal(h2.spawns[0].initialCommand, 'codex resume --last --yolo');
});

// ── Known gaps. These describe the behaviour we want and currently FAIL;
// `todo` keeps them visible without failing the suite. Drop the flag when
// the fix lands.

test('claude: a conversation switched inside the tab (/resume) is resumed by the id it actually wrote to', {
  todo: 'restore trusts the id pinned at launch; it never re-learns it (tab "claude! 2", 2026-09-24)',
}, async () => {
  // The process launched as S, then /resume'd conversation Y: Claude appends
  // to Y.jsonl with session_id=S, and S.jsonl never exists.
  const h = await harness();
  await writeClaudeTranscript(h.project, Y, S);
  await deadTab(h, CLAUDE_LAUNCH, { harness: 'claude', id: S, source: 'minted' });
  await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.equal(h.spawns[0].initialCommand, `claude --dangerously-skip-permissions --resume ${Y}`);
});

test('adopting an orphan pty by cwd takes over that pty\'s session id', {
  todo: 'restore.ts step 2 re-points serverId but keeps the record\'s old agentSession',
}, async () => {
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
  assert.equal(after.agentSession?.id, S);
});
