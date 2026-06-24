// Auto-installs the `@tintinweb/pi-subagents` Pi extension into a Lattice-owned
// shared location and drops a tiny re-export *shim* that loads it ONLY in Pi
// sessions associated with a Lattice project — never touching the user's global
// `~/.pi/agent/settings.json` (so a `pi` they run outside Lattice is untouched).
//
// Why a shared install + shim (and not plain `pi install`, and not `-e`):
//
//   - `pi install npm:@tintinweb/pi-subagents` (no `-l`) writes the GLOBAL
//     `~/.pi/agent/settings.json` `packages` array → the extension then loads
//     in EVERY pi session on the machine. That global pollution is exactly what
//     we must avoid.
//   - `pi install <src> -l` instead writes a project-local `<cwd>/.pi/settings.json`
//     and installs the package (plus deps) under `<cwd>/.pi/npm/node_modules/`.
//     We run it ONCE with cwd = `~/.lattice/pi-extensions/`, so there is a single
//     shared copy on the machine and the user's global config stays `packages: []`.
//   - Pi auto-discovers `<cwd>/.pi/extensions/*.ts` — but cwd-EXACT (verified: it
//     does NOT walk up parent dirs). Lattice already drops `lattice-complete.ts`
//     there for the completion backstop; we drop a sibling `lattice-subagents.ts`
//     whose only content re-exports the shared install's default export. Pi loads
//     it, the extension's peer deps (`@earendil-works/pi-*`) resolve through Pi's
//     own loader (verified), and the `Agent` / `get_subagent_result` /
//     `steer_subagent` tools register.
//
// Net scope: the extension is active in exactly the cwds Lattice drops the shim
// into — every Lattice-spawned Pi session (worktree task, workflow step,
// post-merge hook, prompt customization) PLUS the project root (so a `pi` the
// user launches in the Lattice terminal panel, cwd = project root, gets it too).
// `-e` would only reach command lines Lattice itself builds; a discovery shim is
// what reaches a manually-typed `pi`.

import path from 'node:path';
import fs from 'node:fs/promises';
import { latticeHomeDir } from './projectPath.js';
import { detectHarnesses } from './harnessDetect.js';
import { spawnWithTimeout } from './spawnWithTimeout.js';

const PI_SUBAGENTS_SPEC = 'npm:@tintinweb/pi-subagents';

// Filename of the discovery shim, dropped alongside `lattice-complete.ts`. Pi
// auto-loads any `.ts` in `.pi/extensions/`, so no settings entry is needed.
export const PI_SUBAGENTS_SHIM_FILENAME = 'lattice-subagents.ts';

// `pi install -l` can take ~20s on a cold cache (it runs `npm install` for the
// package + ~130 transitive deps). Generous bound; it only happens once.
const PI_INSTALL_TIMEOUT_MS = 180_000;

// The shared, Lattice-owned install root. Home-scoped and OUTSIDE any project
// tree on purpose (same rule as worktrees / scratch). `pi install -l` here
// writes `<dir>/.pi/settings.json` + `<dir>/.pi/npm/node_modules/...`.
function installDir(): string {
  return path.join(latticeHomeDir(), 'pi-extensions');
}

function packageDir(): string {
  return path.join(
    installDir(),
    '.pi',
    'npm',
    'node_modules',
    '@tintinweb',
    'pi-subagents',
  );
}

// Absolute path (forward-slashed) to the extension entry Pi should load, or
// null until the shared install has been resolved. Forward slashes work in
// Node's `require` on every platform and sidestep backslash-escaping in the
// generated shim source.
let resolvedEntry: string | null = null;
let installPromise: Promise<void> | null = null;

// Pick the entry file the package declares (`pi.extensions[0]`, currently
// `./src/index.ts`), falling back to the compiled `dist/index.js` then `src`.
// All three are verified to load via the shim; we prefer the author-declared
// one so a future package restructure keeps working.
async function resolveEntry(pkgDir: string): Promise<string | null> {
  let declared: string | null = null;
  try {
    const pj = JSON.parse(
      await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8'),
    ) as { pi?: { extensions?: unknown } };
    const list = pj?.pi?.extensions;
    if (Array.isArray(list) && typeof list[0] === 'string') declared = list[0];
  } catch {
    return null; // package not present / unreadable → not installed yet
  }
  const candidates = [declared, 'dist/index.js', 'src/index.ts'].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );
  for (const rel of candidates) {
    const abs = path.resolve(pkgDir, rel);
    try {
      await fs.access(abs);
      return abs.replace(/\\/g, '/');
    } catch {
      /* try next */
    }
  }
  return null;
}

