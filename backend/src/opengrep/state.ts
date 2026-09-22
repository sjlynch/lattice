// `~/.lattice/opengrep/state.json` — what Lattice has installed: the managed
// engine (version + which asset + its verified digest) and each rule pack
// (commit, rule counts, licence). Read on every status call; written only by
// install.ts / rules.ts after a successful install. Atomic + serialized like
// the other home-scoped JSON files.

import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../claudeTrust/configFile.js';
import { runExclusive } from '../serializeWrites.js';
import { stateFilePath } from './paths.js';

export type OpengrepBinaryState = {
  version: string;
  asset: string;
  sha256: string;
  installedAt: number;
};

export type OpengrepPackState = {
  commit: string;
  // Rule FILES kept after pruning, and the `- id:` entries counted in them.
  ruleFiles: number;
  ruleCount: number;
  licence: string;
  installedAt: number;
};

export type OpengrepState = {
  binary?: OpengrepBinaryState;
  packs: Record<string, OpengrepPackState>;
};

const EMPTY: OpengrepState = { packs: {} };

function normalize(raw: unknown): OpengrepState {
  if (!raw || typeof raw !== 'object') return { packs: {} };
  const r = raw as Partial<OpengrepState>;
  const packs: Record<string, OpengrepPackState> = {};
  if (r.packs && typeof r.packs === 'object') {
    for (const [id, p] of Object.entries(r.packs)) {
      if (p && typeof p === 'object' && typeof (p as OpengrepPackState).commit === 'string') {
        packs[id] = p as OpengrepPackState;
      }
    }
  }
  const binary =
    r.binary && typeof r.binary === 'object' && typeof r.binary.version === 'string'
      ? r.binary
      : undefined;
  return binary ? { binary, packs } : { packs };
}

export async function readOpengrepState(): Promise<OpengrepState> {
  return readState(true);
}

// `lenient` (display / scan reads) treats an unreadable file as empty. The
// WRITE path must not: building the next state on that `{}` dropped `binary`
// and every other pack's record the moment one pack install landed during a
// transient read failure (an antivirus hold right after a rename), and scans
// then silently skipped the "uninstalled" pack still on disk.
async function readState(lenient: boolean): Promise<OpengrepState> {
  try {
    return normalize(JSON.parse(await fs.readFile(stateFilePath(), 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY, packs: {} };
    if (!lenient) {
      throw new Error(
        `Opengrep state.json unreadable (${(err as Error).message}) — refusing to overwrite it`,
      );
    }
    // A corrupt file reads as empty (the install paths will rewrite it); the
    // engine/packs on disk are re-discoverable, so nothing is lost.
    console.warn('[opengrep] state.json unreadable, treating as empty:', (err as Error).message);
    return { packs: {} };
  }
}

export async function updateOpengrepState(
  mutate: (state: OpengrepState) => OpengrepState | void,
): Promise<OpengrepState> {
  const file = stateFilePath();
  return runExclusive(`opengrep-state:${file}`, async () => {
    const current = await readState(false);
    const next = mutate(current) ?? current;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, JSON.stringify(next, null, 2));
    return next;
  });
}
