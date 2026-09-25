// Turns a resolved per-harness system-prompt override into the concrete
// injection each harness needs, at the spawn chokepoint
// (terminalServerClient/createSession.ts, the always-fresh main backend):
//
//   - Claude → write the text to a scratch file and return its path; the
//     terminal-server adds `--system-prompt-file` / `--append-system-prompt-file`
//     (a file avoids shell-escaping a large multi-line prompt across cmd/pwsh/
//     bash, matching how Codex trust/MCP paths ride the pty env).
//   - Codex → build `-c` inline-TOML override strings: `developer_instructions`
//     (append, an inline value) and `model_instructions_file` (replace, an
//     absolute-path value pointing at a scratch file). The terminal-server
//     turns each into a `--config` flag with env-var referencing.
//   - Pi → reconcile the cwd-local `before_agent_start` extension (see piShim).
//
// Files live under `~/.lattice/per-project/<hash>/system-prompts/` — home-scoped
// (never inside the repo) and overwritten per spawn; identical content across
// concurrent spawns of the same harness makes the shared path race-safe.

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { homeProjectScratchDir } from '../projectPath.js';
import { tomlString } from '../mcp/codexServerConfig.js';
import { resolveHarnessSystemPrompt } from './resolve.js';
import { applyPiSystemPromptForSpawn } from './piShim.js';
import {
  composeSystemPromptAppend,
  resolveLatticePreamble,
} from './latticePreamble.js';

// The Lattice preamble followed by a spawn-specific `extra` (either may be
// absent). Null when there is neither, like a bare preamble would be.
function withExtra(preamble: string | null, extra: string | undefined, separator: string): string | null {
  return composeSystemPromptAppend(preamble, extra, separator) ?? null;
}

function systemPromptDir(projectPath: string): string {
  return homeProjectScratchDir(projectPath, 'system-prompts');
}

// Atomic write (unique temp + rename) so a concurrent read never sees a
// half-written prompt. The temp name carries a random suffix so two concurrent
// spawns of the same harness don't collide on one temp path (they write
// identical content, so whichever rename lands last is fine). Rename within the
// same dir is atomic on one volume.
async function writePromptFile(
  dir: string,
  name: string,
  text: string,
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
  return file;
}

export type ClaudeSystemPromptFiles = {
  replaceFile?: string;
  appendFile?: string;
};

// Claude: write the override side(s) to scratch files, return their paths. The
// append side also carries the always-on Lattice preamble, so a project with no
// override of its own still gets an `--append-system-prompt-file`.
//
// `extra` is a spawn-specific addition placed after the preamble (the task
// verification rule for a task-worktree spawn). It gets its own file name: the
// shared per-project path is only race-safe while every spawn writes the same
// content.
export async function prepareClaudeSystemPrompt(
  projectPath: string,
  extra?: string,
): Promise<ClaudeSystemPromptFiles> {
  const override = await resolveHarnessSystemPrompt(projectPath, 'claude');
  const append = composeSystemPromptAppend(
    withExtra(resolveLatticePreamble(projectPath), extra, '\n\n'),
    override?.append,
  );
  if (!override?.replace && !append) return {};
  const dir = systemPromptDir(projectPath);
  const out: ClaudeSystemPromptFiles = {};
  if (override?.replace) {
    out.replaceFile = await writePromptFile(dir, 'claude-system.md', override.replace);
  }
  if (append) {
    out.appendFile = await writePromptFile(dir, extra ? 'claude-append-task.md' : 'claude-append.md', append);
  }
  return out;
}

// Render prose (the `append` developer instructions) as a TOML *multi-line
// literal* ('''…'''). Like tomlString this emits NO raw double-quote of its own,
// which matters because each `-c key=value` rides in a child-env var the Codex
// command references as `"%VAR%"`, and Windows cmd.exe STRIPS inner
// double-quotes out of that expansion — re-tokenizing the value on its own
// spaces (verified: `developer_instructions="Be terse."` → argv
// `developer_instructions=Be`, `terse.`), which rejects the override and leaks
// stray positional args. The outer `"…"` from the command template groups the
// whole (double-quote-free) value into one argument, so spaces survive;
// single-quotes are literal to cmd and are exactly the TOML literal delimiters
// Codex needs. See codexServerConfig.tomlString for the same constraint on the
// MCP side.
//
// A multi-line literal (vs the single-line one tomlString emits) is used because
// prose routinely contains apostrophes ("don't", "you're"), which a single-line
// literal can't hold — and tomlString's `'`-fallback would emit a cmd-breaking
// double-quoted string. A multi-line literal can hold at most two consecutive
// `'`, so any longer run is spaced out (`'''` → `' ' '`) on every shell — it
// would otherwise close the literal early and leave the value unparseable.
function tomlMultilineLiteral(text: string): string {
  return `'''${text.replace(/'{3,}/g, (run) => run.split('').join(' '))}'''`;
}

