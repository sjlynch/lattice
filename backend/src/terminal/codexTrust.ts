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

// Env var name for the i-th Lattice-managed MCP `-c` override (see
// configureCodexProjectMcp). Kept out of the shell command for the same reason
// as the trust override: the TOML value carries braces/quotes/commas that we do
// not want to shell-quote or expose in the command line.
export function codexMcpOverrideEnv(index: number): string {
  return `LATTICE_CODEX_MCP_${index}`;
}

// Env var name for the i-th Lattice-managed system-prompt `-c` override (see
// configureCodexSystemPrompt). A distinct series from the MCP one so both can
// coexist on one command without clobbering each other's env vars.
export function codexSystemPromptOverrideEnv(index: number): string {
  return `LATTICE_CODEX_SYS_${index}`;
}

const CODEX_COMMAND_RE = /^(\s*codex(?:\.(?:exe|cmd|ps1))?)(?=\s|$)/i;

// Codex (verified against codex-cli 0.157) splits a `-c` override's KEY on
// every `.` and does NOT unquote segments, so no dotted key can name a project
// path: `projects."C:\x".trust_level` and `projects.'C:\x'.trust_level`
// both miss (the quotes stay part of the key), and every Lattice worktree lives
// under `~/.lattice/`, whose `.` would split even an unquoted key. The VALUE is
// parsed as real TOML, though, and a table-valued `projects={…}` override is
// MERGED over config.toml's `[projects]` (the user's own trusted folders stay
// trusted). So the path goes in as an inline-table key.
//
// It is a single-quoted TOML literal because on Windows the value reaches Codex
// through cmd's `"%VAR%"`, which strips inner double quotes (a JSON-quoted path
// lost its quotes, kept its doubled backslashes, and a space split it into an
// extra argument that broke the launch). `tomlString` falls back to a basic
// string only for a path containing `'` — correct on PowerShell/POSIX,
// degraded on cmd for that rare path.
export function buildCodexTrustOverride(cwd: string): string {
  return `projects={${tomlString(cwd)}={trust_level='trusted'}}`;
}

// CRITICAL (Windows cmd.exe): every Lattice `--config` override rides in a
// child-env var the command references as `"%VAR%"`. cmd STRIPS inner
// double-quotes out of a `"%VAR%"` expansion (verified: `command="cmd"` →
// `command=cmd`, which Codex then rejects), but PRESERVES single-quotes. So we
// render TOML **single-quoted literal strings** (`'…'`), which survive cmd,
// PowerShell (`"$env:VAR"`), and POSIX (`"$VAR"`) identically. TOML literal
// strings have no escapes and cannot contain a `'`; for the rare value that
// does, we fall back to a double-quoted basic string (correct on
// PowerShell/POSIX, degraded only on cmd for that one value).
//
// Lives here (not in mcp/codexServerConfig.ts, which re-exports it) so the
// terminal-server's fingerprinted import graph stays free of the MCP modules.
// Prefer this for controlled strings (commands/args/urls/paths) that
// essentially never contain a `'`; for free prose that commonly does, use a
// multi-line literal instead so the `'`-fallback never fires.
export function tomlString(s: string): string {
  return NEEDS_BASIC_STRING.test(s) ? JSON.stringify(s) : `'${s}'`;
}

