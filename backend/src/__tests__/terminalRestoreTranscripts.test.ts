import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { terminalRegistry } from '../terminalRegistry/store.js';
import { restoreProjectTerminals, type RestoreDeps } from '../terminalRegistry/restore.js';
import { detectInterruption, lastConversationWrittenBy } from '../terminalRegistry/interruption.js';
import {
  CODEX_FRESH_START_WINDOW_MS,
  discoverCodexSessionFor,
  discoveryIntervalMs,
  resetCodexDiscoveryCaches,
} from '../terminalRegistry/codexDiscovery.js';
import { buildRestoreCommand } from '../terminalRegistry/restoreCommand.js';
import { agentSessionFromCommand, assignHarnessSessionId } from '../terminalRegistry/sessionIdentity.js';
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
//   - Claude `--resume Y` runs as process Y (its ~/.claude/sessions/<pid>.json
//     carries sessionId Y), so a re-learned id keeps working after relaunch.
//   - Codex: `session_meta.timestamp` is the process start; the rollout file
//     itself appears only on the first turn.
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
    // The production detector + Codex discovery — the point of this file.
    detectInterruption,
    discoverCodexSession: discoverCodexSessionFor,
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

// ── Conversation re-learning (the "claude! 2" tab, 2026-09-24) ──────────────

test('claude: a conversation switched inside the tab (/resume) is resumed by the id it actually wrote to', async () => {
  // The process launched as S, then /resume'd conversation Y: Claude appends
  // to Y.jsonl with session_id=S, and S.jsonl never exists.
  const h = await harness();
  await writeClaudeTranscript(h.project, Y, S);
  await deadTab(h, CLAUDE_LAUNCH, { harness: 'claude', id: S, source: 'minted' });
  await restoreProjectTerminals(h.project, h.deps);
  await settle();
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
  await settle();
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
  await settle();
  assert.equal(h.spawns[0].initialCommand, `claude --dangerously-skip-permissions --resume ${S}`);
  assert.equal(h.spawns[0].registry?.agentSession?.source, 'minted', 'no re-learn when it never switched');

  // Switched to Y after writing its own file: Y is newer and carries S's lines.
  const h2 = await harness();
  const own2 = await writeClaudeTranscript(h2.project, S, S);
  await fs.utimes(own2, past, past);
  await writeClaudeTranscript(h2.project, Y, S);
  await deadTab(h2, CLAUDE_LAUNCH, { harness: 'claude', id: S, source: 'minted' });
  await restoreProjectTerminals(h2.project, h2.deps);
  await settle();
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
  assert.equal(agentSessionFromCommand('codex resume --last --yolo'), undefined);
  assert.equal(agentSessionFromCommand('codex --yolo "fix --resume handling"'), undefined);
  assert.equal(agentSessionFromCommand('claude "explain --session-id"'), undefined);
  assert.equal(agentSessionFromCommand('npm run dev'), undefined);
  assert.equal(agentSessionFromCommand(undefined), undefined);
});

// ── Codex discovery ─────────────────────────────────────────────────────────

async function writeCodexRollout(cwd: string, id: string, startedAt: number): Promise<string> {
  const d = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dir = path.join(process.env.CODEX_HOME!, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-${d.toISOString().replace(/[:.]/g, '-')}-${id}.jsonl`);
  const meta = { timestamp: new Date().toISOString(), type: 'session_meta', payload: { id, cwd, timestamp: d.toISOString() } };
  await fs.writeFile(file, JSON.stringify(meta) + '\n');
  return file;
}

test('codex: a thread whose first turn landed after the old 2-minute poll is found at relaunch and resumed by id', async () => {
  resetCodexDiscoveryCaches();
  const h = await harness();
  await deadTab(h, { initialCommand: 'codex --yolo', harness: 'codex' });
  // The process started right after the tab; the file appeared minutes later.
  await writeCodexRollout(h.project, 'thread-late', Date.now() + 1_000);
  await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.equal(h.spawns[0].initialCommand, 'codex resume thread-late --yolo');
});

test('codex: a thread started long after the tab launched belongs to another tab and is not claimed', async () => {
  resetCodexDiscoveryCaches();
  const h = await harness();
  await deadTab(h, { initialCommand: 'codex --yolo', harness: 'codex' });
  await writeCodexRollout(h.project, 'someone-elses', Date.now() + CODEX_FRESH_START_WINDOW_MS + 60_000);
  await restoreProjectTerminals(h.project, h.deps);
  await settle();
  assert.equal(h.spawns[0].initialCommand, 'codex resume --last --yolo');
});

test('codex discovery backs off instead of giving up', () => {
  assert.equal(discoveryIntervalMs(0), 2_000);
  assert.equal(discoveryIntervalMs(119_000), 2_000);
  assert.equal(discoveryIntervalMs(5 * 60_000), 15_000);
  assert.equal(discoveryIntervalMs(3 * 60 * 60_000), 60_000);
});
