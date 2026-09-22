// Security boundary for built-in MCP override env vars — the "an override may
// only TUNE a built-in, never re-point what it runs" denylist.
//
// Split out of ./settingsValidation.ts so the code-injection / launcher-hijack
// denylist and its helpers live on their own, apart from the plain schema-shape
// sanitizers (sanitizeCustomServers / sanitizeBuiltinOverrides / applyBuiltin-
// Override) that consume them. `sanitizeBuiltinOverrides` imports
// `sanitizeOverrideEnv` back from here to filter an override's `env`.

// Environment variable names an override must NEVER be allowed to set on a
// built-in: each one lets a value injected through `env` execute code in, or
// hijack the launcher of, an otherwise known-safe built-in the moment it's
// enabled per-project. NODE_OPTIONS (`--require`/`--import` arbitrary modules),
// the LD_*/DYLD_* native-library preloads, PATH/PATHEXT (which `npx`/`node` gets
// run), and ELECTRON_RUN_AS_NODE are all code-exec / hijack vectors. Compared
// case-insensitively. See sanitizeOverrideEnv.
const UNSAFE_OVERRIDE_ENV_NAMES = new Set([
  'node_options',
  'node_path',
  'node_repl_external_module',
  'ld_preload',
  'ld_library_path',
  'ld_audit',
  'dyld_insert_libraries',
  'dyld_library_path',
  'dyld_framework_path',
  'path',
  'pathext',
  'electron_run_as_node',
]);

export function isUnsafeOverrideEnvName(name: string): boolean {
  const n = name.toLowerCase();
  if (UNSAFE_OVERRIDE_ENV_NAMES.has(n)) return true;
  // npm/npx read every `npm_config_*` var: `npm_config_node_options` smuggles
  // NODE_OPTIONS, `npm_config_registry` re-points where the package is fetched
  // from (a trojaned build of the very package the launcher runs). The whole
  // surface is launcher-trusted config — keep it out of a built-in tweak.
  if (n.startsWith('npm_config_')) return true;
  // The same attack for the Python launchers (`uvx blender-mcp`): uv / pip
  // index + config vars re-point where the package comes from, and the
  // interpreter's startup vars load arbitrary code into it.
  if (n.startsWith('uv_') || n.startsWith('pip_')) return true;
  if (n === 'pythonpath' || n === 'pythonstartup' || n === 'pythonhome' || n === 'pythonuserbase') {
    return true;
  }
  // A CA bundle + proxy override is a MITM on the package fetch itself.
  if (
    n === 'node_extra_ca_certs' ||
    n === 'ssl_cert_file' ||
    n === 'ssl_cert_dir' ||
    n === 'requests_ca_bundle' ||
    n === 'https_proxy' ||
    n === 'http_proxy' ||
    n === 'all_proxy'
  ) {
    return true;
  }
  // Catch NODE_OPTIONS smuggled under a wrapper var name.
  if (n.includes('node_options')) return true;
  return false;
}

// ---- Override ARGS: flags that point a built-in at an arbitrary binary ----
//
// The additive-args rule (settingsValidation.ts `mergeOverrideArgs`) stops an
// override replacing the package spec, but an APPENDED flag can still re-point
// what runs: Playwright MCP's `--executable-path` and chrome-devtools-mcp's
// `--executablePath` launch whatever file they're given as "the browser". That
// is "run an arbitrary command" with extra steps, so these flags are refused
// outright. Matched on a normalized name (lower-cased, `-`/`_` dropped), so
// `--executable-path`, `--executablePath`, `--EXECUTABLE_PATH` and the
// `--flag=value` form are all one entry; yargs (chrome-devtools-mcp) accepts
// both kebab and camel spellings, which is why normalizing beats listing.
// `--chrome-arg` is here too: it forwards raw Chrome switches, and Chrome's own
// `--renderer-cmd-prefix` / `--utility-cmd-prefix` / `--browser-subprocess-path`
// launch an arbitrary binary just the same.
const UNSAFE_OVERRIDE_ARG_FLAGS = new Set([
  'executablepath',
  'browserexecutable',
  'browserexecutablepath',
  'chromepath',
  'chromeexecutable',
  'browserpath',
  'chromearg',
]);

// chrome-devtools-mcp's short alias for `--executablePath` is `-e`. A single-dash
// arg is a cluster of short flags (`-e`, `-e=/x`, `-e/x`, `-ie /x`), so any
// cluster that contains an `e` is refused for that server.
const UNSAFE_SHORT_FLAGS_BY_SERVER: Record<string, string> = {
  'chrome-devtools': 'e',
};

// Long flags refused only for one server. Playwright MCP's `--config <file>`
// loads a JSON config whose `browser.launchOptions.executablePath` launches any
// binary — the same escape as `--executable-path`, one file away.
const UNSAFE_LONG_FLAGS_BY_SERVER: Record<string, ReadonlySet<string>> = {
  playwright: new Set(['config']),
};

// Normalized long-flag name of an arg, or null when it isn't a `--flag`.
function longFlagName(arg: string): string | null {
  const m = /^--([^=]*)/.exec(arg);
  if (!m) return null;
  return m[1].toLowerCase().replace(/[-_]/g, '');
}

// Is this appended override arg a binary-launching flag (either form: `--flag
// value` is caught on the flag token, `--flag=value` on its name part)?
// Case-insensitive. `serverId` scopes the short-alias check.
export function isUnsafeOverrideArg(arg: string, serverId?: string): boolean {
  const long = longFlagName(arg);
  if (long !== null) {
    if (UNSAFE_OVERRIDE_ARG_FLAGS.has(long)) return true;
    return serverId ? UNSAFE_LONG_FLAGS_BY_SERVER[serverId]?.has(long) === true : false;
  }
  const shortBanned = serverId ? UNSAFE_SHORT_FLAGS_BY_SERVER[serverId] : undefined;
  if (shortBanned && /^-[^-]/.test(arg)) {
    // Only the flag letters before any `=` / value characters matter.
    const cluster = /^-([A-Za-z]*)/.exec(arg)?.[1] ?? '';
    return cluster.toLowerCase().includes(shortBanned);
  }
  return false;
}

// Keep only string-valued env keys that can't inject code into / hijack the
// launcher (see UNSAFE_OVERRIDE_ENV_NAMES). This is the env half of "an override
// may only tune a built-in, never re-point what it runs".
export function sanitizeOverrideEnv(obj: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string') continue;
    if (isUnsafeOverrideEnvName(k)) continue;
    out[k] = v;
  }
  return out;
}
