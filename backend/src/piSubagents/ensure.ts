// Single-flight install state: resolves (once) the shared-install entry path
// that the discovery shim re-exports, and hands it out to the shim installer.
//
// `ensurePiSubagentsInstalled()` is called on boot and on every project open;
// it short-circuits once resolved and retries on the next trigger after a
// transient failure. `getPiSubagentsEntry()` exposes the resolved entry (or
// null) to render/shim and to callers that gate on installation.

import fs from 'node:fs/promises';
import { detectHarnesses } from '../harnessDetect.js';
import {
  PI_SUBAGENTS_SPEC,
  installDir,
  packageDir,
  resolveEntry,
} from './paths.js';
import { runPiInstall } from './install.js';

// Absolute path (forward-slashed) to the extension entry Pi should load, or
// null until the shared install has been resolved.
let resolvedEntry: string | null = null;
let installPromise: Promise<void> | null = null;

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
