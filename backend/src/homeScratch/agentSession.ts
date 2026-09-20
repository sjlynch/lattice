import {
  startHomeScratchAgentSession,
  type HomeScratchSessionContext,
  type StartedHomeScratchSession,
} from './session.js';
import { registerAgentSession } from '../agentSessions.js';
import type { HomeScratchPaths } from './paths.js';

// Push and QA one-off agent sessions are exact mirrors: both render a
// feature-specific brief, install a Stop/activity hook, build a fixed claude
// launch command, pre-spawn the pty through the spawn queue on the shared
// `interactive` band, then (on success) record the run and register the orange
// presence node. `startHomeScratchAgentSession` already owns the spawn lifecycle;
// this factory captures the remaining mirror boilerplate — the command wrapper,
// spawn-queue metadata, presence registration, and cleanup wiring — so each
// run-type only states what actually differs.
//
// Kept explicit per run-type (the real divergence): the instruction text +
// hook install (`renderInstructions` / `installHooks`), the registry record
// fields (`recordRun`), the Playwright `isQaRun` opt-in, and the presence
// `agentId` / `label`.

// Static, per-run-type config. The dynamic per-invocation pieces (projectPath,
// hook install, brief render, run record) are passed to the returned start fn.
export type HomeScratchAgentSessionSpec = {
  paths: HomeScratchPaths;
  instructionsFileName: string;
  // Fixed launch command for the pre-spawned pty (cwd = scratch).
  command: string;
  // Spawn-queue band tag (e.g. `push-run` / `qa-run`).
  queueKind: string;
  // Spawn-queue dedupe key prefix; the session id is appended (`<prefix>:<id>`).
  dedupeKeyPrefix: string;
  // Opt this session into the QA-scoped Playwright MCP at the injection
  // chokepoint. Only QA runs set it.
  isQaRun?: boolean;
  // Stable graph-node id for the orange presence node, derived from session id.
  agentId: (id: string) => string;
  // Presence-node label ('push' / 'qa').
  presenceLabel: string;
  // Bounded recursive scratch delete, run if the pty spawn fails.
  cleanup: (projectPath: string, id: string) => Promise<void>;
};

export type StartHomeScratchAgentSessionArgs = {
  projectPath: string;
  installHooks: (ctx: HomeScratchSessionContext) => Promise<void>;
  renderInstructions: (
    ctx: HomeScratchSessionContext,
  ) => string | Promise<string>;
  // Record the run in the feature's in-memory registry. Called synchronously
  // after a successful spawn, before presence registration (matching the
  // pre-refactor ordering). projectPath + any feature fields (taskId, status,
  // createdAt) are supplied by the closure.
  recordRun: (ctx: { id: string; cwd: string }) => void;
  // Label for the durable terminal-registry tab record; defaults to the
  // presence label ('push' / 'qa').
  registryLabel?: string;
};

export type StartedHomeScratchAgentSession = StartedHomeScratchSession;

// Build a `start` function for one mirror run-type from its static spec. The
// returned function drives a full spawn for a single invocation and returns the
// shared `{id, cwd, command, serverId}` shape; the caller adapts its public
// signature / return type (e.g. QA threads through `taskId`).
export function createHomeScratchAgentSession(
  spec: HomeScratchAgentSessionSpec,
): (
  args: StartHomeScratchAgentSessionArgs,
) => Promise<StartedHomeScratchAgentSession> {
  return (args) =>
    startHomeScratchAgentSession({
      paths: spec.paths,
      projectPath: args.projectPath,
      instructionsFileName: spec.instructionsFileName,
      installHooks: args.installHooks,
      renderInstructions: args.renderInstructions,
      buildCommand: () => spec.command,
      queueKind: spec.queueKind,
      // `interactive` band — user-initiated, infrequent; may use
      // PRIORITY_RESERVE headroom so a push/QA run is not stuck behind a full
      // batch lane.
      queuePriority: 'interactive',
      dedupeKeyPrefix: spec.dedupeKeyPrefix,
      ...(spec.isQaRun ? { isQaRun: true } : {}),
      registryOwner: 'push',
      registryLabel: args.registryLabel ?? spec.presenceLabel,
      onSpawned: ({ id, cwd }) => {
        args.recordRun({ id, cwd });
        // Presence: show an orange Claude node for this non-worktree session.
        registerAgentSession({
          agentId: spec.agentId(id),
          projectPath: args.projectPath,
          label: spec.presenceLabel,
        });
      },
      cleanup: spec.cleanup,
    });
}