// What a TOML literal string cannot carry: the `'` that would close it, and
// every control character except tab (a newline in a single-quoted literal is
// invalid TOML — the whole `-c` override, and with it the Codex spawn, used to
// fail on one such value). JSON escapes are valid TOML basic-string escapes, so
// JSON.stringify is the right fallback for all of them.
const NEEDS_BASIC_STRING = /['\x00-\x08\x0A-\x1F\x7F]/;

function shellName(shell: string): string {
  return shell.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
}

// A quoted, shell-correct reference to `$VAR` so the dynamic value expands from
// the child pty environment rather than being interpolated into shell source.
// cmd → `"%VAR%"`, PowerShell → `"$env:VAR"`, POSIX → `"$VAR"`. Exported so the
// Claude system-prompt rewriter (claudeSystemPrompt.ts) can reference a
// path-bearing child-env var the same way.
export function shellEnvRef(shell: string, varName: string): string {
  const name = shellName(shell);
  if (name === 'cmd' || name === 'cmd.exe') {
    return `"%${varName}%"`;
  }
  if (
    name === 'powershell' ||
    name === 'powershell.exe' ||
    name === 'pwsh' ||
    name === 'pwsh.exe'
  ) {
    return `"$env:${varName}"`;
  }
  return `"$${varName}"`;
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
  return `${match[1]} --config ${shellEnvRef(shell, LATTICE_CODEX_TRUST_OVERRIDE_ENV)}${rest}`;
}

/**
 * Inject Lattice's managed MCP servers into a Lattice-started Codex command as
 * per-invocation `--config "mcp_servers.<id>={…}"` overrides. `configArgs` are
 * the backend-resolved inline-TOML strings (one per enabled server); the secret
 * env values they reference were already merged into `env` upstream.
 *
 * Each override string rides in its own child-env var (`LATTICE_CODEX_MCP_<i>`)
 * and the command references it — the TOML (braces/quotes/commas) never enters
 * shell source, mirroring the trust override. Non-Codex commands and an empty
 * arg list are returned unchanged. Runs AFTER configureCodexProjectTrust; the
 * extra `--config` flags sit alongside the trust one (order is irrelevant for
 * distinct dotted keys).
 *
 * `env` is mutated only when the command actually launches Codex with ≥1 server.
 */
export function configureCodexProjectMcp(
  initialCommand: string | undefined,
  configArgs: string[] | undefined,
  shell: string,
  env: Record<string, string>,
): string | undefined {
  return applyCodexConfigArgs(
    initialCommand,
    configArgs,
    codexMcpOverrideEnv,
    shell,
    env,
  );
}

/**
 * Inject Lattice's per-project system-prompt override into a Lattice-started
 * Codex command as `--config` overrides (`developer_instructions=…` for append,
 * `model_instructions_file=…` for replace). Mechanically identical to
 * configureCodexProjectMcp but on its own `LATTICE_CODEX_SYS_<i>` env-var series
 * so it can coexist with the MCP overrides on one command. Non-Codex commands
 * and an empty arg list are returned unchanged.
 */
export function configureCodexSystemPrompt(
  initialCommand: string | undefined,
  configArgs: string[] | undefined,
  shell: string,
  env: Record<string, string>,
): string | undefined {
  return applyCodexConfigArgs(
    initialCommand,
    configArgs,
    codexSystemPromptOverrideEnv,
    shell,
    env,
  );
}

// Shared body for the `--config`-injecting rewriters: for each inline-TOML
// override string, stash it in a child-env var (named by `envNameFor(i)`) and
// add a `--config "$VAR"` flag right after the leading `codex`. The TOML value
// (braces/quotes/paths) never enters shell source. No-op for a non-Codex command
// or an empty list. `env` is mutated only when it actually rewrites the command.
function applyCodexConfigArgs(
  initialCommand: string | undefined,
  configArgs: string[] | undefined,
  envNameFor: (index: number) => string,
  shell: string,
  env: Record<string, string>,
): string | undefined {
  if (!initialCommand || !configArgs || configArgs.length === 0) {
    return initialCommand;
  }
  const match = CODEX_COMMAND_RE.exec(initialCommand);
  if (!match) return initialCommand;

  const flags: string[] = [];
  configArgs.forEach((arg, i) => {
    const varName = envNameFor(i);
    env[varName] = arg;
    flags.push(`--config ${shellEnvRef(shell, varName)}`);
  });
  const rest = initialCommand.slice(match[0].length);
  return `${match[1]} ${flags.join(' ')}${rest}`;
}
