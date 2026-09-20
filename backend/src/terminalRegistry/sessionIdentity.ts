// Harness session identity: pin the conversation id at launch so a relaunch
// after a crash / reboot can resume the SAME conversation.
//
//   claude — `--session-id <uuid>` (must be a UUID). A second launch with the
//            same id errors "already in use" once a transcript exists, so a
//            relaunch uses `--resume <id>` instead (restoreCommand.ts).
//   pi     — `--session-id <id>` creates the session if missing and resumes it
//            otherwise, so the same flag serves launch and relaunch alike.
//   codex  — no such flag exists (openai/codex#46672); the id is learned after
//            the fact from its rollout files (codexDiscovery.ts).
//
// Verified against Claude Code 2.1.278 / Pi 0.85.1 / Codex 0.155.1.

import { randomUUID } from 'node:crypto';
import { agentHarnessForCommand, type AgentHarness } from '../harnesses.js';
import { commandHasFlag } from './commandParse.js';
import type { AgentSessionRef } from './types.js';

// Flags that already bind a command to a session. When any is present the
// launcher (a user typing `claude --resume` in a plain shell, or our own
// relaunch command) has decided the session; never inject on top of it.
export const CLAUDE_SESSION_FLAGS = [
  '--session-id', '--resume', '-r', '--continue', '-c', '--from-pr', '--fork-session',
] as const;
export const PI_SESSION_FLAGS = [
  '--session-id', '--session', '--continue', '-c', '--resume', '-r', '--fork',
  '--no-session',
] as const;

// Pi accepts `[A-Za-z0-9._-]` with alphanumeric ends; a UUID satisfies it.
export function mintAgentSessionId(harness: AgentHarness): string {
  return harness === 'pi' ? `lattice-${randomUUID()}` : randomUUID();
}

export type AssignedSessionIdentity = {
  command: string;
  agentSession?: AgentSessionRef;
};

// Append a Lattice-minted session id to a fresh Claude / Pi launch command.
// Idempotent: a command that already names a session is returned unchanged
// (and no identity is claimed for it — we don't know which session the user
// picked). Codex and plain shells pass through untouched.
export function assignHarnessSessionId(
  initialCommand: string | undefined,
  mint: (harness: AgentHarness) => string = mintAgentSessionId,
): AssignedSessionIdentity {
  if (!initialCommand) return { command: initialCommand ?? '' };
  const harness = agentHarnessForCommand(initialCommand);
  if (harness === 'claude') {
    if (commandHasFlag(initialCommand, CLAUDE_SESSION_FLAGS)) return { command: initialCommand };
    const id = mint('claude');
    return {
      command: `${initialCommand} --session-id ${id}`,
      agentSession: { harness: 'claude', id, source: 'minted' },
    };
  }
  if (harness === 'pi') {
    if (commandHasFlag(initialCommand, PI_SESSION_FLAGS)) return { command: initialCommand };
    const id = mint('pi');
    return {
      command: `${initialCommand} --session-id ${id}`,
      agentSession: { harness: 'pi', id, source: 'minted' },
    };
  }
  return { command: initialCommand };
}
