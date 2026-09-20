import fs from 'node:fs/promises';
import path from 'node:path';
import { seedClaudeTrust } from '../claudeTrust.js';
import { queuedCreateSession } from '../queuedCreateSession.js';
import type { CreateSessionOptions } from '../terminalServerClient.js';
import type { SpawnPriority } from '../spawnQueue.js';
import type { HomeScratchPaths } from './paths.js';

// Shared scratch-agent session setup for the one-off agent run-types
// (pushRuns / qaRuns / postMergeHooks). They all share the same lifecycle
// shell — mkdir home scratch, seed Claude trust, install completion/activity
// hooks, render+write the instruction brief, enqueue/pre-spawn the pty, and
// register live-session presence — and differ only in the feature-specific
// instruction wording, completion endpoints, harness plumbing, and run-record
// shape. That feature-specific work is injected through the hooks/callbacks
// below; only the shell lives here.

export type HomeScratchSession = {
  id: string;
  cwd: string;
  instructionsFile: string;
};

export type HomeScratchSessionContext = {
  cwd: string;
  id: string;
};

// Phase 1 — materialize the per-session scratch dir:
//   1. mint a session id and verify the dir is safely under the home scratch
//      root and outside the repo (`assertSafeSessionPath`);
//   2. mkdir it;
//   3. pre-accept Claude's workspace-trust dialog so the first launch doesn't
//      stall (`seedClaudeTrust`);
//   4. install the completion/activity plumbing (`installHooks`);
//   5. render + write the instruction brief (`renderInstructions`).
//
// Used by push, QA, and post-merge session setup.
export async function setupHomeScratchSession(args: {
  paths: HomeScratchPaths;
  projectPath: string;
  // A caller may reserve an id before asynchronous filesystem setup when its
  // in-flight state must be observable immediately.
  id?: string;
  instructionsFileName: string;
  installHooks: (ctx: HomeScratchSessionContext) => Promise<void>;
  renderInstructions: (
    ctx: HomeScratchSessionContext,
  ) => string | Promise<string>;
}): Promise<HomeScratchSession> {
  const id = args.id ?? args.paths.createSessionId();
  const cwd = args.paths.assertSafeSessionPath(args.projectPath, id);
  await fs.mkdir(cwd, { recursive: true });

  // Pre-accept the workspace-trust dialog for this brand-new dir; otherwise
  // Claude prompts on first launch and blocks the unattended flow.
  await seedClaudeTrust(cwd);

  await args.installHooks({ cwd, id });

  const instructionsFile = path.join(cwd, args.instructionsFileName);
  await fs.writeFile(
    instructionsFile,
    await args.renderInstructions({ cwd, id }),
    'utf8',
  );

  return { id, cwd, instructionsFile };
}

export type StartedHomeScratchSession = {
  id: string;
  cwd: string;
  command: string;
  serverId: string;
  terminalId?: string;
};

// Phase 2 — full one-off agent-session spawn: materialize the scratch dir
// (`setupHomeScratchSession`), build the launch command, pre-spawn the pty
// through the spawn queue, then record the run + register the presence node
// (via `onSpawned`). On a terminal spawn failure it runs `cleanup` (the bounded
// recursive scratch delete) and rethrows.
//
// Shared by push + QA, whose flows are exact mirrors. The post-merge hook keeps
// its own trigger/gate/waiter orchestration but reuses `setupHomeScratchSession`
// for the materialize half.
export async function startHomeScratchAgentSession(args: {
  paths: HomeScratchPaths;
  projectPath: string;
  instructionsFileName: string;
  installHooks: (ctx: HomeScratchSessionContext) => Promise<void>;
  renderInstructions: (
    ctx: HomeScratchSessionContext,
  ) => string | Promise<string>;
  buildCommand: (ctx: { instructionsFile: string }) => string;
  queueKind: string;
  queuePriority: SpawnPriority;
  // Spawn-queue dedupe key prefix; the session id is appended (`<prefix>:<id>`).
  dedupeKeyPrefix: string;
  // Opt this session into the QA-scoped Playwright MCP at the injection
  // chokepoint. Only QA runs set it.
  isQaRun?: boolean;
  // Durable terminal-registry decorations for the pty's tab record. A QA run
  // is always recorded as `qa`; other sites default to `push`.
  registryOwner?: 'push' | 'post-merge' | 'prompt-customization';
  registryLabel?: string;
  // Record the run + register the orange presence node. Called synchronously
  // after a successful spawn (matching the pre-refactor ordering).
  onSpawned: (ctx: { id: string; cwd: string; serverId: string }) => void;
  // Bounded recursive scratch delete, run if the pty spawn fails.
  cleanup: (projectPath: string, id: string) => Promise<void>;
}): Promise<StartedHomeScratchSession> {
  const session = await setupHomeScratchSession({
    paths: args.paths,
    projectPath: args.projectPath,
    instructionsFileName: args.instructionsFileName,
    installHooks: args.installHooks,
    renderInstructions: args.renderInstructions,
  });

  const command = args.buildCommand({
    instructionsFile: session.instructionsFile,
  });

  const opts: CreateSessionOptions = {
    cwd: session.cwd,
    initialCommand: command,
    projectPath: args.projectPath,
    registry: {
      owner: args.isQaRun ? 'qa' : args.registryOwner ?? 'push',
      ...(args.registryLabel ? { label: args.registryLabel } : {}),
    },
  };
  if (args.isQaRun) opts.isQaRun = true;

  const sess = await queuedCreateSession({
    kind: args.queueKind,
    priority: args.queuePriority,
    dedupeKey: `${args.dedupeKeyPrefix}:${session.id}`,
    opts,
  });
  if ('error' in sess) {
    await args.cleanup(args.projectPath, session.id);
    throw new Error(sess.error);
  }

  args.onSpawned({ id: session.id, cwd: session.cwd, serverId: sess.id });

  return {
    id: session.id,
    cwd: session.cwd,
    command,
    serverId: sess.id,
    terminalId: sess.terminalId,
  };
}
