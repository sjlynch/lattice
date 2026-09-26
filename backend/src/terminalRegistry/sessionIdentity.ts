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
import { commandHasFlag, parseAgentCommand, tokenizeCommand } from './commandParse.js';
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

// The value of the first of `flags` in `command` (`--flag value` or
// `--flag=value`), ignoring quoted tokens (a prompt that merely mentions it).
function flagValue(command: string, flags: readonly string[]): string | undefined {
  const tokens = tokenizeCommand(command);
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.quoted) continue;
    for (const flag of flags) {
      if (t.value === flag) {
        const next = tokens[i + 1];
        if (next && !next.value.startsWith('-')) return next.value;
      } else if (t.value.startsWith(`${flag}=`)) {
        return t.value.slice(flag.length + 1) || undefined;
      }
    }
  }
  return undefined;
}

// Which conversation a LIVE pty's command runs, read off the command itself —
// the terminal-server reports the command as spawned, i.e. with Lattice's
// `--session-id` already injected. Used when restore adopts an orphan pty onto
// a record: the record's old id belongs to a pty that is gone, so keeping it
// would resume the wrong conversation on the next restart.
//   claude  `--session-id <id>` / `--resume <id>` / `-r <id>`
//   pi      `--session-id <id>`
//   codex   `resume <id>` (not `resume --last`, which names no id)
export function agentSessionFromCommand(command: string | undefined): AgentSessionRef | undefined {
  if (!command) return undefined;
  const harness = agentHarnessForCommand(command);
  if (harness === 'claude') {
    const id = flagValue(command, ['--session-id', '--resume', '-r']);
    return id ? { harness, id, source: 'command' } : undefined;
  }
  if (harness === 'pi') {
    const id = flagValue(command, ['--session-id']);
    return id ? { harness, id, source: 'command' } : undefined;
  }
  if (harness === 'codex') {
    // With --last a trailing positional is a prompt, not a thread id.
    if (commandHasFlag(command, ['--last'])) return undefined;
    const parsed = parseAgentCommand(command, 'codex');
    if (!parsed) return undefined;
    const positionals = [...parsed.positionals, ...(parsed.prompt ? [parsed.prompt] : [])];
    const [sub, id] = positionals;
    if (sub?.value !== 'resume' || !id) return undefined;
    return { harness, id: id.value, source: 'command' };
  }
  return undefined;
}
