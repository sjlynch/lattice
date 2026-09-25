import path from 'node:path';

// Claude Code does several pieces of background work on every launch that are
// pure overhead for an orchestrated agent: an autoupdater check (which can
// spawn an updater child process), telemetry + error-reporting uploads, and
// non-essential background model calls (conversation titling and similar).
// Under "Run All" / workflow fan-out there can be dozens of Claude processes
// alive at once, so that per-process overhead multiplies and competes for
// CPU + network with the work the user actually queued. Disable it for every
// pty Lattice spawns. Applied as defaults only — a value already present in
// the environment (the user opting in or out themselves) is left untouched.
const CLAUDE_OVERHEAD_ENV: Record<string, string> = {
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
};

export function applyClaudeOverheadEnv(env: { [key: string]: string }): void {
  for (const [key, value] of Object.entries(CLAUDE_OVERHEAD_ENV)) {
    if (!env[key]) env[key] = value;
  }
}

// npm exports its ENTIRE resolved config to every run-script as `npm_config_*`,
// plus a set of `npm_*` lifecycle vars describing the package it is running.
// Lattice's backend is itself an npm run-script, and every pty inherits the
// backend's environment wholesale (see launchContext), so without this a
// terminal opened in an unrelated project still carries Lattice's npm context.
//
// The one that does real damage is `npm_config_prefix`. npm's `prefix` is
// primarily "the location to install global items" — its "run non-global
// commands in this folder" behavior is the secondary meaning `npm --prefix`
// was being used for. Inherited, it silently redirected `npm install -g <pkg>`
// in ANY Lattice terminal, in ANY project, into Lattice's own `backend/`:
// the shims land next to the repo's own files (untracked, outside the
// `node_modules/` ignore rule), the package is NOT on PATH so it appears not to
// have installed at all, and the next `npm install` in `backend/` prunes it as
// extraneous. `scripts/orchestrate/config.mjs` removes the cause; this is the
// matching defence at the pty boundary, so a Lattice started some other way
// (or a future `--prefix` creeping back in) can't leak it into user terminals.
//
// `npm_config_global_prefix` / `npm_config_local_prefix` are inert — npm treats
// them as unknown env config — but they carry the same wrong value, so they go
// too, along with `npm_config_globalconfig` (which repointed the global npmrc
// into `backend/etc/npmrc`).
//
// Deliberately NOT a blanket `npm_config_*` scrub: `npm_config_registry`,
// `npm_config_cache` and the `//registry/:_authToken` forms may be the user's
// OWN ambient npm configuration, and dropping those would break installs
// against a private registry inside Lattice terminals only. Everything removed
// here is either wrong-valued or re-derived by npm on its own: npm re-reads
// `.npmrc` in the child, and re-sets every `npm_*` var for any script it runs.
const INHERITED_NPM_ENV_KEYS = new Set([
  'npm_config_prefix',
  'npm_config_global_prefix',
  'npm_config_local_prefix',
  'npm_config_globalconfig',
  // Lifecycle/package context describing Lattice's own `backend` package. Not
  // dangerous, just untrue in someone else's project — and `npm_execpath` is
  // what "which package manager launched me?" helpers read to decide whether a
  // repo is an npm/pnpm/yarn project.
  'npm_command',
  'npm_execpath',
  'npm_node_execpath',
  'init_cwd',
  // npm describing ITSELF rather than describing the user's configuration.
  // `npm_config_user_agent` ("npm/11.17.0 node/v24.19.0 win32 x64") is the
  // other half of the package-manager sniff above — it is what corepack and
  // every `preferred-pm`-style helper reads first, so leaving it while dropping
  // `npm_execpath` would still tell a project in someone else's repo that npm
  // ran it. `npm_config_npm_version` is the same claim in another field, and
  // `npm_config_node_gyp` points a native build at the node-gyp belonging to
  // whichever npm launched Lattice. All three are re-set by npm for any script
  // it actually runs, so only commands typed at the prompt see the difference.
  //
  // Everything else npm exports under `npm_config_` stays: `registry`, `cache`,
  // `userconfig`, `noproxy`, `init_module`, the `//registry/:_authToken` forms
  // — those are the user's own `.npmrc`, and dropping them would break a
  // private-registry install inside Lattice terminals only.
  'npm_config_user_agent',
  'npm_config_npm_version',
  'npm_config_node_gyp',
  // Windows' `npm.cmd` shim `SET`s these (no SETLOCAL) to locate npm-cli.js, so
  // they ride along into the node it launches and on to every pty. They name
  // whichever npm install launched Lattice; npm.cmd re-sets them on every run.
  'npm_cli_js',
  'npm_prefix_js',
  'npm_prefix_npm_cli_js',
]);

