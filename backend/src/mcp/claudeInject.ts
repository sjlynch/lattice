// Shaping the resolved server set into Claude Code's `mcpServers` object and
// reconciling it into a `~/.claude.json` project entry without clobbering the
// user's own MCP entries.
//
// Why reconcile and not blind-append (MCP plan §9): some day we may write into
// a project entry that the user's own `claude` sessions also read. We tag the
// servers Lattice manages (a sibling `__latticeManagedMcp` name list on the
// project entry) so each spawn can add currently-enabled Lattice servers and
// strip ones we previously added that are now disabled — leaving anything the
// user added by hand untouched. For Lattice's own spawns the cwd is always an
// ephemeral worktree/scratch dir, so this is belt-and-suspenders, but it keeps
// the one code path correct everywhere.

import fs from 'node:fs';
import path from 'node:path';

// Claude's per-server config shape (stdio or http/sse).
export type ClaudeMcpServerConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

// Sibling marker on a `~/.claude.json` project entry listing the server names
// Lattice currently manages there. Unknown keys round-trip through Claude.
export const MANAGED_MCP_MARKER = '__latticeManagedMcp';

// Windows can't `spawn('npx', …)` directly — the package-runner shims are
// `.cmd`/`.ps1` files and the MCP SDK spawns without a shell, so it ENOENTs.
// Wrap the known runners in `cmd /c` on win32; everything else is passed
// through. Node is a real `.exe` and needs no wrapping.
const WIN_SHIM_COMMANDS = new Set(['npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'bunx', 'uvx', 'uv']);

// ---- cmd.exe argument escaping ----
//
// Wrapping in `cmd /c` means every arg is re-parsed by cmd.exe, where `&`, `|`,
// `<`, `>`, `^`, `(`, `)` and `%VAR%` are live syntax. Unescaped, an arg like
// `https://x/?a=1&b=2` (or a crafted `x&calc`) ends the command and runs the
// rest as a second one. The args are user-editable (custom servers, additive
// built-in override args), so this is an injection boundary.
//
// What cmd actually sees is NOT our array: the harness's MCP client (Claude /
// Pi: libuv, Codex: Rust std) turns `['/c', 'npx', ...args]` into a command
// line with CommandLineToArgvW quoting — an arg is wrapped in `"…"` iff it is
// empty or contains a space / tab (libuv also quotes on `"`), with a `"`
// escaped as `\"`. We cannot opt out of that (no `windowsVerbatimArguments`
// through someone else's spawn), so cross-spawn's "quote, then caret-escape the
// whole thing" can't be used as-is: the transport would re-quote our quotes.
// Instead the escaper works WITH the transport:
//   - an arg the transport passes VERBATIM (no whitespace): caret-escape every
//     cmd metachar (cross-spawn's set). cmd strips one caret layer per parse.
//     A `.cmd`/`.bat` target (npm's `npx.cmd`, …) is parsed TWICE — once on
//     the `cmd /c` line and again when the shim's `%*` re-expands the args —
//     so it needs cross-spawn's double escape (`&` → `^^^&`). A real `.exe`
//     (`uvx.exe`) is parsed once; double escaping it would leave stray carets.
//     `%` works the same way on a command line: `^%PATH^%` names the undefined
//     variable `PATH^`, which cmd leaves alone, and the caret pass then drops
//     the carets.
//   - an arg the transport QUOTES (contains whitespace): inside quotes cmd
//     treats `& | < > ( ) ^` as literals on both parses, so it passes through
//     untouched — carets there would be literal. `%VAR%` (and `!VAR!` under a
//     registry-enabled delayed expansion) still expand inside quotes and have
//     no in-quote escape, so such an arg is REFUSED.
//   - an arg containing `"`: the transport emits `\"`, which cmd reads as a
//     quote toggle — every later arg's quoting (and so its escaping) is then
//     wrong. Unrepresentable → REFUSED. So are control characters (a newline
//     ends the cmd command outright).
// With no `"` in any arg the only quotes on the line are the balanced pairs the
// transport adds, so cmd's quote state per arg is exactly "has whitespace".
// Refusal throws `UnsafeCmdArgumentError`; the registry shapers catch it and
// skip that one server with a warning. Secrets never reach argv (stdio secrets
// ride env, HTTP secrets ride headers), so this covers every arg we emit.

// cross-spawn's metachar set, minus the space (whitespace args are never caret-
// escaped — see above) and `"` (refused). A caret before a harmless char is
// simply dropped by cmd, so the set can be generous.
const CMD_META_CHARS = /([()\][%!^`<>&|;,*?])/g;
// eslint-disable-next-line no-control-regex
const CMD_CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f]/;

export class UnsafeCmdArgumentError extends Error {
  constructor(
    readonly arg: string,
    reason: string,
  ) {
    super(`argument ${JSON.stringify(arg)} cannot be passed safely through cmd /c: ${reason}`);
    this.name = 'UnsafeCmdArgumentError';
  }
}

// Escape one arg for `cmd /c <shim> …` given the transport quoting described
// above. `batch` = the target is a `.cmd`/`.bat` (parsed twice). Pure.
export function escapeCmdArgument(arg: string, batch: boolean): string {
  if (CMD_CONTROL_CHARS.test(arg)) {
    throw new UnsafeCmdArgumentError(arg, 'contains a control character');
  }
  if (arg.includes('"')) {
    throw new UnsafeCmdArgumentError(arg, 'contains a double quote');
  }
  // Empty → the transport emits `""`, which both parses keep as one empty arg.
  if (arg === '') return arg;
  if (/[ \t]/.test(arg)) {
    // Transport-quoted: literal inside quotes except for variable expansion.
    if (arg.includes('%') || arg.includes('!')) {
      throw new UnsafeCmdArgumentError(arg, 'contains whitespace together with % or !');
    }
    return arg;
  }
  let out = arg.replace(CMD_META_CHARS, '^$1');
  if (batch) out = out.replace(CMD_META_CHARS, '^$1');
  return out;
}

// Does `command` resolve (the way cmd searches PATH × PATHEXT) to a batch file?
// Unresolvable → `true`: double escaping an `.exe` only leaves stray carets in
// an arg that had metachars, whereas single escaping a batch shim re-opens the
// injection on its `%*` pass — so an unknown target fails toward the safe side.
// (cmd also searches its cwd first; that's the spawn cwd, unknown here.)
// Memoized briefly (PATH lookups are ~dirs×exts stats per server per spawn).
const SHIM_KIND_TTL_MS = 60_000;
const shimKindCache = new Map<string, { batch: boolean; at: number }>();

export function windowsShimIsBatch(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fileExists,
): boolean {
  const pathVar = env.PATH ?? env.Path ?? '';
  const pathExt = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const useCache = exists === fileExists;
  const key = `${command}\0${pathVar}\0${pathExt}`;
  if (useCache) {
    const hit = shimKindCache.get(key);
    if (hit && Date.now() - hit.at < SHIM_KIND_TTL_MS) return hit.batch;
  }
  const exts = pathExt.split(';').filter(Boolean);
  let result = true;
  search: for (const dir of pathVar.split(';').filter(Boolean)) {
    for (const ext of exts) {
      if (exists(path.join(dir, command + ext))) {
        result = /^\.(bat|cmd)$/i.test(ext);
        break search;
      }
    }
  }
  if (useCache) {
    if (shimKindCache.size > 64) shimKindCache.clear();
    shimKindCache.set(key, { batch: result, at: Date.now() });
  }
  return result;
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Throws `UnsafeCmdArgumentError` on win32 when an arg can't be carried through
// `cmd /c` safely (see escapeCmdArgument). `opts` exist for tests.
export function platformizeCommand(
  command: string,
  args: string[] = [],
  opts: { platform?: NodeJS.Platform; batch?: boolean } = {},
): { command: string; args: string[] } {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32' && WIN_SHIM_COMMANDS.has(command.toLowerCase())) {
    const batch = opts.batch ?? windowsShimIsBatch(command);
    return {
      command: 'cmd',
      args: ['/c', command, ...args.map((a) => escapeCmdArgument(a, batch))],
    };
  }
  return { command, args };
}

// Reconcile `managed` (server name → config) into a Claude project entry's
// `mcpServers`, in place. `entry` is mutated (its mcpServers + marker rewritten).
export function reconcileMcpServers(
  entry: Record<string, unknown>,
  managed: Record<string, ClaudeMcpServerConfig>,
): void {
  const prevRaw = entry[MANAGED_MCP_MARKER];
  const prevManaged: string[] = Array.isArray(prevRaw)
    ? (prevRaw.filter((n) => typeof n === 'string') as string[])
    : [];

  const current = { ...((entry.mcpServers as Record<string, unknown>) ?? {}) };

  // Drop servers we previously managed that are no longer enabled. The user's
  // own entries (never in prevManaged) are left alone.
  for (const name of prevManaged) {
    if (!(name in managed)) delete current[name];
  }
  // Upsert the currently-enabled managed servers.
  for (const [name, cfg] of Object.entries(managed)) {
    current[name] = cfg;
  }

  entry.mcpServers = current;
  const names = Object.keys(managed);
  if (names.length > 0) {
    entry[MANAGED_MCP_MARKER] = names;
  } else {
    // Nothing managed anymore — drop the marker so a clean entry stays clean.
    delete entry[MANAGED_MCP_MARKER];
  }
}
