// Hand-written declarations for the shared declared-vs-installed dependency
// check, so TS consumers (the backend __tests__ suite) get types for it.
// Keep in sync with depsCheck.mjs.

export type StaleDep =
  | { name: string; reason: 'missing' }
  | { name: string; reason: 'version'; expected: string; installed: string };

/** Direct dependency names a manifest declares (deps + devDeps, deduped). */
export function declaredDeps(manifest: unknown): string[];

/** Lockfile-pinned version of a direct dep, or `null` when it pins none. */
export function lockedVersion(lock: unknown, name: string): string | null;

export function findStaleDeps(args: {
  manifest: unknown;
  lock: unknown;
  installedVersion: (name: string) => string | null;
}): StaleDep[];

export function installedVersionIn(dir: string): (name: string) => string | null;

export function checkWorkspaceDeps(dir: string): StaleDep[];

export function describeStaleDep(dep: StaleDep, prefix?: string): string;