const INHERITED_NPM_ENV_PREFIXES = ['npm_package_', 'npm_lifecycle_'];

// npm also prepends a `node_modules/.bin` entry to PATH for the package it is
// running AND for every ancestor directory of it. Inherited, that put Lattice's
// OWN dev-dependency binaries — `tsc`, `tsserver`, `tsx`, `esbuild`, `mime`
// from `backend/`, plus `playwright`, `playwright-core`, `concurrently`,
// `conc`, `tree-kill` from the repo root — on the PATH of every terminal in
// every project. None of them are otherwise installed on a typical machine, so
// this doesn't override a correct tool: it invents one. An agent in a
// TypeScript project that hasn't installed TypeScript yet runs `tsc --noEmit`,
// silently gets LATTICE's compiler against that project's config, and reports a
// clean type-check that means nothing. It never errors — it only answers wrong.
//
// Rather than guess which entries "look like" Lattice (which would hardcode a
// layout that can drift), reverse npm's injection exactly: it walks up from the
// local prefix, so the set it added is derivable from `npm_config_local_prefix`
// alone. That needs no knowledge of where Lattice is installed, works for any
// user's checkout, and correctly does NOTHING when Lattice was started some
// other way (no local prefix ⇒ npm added nothing to remove).
//
// Removal happens BEFORE applyFreshWindowsPath, so on Windows the registry PATH
// is still merged over the result — a directory the user deliberately put on
// their real PATH comes back. npm re-injects these for any script IT runs, so
// `npm run test:e2e` and friends are unaffected; only commands typed directly
// at the prompt lose the borrowed binaries.
function removeNpmInjectedPathEntries(
  env: { [key: string]: string },
  localPrefix: string,
  platform: NodeJS.Platform,
): void {
  const isWindows = platform === 'win32';
  const p = isWindows ? path.win32 : path.posix;
  const delimiter = isWindows ? ';' : ':';

  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  if (!pathKey || !env[pathKey]) return;

  // Every `<ancestor>/node_modules/.bin` npm would have added, walking up from
  // the local prefix to the filesystem root exactly as npm does.
  const injected = new Set<string>();
  let dir = p.resolve(localPrefix);
  for (;;) {
    const bin = p.join(dir, 'node_modules', '.bin');
    injected.add(isWindows ? bin.toLowerCase() : bin);
    const parent = p.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Preserve every surviving entry verbatim — this only ever removes.
  const kept = env[pathKey]
    .split(delimiter)
    .filter((entry) => {
      if (!entry) return true;
      const normalized = p.resolve(entry);
      return !injected.has(isWindows ? normalized.toLowerCase() : normalized);
    });

  env[pathKey] = kept.join(delimiter);
}

export function scrubInheritedNpmEnv(
  env: { [key: string]: string },
  // Injectable so the behavior is unit-testable on any host, the same way
  // resolveDefaultShell takes a platform.
  platform: NodeJS.Platform = process.platform,
): void {
  // Read the local prefix BEFORE the key sweep below deletes it — it is the
  // anchor the PATH cleanup derives npm's injected set from.
  const localPrefix = Object.keys(env).find(
    (k) => k.toLowerCase() === 'npm_config_local_prefix',
  );
  if (localPrefix && env[localPrefix]) {
    removeNpmInjectedPathEntries(env, env[localPrefix], platform);
  }

  for (const key of Object.keys(env)) {
    // Windows preserves whatever case the parent used; npm writes these
    // lowercase, but match case-insensitively so a re-cased inherited copy
    // can't slip through.
    const k = key.toLowerCase();
    if (
      INHERITED_NPM_ENV_KEYS.has(k) ||
      INHERITED_NPM_ENV_PREFIXES.some((p) => k.startsWith(p))
    ) {
      delete env[key];
    }
  }
}
