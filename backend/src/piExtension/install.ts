// Filesystem side of the Pi completion extension: install/update the
// `.pi/extensions/lattice-complete.ts` file on disk and read back the sentinel
// it writes. Types, defaults, and renderer composition live in `renderer.ts`,
// which uses the source assembly in `template.ts`. `../piExtension.ts`
// re-exports the public surface.

import path from 'node:path';
import fs from 'node:fs/promises';

import { atomicWriteFile } from '../claudeTrust/configFile.js';
import {
  defaultPiExtensionFileName,
  defaultPiSentinelFileName,
  renderPiCompletionExtension,
  type PiExtensionSite,
} from './renderer.js';

// Whether the extension already on disk matches what we'd write. Pulled out so
// the "don't dirty `git status` on a no-op reconciliation" check reads as one
// named intent.
function isExtensionUpToDate(existing: string, expected: string): boolean {
  return existing === expected;
}

// Install (or update) the Pi extension on disk. Skips the write when the
// existing contents already match so a worktree reconciliation doesn't dirty
// `git status`.
export async function installPiCompletionExtension(args: {
  dir: string;
  callbackUrl: string;
  site: PiExtensionSite;
  respectQuitGate: boolean;
  promptFile?: string;
}): Promise<{ extensionFile: string; sentinelFile: string }> {
  const extDir = path.join(args.dir, '.pi', 'extensions');
  await fs.mkdir(extDir, { recursive: true });
  const extensionFile = path.join(extDir, defaultPiExtensionFileName());
  const sentinelFile = path.join(extDir, defaultPiSentinelFileName());
  const expected = renderPiCompletionExtension({
    callbackUrl: args.callbackUrl,
    site: args.site,
    respectQuitGate: args.respectQuitGate,
    promptFile: args.promptFile,
    extensionFile,
    sentinelFile,
  });
  try {
    const existing = await fs.readFile(extensionFile, 'utf8');
    if (isExtensionUpToDate(existing, expected)) return { extensionFile, sentinelFile };
  } catch {
    /* file absent — fall through to write */
  }
  // Temp + rename (as claudeStopHook.ts does for the Claude Stop hook): Pi
  // loads this file at session start, and a half-written one (a kill or a
  // full disk mid-write) is a session with no completion backstop.
  await atomicWriteFile(extensionFile, expected);
  console.log(
    `[pi-extension] installed ${args.site} backstop at ${extensionFile} ` +
      `(gate=${args.respectQuitGate ? 'quit-only' : 'any-reason'}` +
      `${args.promptFile ? `, promptFile=${args.promptFile}` : ''})`,
  );
  return { extensionFile, sentinelFile };
}

// Helper for callers that want to read a sentinel for diagnostics (e.g. the
// staleness sweep in recovery/inProgressSweep.ts could surface it on the
// task card). Returns null if absent / unparseable.
export async function readPiShutdownSentinel(
  scratchDir: string,
): Promise<unknown | null> {
  try {
    const file = path.join(
      scratchDir,
      '.pi',
      'extensions',
      defaultPiSentinelFileName(),
    );
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
