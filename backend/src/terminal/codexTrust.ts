// Per-terminal Codex project trust.
//
// Codex stores persistent trust under `projects.<path>.trust_level` in the
// user's config.toml. Lattice must not write that global file: a folder trusted
// for an orchestrated agent should not silently become trusted for Codex
// sessions launched elsewhere. Instead, add Codex's documented one-shot
// `--config` override to the initial command and carry the path-bearing TOML in
// this PTY's environment.
//
// Keeping the dynamic path out of the shell command is important. Project
// paths can contain spaces and shell metacharacters; environment expansion
// yields one already-quoted argument without asking cmd/PowerShell/POSIX shells
// to parse the path itself.

export const LATTICE_CODEX_TRUST_OVERRIDE_ENV =
  'LATTICE_CODEX_TRUST_OVERRIDE';

const CODEX_COMMAND_RE = /^(\s*codex(?:\.(?:exe|cmd|ps1))?)(?=\s|$)/i;

export function buildCodexTrustOverride(cwd: string): string {
  // A JSON string is also a valid TOML basic string. In particular, this
  // escapes Windows backslashes and any quote in the directory name while
  // preserving the exact cwd Codex starts in.
  return `projects.${JSON.stringify(cwd)}.trust_level="trusted"`;
}

function shellName(shell: string): string {
  return shell.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
}

function trustOverrideReference(shell: string): string {
  const name = shellName(shell);
  if (name === 'cmd' || name === 'cmd.exe') {
    return `"%${LATTICE_CODEX_TRUST_OVERRIDE_ENV}%"`;
  }
  if (
    name === 'powershell' ||
    name === 'powershell.exe' ||
    name === 'pwsh' ||
    name === 'pwsh.exe'
  ) {
    return `"$env:${LATTICE_CODEX_TRUST_OVERRIDE_ENV}"`;
  }
  return `"$${LATTICE_CODEX_TRUST_OVERRIDE_ENV}"`;
}

/**
 * Add a session-local trust override to a Lattice-started Codex command.
 * Other harnesses and plain shell terminals are returned unchanged.
 *
 * `env` is the environment object that will be passed to pty.spawn. It is
 * mutated only when the initial command actually launches Codex.
 */
export function configureCodexProjectTrust(
  initialCommand: string | undefined,
  cwd: string,
  shell: string,
  env: Record<string, string>,
): string | undefined {
  if (!initialCommand) return initialCommand;
  const match = CODEX_COMMAND_RE.exec(initialCommand);
  if (!match) return initialCommand;

  env[LATTICE_CODEX_TRUST_OVERRIDE_ENV] = buildCodexTrustOverride(cwd);
  const rest = initialCommand.slice(match[0].length);
  return `${match[1]} --config ${trustOverrideReference(shell)}${rest}`;
}
