// Where each harness keeps its session transcripts on disk, so the restore
// flow can (a) tell whether a Claude transcript exists before choosing
// `--resume` vs `--session-id`, (b) discover a Codex thread id from its
// rollout files, and (c) read the transcript tail for the interruption
// detector. Pure path math here; the readers live beside their consumers.
//
// Encodings verified on this machine (Windows):
//   Claude  C:\development\lattice → ~/.claude/projects/C--development-lattice/
//   Pi      C:\development\lattice → ~/.pi/agent/sessions/--C--development-lattice--/
//   Codex   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl

import os from 'node:os';
import path from 'node:path';

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Claude replaces every non-alphanumeric character of the cwd with `-`.
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function claudeTranscriptPath(cwd: string, sessionId: string): string {
  return path.join(claudeConfigDir(), 'projects', claudeProjectDirName(cwd), `${sessionId}.jsonl`);
}

// `~/.claude/sessions/<pid>.json` — one per running (or crashed-and-not-yet-
// cleaned) Claude process, with `sessionId` + `status: busy|idle`.
export function claudeSessionsDir(): string {
  return path.join(claudeConfigDir(), 'sessions');
}

export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
}

// Pi strips a leading slash, then replaces `/`, `\` and `:` with `-`, and
// wraps the result in `--…--`.
export function piSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

export function piSessionsDir(cwd: string): string {
  return process.env.PI_CODING_AGENT_SESSION_DIR
    || path.join(piAgentDir(), 'sessions', piSessionDirName(cwd));
}

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function codexSessionsDir(): string {
  return path.join(codexHome(), 'sessions');
}

// Normalize a path for equality: forward slashes, no trailing slash, and
// case-folded on Windows (paths there are case-insensitive).
export function normalizeCwd(p: string): string {
  const s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}
