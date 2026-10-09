// Shared harness for the split terminalRestoreTranscripts.* suites: the restore
// flow end to end against REAL harness files. Not a `*.test.ts` file, so it
// isn't collected as a suite. The terminalRestore.* suites cover the decision
// matrix with the interruption detector stubbed; here `harness()` wires the
// production `detectInterruption` and Codex discovery, which read transcripts /
// rollouts laid out exactly where the harness writes them (`claudeLines`,
// `writeClaudeTranscript`, `writeCodexRollout`), so a drift in the path
// encoding or the resume/fresh choice shows up as the wrong relaunch command.
//
// Harness facts these fixtures mirror (checked on Windows, 2026-09-24,
// Claude Code 2.1.281 / Pi 0.80.7 / Codex 0.155.1):
//   - Claude: ~/.claude/projects/<cwd, non-alnum → '-'>/<id>.jsonl, created on
//     the first turn. In interactive transcripts `sessionId` is the
//     conversation and `session_id` the process that wrote the line.
//   - Claude `--resume Y` runs as process Y (its ~/.claude/sessions/<pid>.json
//     carries sessionId Y), so a re-learned id keeps working after relaunch.
//   - Codex: `session_meta.timestamp` is the process start; the rollout file
//     itself appears only on the first turn. An incomplete first line must
//     be retried on later scans without clearing shared discovery caches.
//   - Pi: `--session-id X` writes <sessions>/<ts>_X.jsonl and reuses it on the
//     next launch with the same id (create-or-resume).
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { terminalRegistry } from '../../terminalRegistry/store.js';
import type { RestoreDeps } from '../../terminalRegistry/restore.js';
import { detectInterruption } from '../../terminalRegistry/interruption.js';
import { discoverCodexSessionFor } from '../../terminalRegistry/codexDiscovery.js';
import { claudeTranscriptPath } from '../../terminalRegistry/harnessPaths.js';
import type { CreateSessionOptions, CreateSessionResult } from '../../terminalServerClient/createSession.js';
import { recordSpawnedTerminal } from '../../terminalServerClient/recordSpawn.js';
import type { AgentSessionRef, TerminalLaunch } from '../../terminalRegistry/types.js';

// Every harness home points into a throwaway dir for this file, so fixtures
// can never land in a developer's real ~/.claude / ~/.pi / ~/.codex even if
// one of these variables is set in their shell.
export const harnessHome = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-harness-home-'));
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
  live: { ids: string[]; sessions: Array<{ id: string; cwd: string; initialCommand?: string; createdAt?: number }> };
};

export async function harness(): Promise<Harness> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), `lattice-restore-tx-${++counter}-`));
  const h: Harness = { project, spawns: [], live: { ids: [], sessions: [] }, deps: undefined as unknown as RestoreDeps };
  h.deps = {
    readLiveSessions: async () => ({ instanceId: 'inst-B', serverIds: new Set(h.live.ids) }),
    listLiveSessions: async () => h.live.sessions,
    createSession: async (opts): Promise<CreateSessionResult> => {
      h.spawns.push(opts);
      const id = `tty_new_${h.spawns.length}`;
      await recordSpawnedTerminal(opts, opts.initialCommand, id, 'inst-B', undefined);
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
export function deadTab(h: Harness, launch: TerminalLaunch, agentSession?: AgentSessionRef) {
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

// The relaunch spawn lands asynchronously after restoreProjectTerminals
// resolves. Wait for it (bounded) rather than a fixed 20 ms, which lost the race
// on a loaded machine (a full-suite run next to other work).
export const settle = async (spawns: unknown[]) => {
  const deadline = Date.now() + 5_000;
  do await new Promise((r) => setTimeout(r, 20));
  while (spawns.length === 0 && Date.now() < deadline);
};

// Minimal interactive-Claude transcript lines: a finished turn.
export function claudeLines(conversationId: string, processId: string): string {
  const base = { sessionId: conversationId, session_id: processId, cwd: 'x', version: '2.1.281' };
  return [
    { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: conversationId },
    { ...base, type: 'user', message: { role: 'user', content: 'hello' }, uuid: 'u1' },
    { ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, uuid: 'a1' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n';
}

export async function writeClaudeTranscript(cwd: string, conversationId: string, processId = conversationId) {
  const file = claudeTranscriptPath(cwd, conversationId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, claudeLines(conversationId, processId));
  return file;
}

export const CLAUDE_LAUNCH: TerminalLaunch = { initialCommand: 'claude --dangerously-skip-permissions', harness: 'claude' };
export const S = '5db2444b-3d99-4837-a5d1-74f9f848de72';
export const Y = '42ae6ee1-0c41-45b4-8bc4-dfad5e661bcb';

export async function writeCodexRollout(cwd: string, id: string, startedAt: number): Promise<string> {
  const d = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dir = path.join(process.env.CODEX_HOME!, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-${d.toISOString().replace(/[:.]/g, '-')}-${id}.jsonl`);
  const meta = { timestamp: new Date().toISOString(), type: 'session_meta', payload: { id, cwd, timestamp: d.toISOString() } };
  await fs.writeFile(file, JSON.stringify(meta) + '\n');
  return file;
}