async function runPiInstall(cwd: string): Promise<void> {
  // shell:true so Windows resolves `pi` → `pi.cmd`; args are static constants
  // (no injection surface). Maps the shared spawn result onto this caller's
  // resolve-on-exit-0 / reject-otherwise contract.
  const r = await spawnWithTimeout('pi', ['install', PI_SUBAGENTS_SPEC, '-l'], {
    cwd,
    shell: true,
    timeoutMs: PI_INSTALL_TIMEOUT_MS,
  });
  if (r.timedOut) {
    throw new Error(`pi install timed out after ${PI_INSTALL_TIMEOUT_MS}ms`);
  }
  if (r.error) throw r.error;
  if (r.code !== 0) {
    throw new Error(`pi install exited ${r.code}: ${r.stderr.slice(0, 500)}`);
  }
}

async function doEnsure(): Promise<void> {
  const avail = await detectHarnesses();
  if (!avail.pi) {
    console.log('[pi-subagents] pi CLI not on PATH; skipping auto-install');
    return;
  }
  // Fast path: a prior run already installed it.
  const pre = await resolveEntry(packageDir());
  if (pre) {
    resolvedEntry = pre;
    console.log(`[pi-subagents] already installed; entry=${pre}`);
    return;
  }
  await fs.mkdir(installDir(), { recursive: true });
  console.log(
    `[pi-subagents] installing ${PI_SUBAGENTS_SPEC} (project-local, into ${installDir()})…`,
  );
  await runPiInstall(installDir());
  const entry = await resolveEntry(packageDir());
  if (entry) {
    resolvedEntry = entry;
    console.log(`[pi-subagents] installed; entry=${entry}`);
  } else {
    console.warn(
      '[pi-subagents] install completed but extension entry was not resolvable',
    );
  }
}

// Idempotent, single-flight. Safe to call on every boot and project open: it
// short-circuits once resolved, and a failed attempt (offline / transient) is
// retried on the next call. Never throws — failures degrade to "no subagents"
// (the shim install becomes a no-op), they don't break a spawn.
export function ensurePiSubagentsInstalled(): Promise<void> {
  if (resolvedEntry) return Promise.resolve();
  if (!installPromise) {
    installPromise = doEnsure()
      .catch((err) => {
        console.warn(
          '[pi-subagents] auto-install failed (will retry on next trigger):',
          err,
        );
      })
      .finally(() => {
        // Allow a retry next trigger if it didn't actually resolve.
        if (!resolvedEntry) installPromise = null;
      });
  }
  return installPromise;
}

// The resolved shared-install entry (forward-slashed absolute path) or null.
export function getPiSubagentsEntry(): string | null {
  return resolvedEntry;
}

// Pure renderer for the discovery shim — exported for unit testing.
export function renderPiSubagentsShim(entry: string): string {
  return `// Lattice-managed — do not commit. Loads the @tintinweb/pi-subagents
// extension from Lattice's shared install so Pi sub-agents are available in
// this Lattice Pi session WITHOUT a global \`pi install\` (your
// ~/.pi/agent/settings.json stays untouched). Pi auto-discovers any .ts in this
// directory; this file just re-exports the extension's default activation fn.
export { default } from ${JSON.stringify(entry)};
`;
}

// Drop the re-export shim into `<dir>/.pi/extensions/lattice-subagents.ts`.
// No-op (graceful) until the shared install has resolved — a shim pointing at a
// missing entry would make Pi error at startup ("Failed to load extension"), so
// we only write it once the target exists. Idempotent: skips the write when the
// on-disk contents already match, so a worktree reconcile doesn't dirty
// `git status`.
export async function installPiSubagentsShim(args: {
  dir: string;
}): Promise<void> {
  const entry = resolvedEntry;
  if (!entry) return;
  const extDir = path.join(args.dir, '.pi', 'extensions');
  const shimFile = path.join(extDir, PI_SUBAGENTS_SHIM_FILENAME);
  const expected = renderPiSubagentsShim(entry);
  try {
    const existing = await fs.readFile(shimFile, 'utf8');
    if (existing === expected) return;
  } catch {
    /* absent — fall through to write */
  }
  await fs.mkdir(extDir, { recursive: true });
  await fs.writeFile(shimFile, expected, 'utf8');
  console.log(`[pi-subagents] installed subagents shim at ${shimFile}`);
}
