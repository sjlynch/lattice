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
import { resolveHarnessSystemPrompt } from './resolve.js';
import { applyPiSystemPromptForSpawn } from './piShim.js';

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

// Claude: write the override side(s) to scratch files, return their paths.
export async function prepareClaudeSystemPrompt(
  projectPath: string,
): Promise<ClaudeSystemPromptFiles> {
  const override = await resolveHarnessSystemPrompt(projectPath, 'claude');
  if (!override) return {};
  const dir = systemPromptDir(projectPath);
  const out: ClaudeSystemPromptFiles = {};
  if (override.replace) {
    out.replaceFile = await writePromptFile(dir, 'claude-system.md', override.replace);
  }
  if (override.append) {
    out.appendFile = await writePromptFile(dir, 'claude-append.md', override.append);
  }
  return out;
}

// Codex: build the `-c` override strings (inline TOML `key=value`). A JSON
// string is a valid TOML basic string — the same trick codexTrust uses for the
// cwd path — so Windows backslashes in the file path are escaped correctly.
export async function prepareCodexSystemPrompt(
  projectPath: string,
): Promise<{ configArgs: string[] }> {
  const override = await resolveHarnessSystemPrompt(projectPath, 'codex');
  if (!override) return { configArgs: [] };
  const configArgs: string[] = [];
  if (override.replace) {
    const file = await writePromptFile(
      systemPromptDir(projectPath),
      'codex-instructions.md',
      override.replace,
    );
    // Newer Codex key that replaces the built-in base instructions. Value is an
    // absolute path; JSON.stringify escapes it into a valid TOML basic string.
    configArgs.push(`model_instructions_file=${JSON.stringify(file)}`);
  }
  if (override.append) {
    // Additive developer-role message layered on top of the base instructions.
    configArgs.push(`developer_instructions=${JSON.stringify(override.append)}`);
  }
  return { configArgs };
}

// Pi: reconcile the cwd-local extension (install when there's an override,
// strip a stale one otherwise). Runs regardless of MCP state, like piMcp.
export async function preparePiSystemPrompt(
  cwd: string,
  projectPath: string,
): Promise<void> {
  const override = await resolveHarnessSystemPrompt(projectPath, 'pi');
  await applyPiSystemPromptForSpawn(cwd, override);
}
