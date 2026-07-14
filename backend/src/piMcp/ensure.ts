// Single-flight install state for the shared `pi-mcp-adapter` install. Mirror
// of `piSubagents/ensure.ts`: resolve (once) the entry the discovery shim
// re-exports, hand it to the shim installer, retry after a transient failure,
// never throw (a failure degrades to "no Pi MCP", it doesn't break a spawn).

import fs from 'node:fs/promises';
import { detectHarnesses } from '../harnessDetect.js';
import { PI_MCP_SPEC, installDir, packageDir, resolveEntry } from './paths.js';
import { runPiMcpInstall } from './install.js';

let resolvedEntry: string | null = null;
let installPromise: Promise<void> | null = null;

async function doEnsure(): Promise<void> {
  const avail = await detectHarnesses();
  if (!avail.pi) {
    console.log('[pi-mcp] pi CLI not on PATH; skipping auto-install');
    return;
  }
  const pre = await resolveEntry(packageDir());
  if (pre) {
    resolvedEntry = pre;
    console.log(`[pi-mcp] already installed; entry=${pre}`);
    return;
  }
  await fs.mkdir(installDir(), { recursive: true });
  console.log(
    `[pi-mcp] installing ${PI_MCP_SPEC} (project-local, into ${installDir()})…`,
  );
  await runPiMcpInstall(installDir());
  const entry = await resolveEntry(packageDir());
  if (entry) {
    resolvedEntry = entry;
    console.log(`[pi-mcp] installed; entry=${entry}`);
  } else {
    console.warn('[pi-mcp] install completed but extension entry was not resolvable');
  }
}

// Idempotent, single-flight. Safe to call on every boot + project open; retries
// after a transient failure. Never throws.
export function ensurePiMcpInstalled(): Promise<void> {
  if (resolvedEntry) return Promise.resolve();
  if (!installPromise) {
    installPromise = doEnsure()
      .catch((err) => {
        console.warn('[pi-mcp] auto-install failed (will retry on next trigger):', err);
      })
      .finally(() => {
        if (!resolvedEntry) installPromise = null;
      });
  }
  return installPromise;
}

// The resolved shared-install entry (forward-slashed absolute path) or null.
export function getPiMcpEntry(): string | null {
  return resolvedEntry;
}