// Same shell-name test as terminal/codexTrust.ts `shellEnvRef` (which picks
// `"%VAR%"` for exactly these), kept here rather than exported from there:
// codexTrust.ts is in the terminal-server fingerprint, and a prompt change must
// stay backend-only.
function isCmdShell(shell: string): boolean {
  const name = shell.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  return name === 'cmd' || name === 'cmd.exe';
}

// cmd.exe can't carry the user's own `"` or a newline through `"%VAR%"`: an
// inner quote is stripped and the value re-split on spaces, and an expanded
// linefeed ends the command — so Codex gets stray positional args or a
// truncated command line and the task prompt after it is lost. Codex has no
// `developer_instructions_file` key to sidestep that, so on cmd the prose is
// normalized instead: line breaks (and the blank lines between paragraphs)
// collapse to one space, and straight double quotes become typographic ones
// (“ ” — opening after a line start / whitespace / bracket, closing elsewhere),
// which the model reads the same way. Non-ASCII already transits this path (the
// Lattice preamble carries em dashes).
function normalizeCodexAppendForCmd(text: string): string {
  return text
    .replace(/[ \t]*(?:\r\n|\r|\n)+[ \t]*/g, ' ')
    .replace(/(^|[\s([{])"/g, '$1“')
    .replace(/"/g, '”');
}

// Codex: build the `-c` override strings (inline TOML `key=value`), rendered so
// the value survives the pty shell's `"$VAR"`-style expansion (no raw
// double-quote of Lattice's own — see tomlMultilineLiteral /
// codexServerConfig.tomlString). Mirrors the proven MCP TOML-quoting approach
// rather than JSON.stringify, whose double quotes cmd strips and splits on.
//
// `shell` is the pty shell the terminal-server will launch in (resolved by the
// caller the same way launchContext does). On cmd.exe — or when it's unknown,
// the safe default — the append is flattened by normalizeCodexAppendForCmd; on
// a known POSIX / PowerShell shell it rides verbatim (newlines and quotes are
// intact inside `"$VAR"` / `"$env:VAR"`).
export async function prepareCodexSystemPrompt(
  projectPath: string,
  extra?: string,
  shell?: string,
): Promise<{ configArgs: string[] }> {
  const override = await resolveHarnessSystemPrompt(projectPath, 'codex');
  // Joined with a blank line like Claude/Pi; on cmd the normalization below
  // turns every line break (these separators included) into a single space.
  const composed = composeSystemPromptAppend(
    withExtra(resolveLatticePreamble(projectPath), extra, '\n\n'),
    override?.append,
  );
  const append =
    composed && (shell === undefined || isCmdShell(shell))
      ? normalizeCodexAppendForCmd(composed)
      : composed;
  if (!override?.replace && !append) return { configArgs: [] };
  const configArgs: string[] = [];
  if (override?.replace) {
    const file = await writePromptFile(
      systemPromptDir(projectPath),
      'codex-instructions.md',
      override.replace,
    );
    // Newer Codex key that replaces the built-in base instructions. Value is an
    // absolute path; a single-quoted TOML literal survives cmd (a spaced home
    // dir like `C:\Users\John Doe\…` would be split by JSON.stringify's double
    // quotes) and keeps Windows backslashes literal (no escaping, unlike a basic
    // string). A path essentially never contains a `'`, so tomlString's fallback
    // never fires here.
    configArgs.push(`model_instructions_file=${tomlString(file)}`);
  }
  if (append) {
    // Additive developer-role message layered on top of the base instructions.
    // Inline-only (Codex has no file variant), so render it as a literal.
    configArgs.push(`developer_instructions=${tomlMultilineLiteral(append)}`);
  }
  return { configArgs };
}

// Pi: reconcile the cwd-local extension (install when there's something to
// apply, strip a stale one otherwise). Runs regardless of MCP state, like
// piMcp. The Lattice preamble rides the append side, so a Pi session in a
// managed project always installs the extension.
export async function preparePiSystemPrompt(
  cwd: string,
  projectPath: string,
  extra?: string,
): Promise<void> {
  const override = await resolveHarnessSystemPrompt(projectPath, 'pi');
  const append = composeSystemPromptAppend(
    withExtra(resolveLatticePreamble(projectPath), extra, '\n\n'),
    override?.append,
  );
  const resolved =
    append || override?.replace ? { append, replace: override?.replace } : null;
  await applyPiSystemPromptForSpawn(cwd, resolved);
}
