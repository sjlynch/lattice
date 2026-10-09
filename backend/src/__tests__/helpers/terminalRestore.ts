// Shared harness for the split terminalRestore.* suites (the restore decision
// matrix). Not a `*.test.ts` file, so it isn't collected as a suite.
//
// `harness()` drives restoreProjectTerminals through the real registry store
// (home is redirected to a temp dir by the test preload) with every external
// effect injected: live-session view, pty creation, the spawn queue, task
// lookup, settings and the interruption detector (stubbed here; the production
// detector runs against real harness files in terminalRestoreTranscripts.*).
// `record()` creates a tab left by the previous executor instance; `settle()`
// lets the fire-and-forget relaunch thunks land.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { terminalRegistry } from '../../terminalRegistry/store.js';
import type { RestoreDeps } from '../../terminalRegistry/restore.js';
import type { CreateSessionOptions, CreateSessionResult } from '../../terminalServerClient/createSession.js';
import type { TerminalRecord, TerminalRegistryEvent } from '../../terminalRegistry/types.js';
import type { Task } from '../../tasks.js';

type Harness = {
  project: string;
  deps: RestoreDeps;
  spawns: CreateSessionOptions[];
  kills: string[];
  events: TerminalRegistryEvent[];
  live: { instanceId: string; ids: string[]; sessions: Array<{ id: string; cwd: string; initialCommand?: string }> };
  tasks: Map<string, Task>;
  settings: Record<string, unknown>;
  interruption: 'interrupted' | 'idle' | 'unknown';
  transcriptExists: boolean;
};

let counter = 0;

export async function harness(): Promise<Harness> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), `lattice-restore-${++counter}-`));
  const h: Harness = {
    project,
    spawns: [],
    kills: [],
    events: [],
    live: { instanceId: 'inst-B', ids: [], sessions: [] },
    tasks: new Map(),
    settings: {},
    interruption: 'unknown',
    transcriptExists: true,
    deps: undefined as unknown as RestoreDeps,
  };
  h.deps = {
    readLiveSessions: async () => ({ instanceId: h.live.instanceId, serverIds: new Set(h.live.ids) }),
    listLiveSessions: async () => h.live.sessions,
    createSession: async (opts): Promise<CreateSessionResult> => {
      h.spawns.push(opts);
      const id = `tty_new_${h.spawns.length}`;
      // Mirror what proxyCreateSession's recordSpawnedTerminal does for the
      // existingId path, so the relaunch shows up on the record.
      if (opts.registry?.existingId) {
        await terminalRegistry.update(opts.registry.existingId, {
          serverId: id, serverInstanceId: h.live.instanceId, ended: undefined, restoredAt: Date.now(),
        }, opts.projectPath);
      }
      return { id, terminalId: opts.registry?.existingId };
    },
    killSession: async (id) => { h.kills.push(id); return true; },
    enqueue: ((args: { thunk: () => Promise<unknown> }) => {
      const done = args.thunk();
      return { queued: false, done };
    }) as unknown as RestoreDeps['enqueue'],
    getTask: async (id) => h.tasks.get(id) ?? null,
    getUserSettings: async () => h.settings,
    discoverCodexSession: async () => false,
    detectInterruption: async () => ({
      interruption: h.interruption, turn: 'unknown', busy: 'unknown', transcriptExists: h.transcriptExists,
    }),
    dirExists: async (p) => { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } },
    now: Date.now,
  };
  terminalRegistry.subscribe((e) => { if (e.projectPath === project) h.events.push(e); });
  return h;
}

export function record(h: Harness, over: Partial<TerminalRecord> & { serverId?: string }) {
  return terminalRegistry.create({
    projectPath: h.project,
    cwd: h.project,
    label: 'claude 1',
    owner: 'user',
    launch: { initialCommand: 'claude --dangerously-skip-permissions', harness: 'claude' },
    agentSession: { harness: 'claude', id: 'S1', source: 'minted' },
    serverId: 'tty_old',
    serverInstanceId: 'inst-A',
    ...over,
  });
}

// Let the fire-and-forget relaunch thunks settle.
export const settle = () => new Promise((r) => setTimeout(r, 20));
