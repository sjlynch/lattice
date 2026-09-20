import type { AgentHarness } from '../harnesses.js';

// Who "owns" a terminal tab — i.e. which lifecycle decides when it should
// disappear, and whether the restore flow is allowed to relaunch it.
//
//   user     — sidebar "+" launches (claude / pi / codex / plain shell)
//   task     — a task's worktree agent (run / resume)
//   merge    — a conflict resolver in a task's worktree
//   startup  — a configured startup terminal (useStartupTerminals owns
//              re-seeding these; restore never relaunches them)
//   the rest — one-shot runs owned by their own recovery machinery
//              (push / QA / post-merge hook / workflow step / prompt
//              customization). Restore adopts them while the pty is alive and
//              marks them ended otherwise — it never resurrects them.
export type TerminalOwner =
  | 'user'
  | 'task'
  | 'merge'
  | 'startup'
  | 'workflow-step'
  | 'push'
  | 'qa'
  | 'post-merge'
  | 'prompt-customization';

export type TerminalEndReason =
  | 'exit'           // the pty exited while the executor lived (agent quit, shell exited)
  | 'closed'         // the user closed the tab
  | 'killed'         // Lattice killed the pty (cancel / abort)
  | 'owner-finished' // the owning task/run finished (worktree torn down, run done)
  | 'cwd-missing'    // restore refused: the working directory no longer exists
  | 'restore-failed';// restore tried to relaunch and the spawn failed

export type TerminalEnded = {
  at: number;
  reason: TerminalEndReason;
  exitCode?: number;
  detail?: string;
};

// The harness conversation this pty is running, so a relaunch can resume it.
//   minted       — Lattice chose the id up front (Claude / Pi `--session-id`)
//   rollout-scan — learned after the fact from the harness's own session
//                  files (Codex, which has no way to pre-set an id)
export type AgentSessionSource = 'minted' | 'rollout-scan';

export type AgentSessionRef = {
  harness: AgentHarness;
  id: string;
  source: AgentSessionSource;
  // Set when the rollout scan found more than one plausible candidate for
  // this record (two Codex sessions started in the same cwd within the
  // discovery window) and picked by timestamp order. Informational.
  ambiguous?: boolean;
};

// What `resolveHarnessSpawnBody` needs to re-run the launch — the ORIGINAL
// command (before any Lattice-injected `--session-id` / Codex title config),
// so a relaunch re-enters the chokepoint cleanly and picks up current policy.
export type TerminalLaunch = {
  initialCommand?: string;
  harness?: AgentHarness;
  piModel?: string;
  isQaRun?: boolean;
  taskId?: string;
};

export type TerminalRecord = {
  // Durable tab id — the frontend uses it as `TerminalSpec.id`.
  id: string;
  // Raw (non-canonicalized) project path as the spawn site knew it, so the
  // frontend's project scoping (`projectPath === activeFolder`) matches.
  projectPath: string;
  cwd: string;
  label: string;
  order: number;
  kind?: 'merge' | 'startup';
  taskId?: string;
  startupId?: string;
  owner: TerminalOwner;
  launch: TerminalLaunch;
  agentSession?: AgentSessionRef;
  // The pty currently (or last) backing this tab, plus the terminal-server
  // instance that owns it. A serverId missing from a live listing while the
  // instance is unchanged means the pty exited; a different instance means
  // the executor itself was replaced (reboot / Ctrl+C) and the tab must be
  // relaunched.
  serverId?: string;
  serverInstanceId?: string;
  createdAt: number;
  updatedAt: number;
  // Last observed busy transition from the terminal-activity signal, persisted
  // so the interruption detector can tell (to ~2s) whether the agent was
  // mid-turn when everything died.
  lastBusy?: { busy: boolean; at: number };
  // How many times this tab has been relaunched by restore.
  restoreCount?: number;
  restoredAt?: number;
  ended?: TerminalEnded;
};

// What a spawn site tells the registry about the pty it is creating. Passed
// through `CreateSessionOptions.registry`; everything else the record needs
// (cwd, command, projectPath, taskId, isQaRun) is already on the options.
export type TerminalRegistryHint = {
  owner: TerminalOwner;
  label?: string;
  kind?: 'merge' | 'startup';
  taskId?: string;
  startupId?: string;
  piModel?: string;
  // Restore path: update THIS record (same durable id) instead of creating a
  // new one.
  existingId?: string;
  // Restore path: the agent session the relaunch command targets (so a fresh
  // Claude `--session-id` fallback records the id it minted, and a Codex
  // `resume --last` keeps its unknown state for a later discovery pass).
  agentSession?: AgentSessionRef;
};

export type TerminalRegistryEvent =
  | { type: 'upsert'; projectPath: string; record: TerminalRecord }
  | { type: 'ended'; projectPath: string; id: string; ended: TerminalEnded }
  | { type: 'removed'; projectPath: string; id: string }
  | { type: 'restored'; projectPath: string; record: TerminalRecord; mode: 'adopted' | 'relaunched' }
  | { type: 'restore-failed'; projectPath: string; id: string; reason: string }
  | { type: 'restore-summary'; projectPath: string; summary: RestoreSummary };

export type RestoreDropped = { id: string; label: string; reason: string };

export type RestoreSummary = {
  status: 'ok' | 'terminal-server-unreachable' | 'already-running';
  adopted: number;
  queued: number;
  dropped: RestoreDropped[];
  // The tab ids queued for a relaunch, so a client can mark them from the
  // HTTP response alone (the matching WS events can precede its socket).
  relaunchedIds: string[];
};
