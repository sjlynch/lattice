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
