// Load-or-create for a small persisted secret under ~/.lattice
// (`terminalServerToken`, `agentTokenSecret`).
//
// These secrets are shared with things that OUTLIVE the process that minted
// them — the detached terminal-server holds the token it was launched with, and
// HMAC activity tokens are baked into project hook commands — so replacing an
// existing secret silently breaks them (every terminal-server call 401s; graph
// activity vanishes). The only safe reasons to mint a new one are "the file is
// absent" and "the file holds an unusable value". A transient read error
// (EBUSY/EPERM from AV, backup or the indexer on Windows) is neither: retry
// briefly, then fail loudly WITHOUT writing.
//
// A new file is created exclusively (`flag: 'wx'`), so two racing creators
// (backend + another process) can't clobber each other: the loser re-reads the
// winner's value.
//
// fs is used through the default import so tests can stub `fs.readFileSync`.

import fs from 'node:fs';
import path from 'node:path';

export class SecretFileUnreadableError extends Error {
  constructor(
    readonly file: string,
    readonly readError: unknown,
  ) {
    super(
      `${file} exists but could not be read (${errCode(readError) ?? String(readError)}); ` +
        'refusing to replace it with a new secret',
    );
    this.name = 'SecretFileUnreadableError';
  }
}

export type PersistedSecretOptions<T> = {
  file: string;
  // Log prefix, e.g. '[terminal-auth]'.
  label: string;
  // The file's value, or null when it is present but unusable (empty,
  // truncated, too short) — which is the one case an existing file is replaced.
  parse(raw: Buffer): T | null;
  generate(): { value: T; bytes: string | Buffer };
  readAttempts?: number;
  backoffMs?: number;
};

// `persisted: false` = the value lives only in this process (the home scratch
// area could not be written).
export type PersistedSecret<T> = { value: T; persisted: boolean };

const DEFAULT_READ_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 50; // doubled per retry: ≤ 750 ms total blocking
// Bounds the ENOENT → EEXIST → re-read loop (a file flapping in and out of
// existence), independent of the read-error retries.
const MAX_ROUNDS = 20;

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeSecret<T>(
  opts: PersistedSecretOptions<T>,
  flag: 'wx' | 'w',
): PersistedSecret<T> | 'exists' {
  const { value, bytes } = opts.generate();
  try {
    fs.mkdirSync(path.dirname(opts.file), { recursive: true });
    fs.writeFileSync(opts.file, bytes, { mode: 0o600, flag });
  } catch (err) {
    if (flag === 'wx' && errCode(err) === 'EEXIST') return 'exists';
    // Couldn't persist (read-only FS / perms): degrade to a process-lifetime
    // value rather than crash. Nothing existing was overwritten.
    console.warn(`${opts.label} could not persist ${opts.file}:`, err);
    return { value, persisted: false };
  }
  try {
    fs.chmodSync(opts.file, 0o600); // best-effort owner-only (inert on Windows)
  } catch {
    /* best effort */
  }
  return { value, persisted: true };
}

// Throws SecretFileUnreadableError when the file exists but stays unreadable
// through every retry. Never overwrites a file it could not read.
export function loadOrCreatePersistedSecret<T>(
  opts: PersistedSecretOptions<T>,
): PersistedSecret<T> {
  const attempts = opts.readAttempts ?? DEFAULT_READ_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  let failures = 0;
  let lastErr: unknown;
  let lostCreateRace = false;

  const retryable = (err: unknown): void => {
    failures++;
    lastErr = err;
    if (failures >= attempts) throw new SecretFileUnreadableError(opts.file, lastErr);
    sleepSync(backoffMs * 2 ** (failures - 1));
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let raw: Buffer;
    try {
      raw = fs.readFileSync(opts.file);
    } catch (err) {
      if (errCode(err) === 'ENOENT') {
        const created = writeSecret(opts, 'wx');
        if (created !== 'exists') return created;
        // Another creator won the race: re-read its value.
        lostCreateRace = true;
        continue;
      }
      retryable(err);
      continue;
    }
    const parsed = opts.parse(raw);
    if (parsed !== null) return { value: parsed, persisted: true };
    // Just lost a create race: the winner may still be mid-write (an empty or
    // partial file) — give it a moment instead of clobbering it.
    if (lostCreateRace) {
      retryable(new Error('secret file still being written by another process'));
      continue;
    }
    // Present but unusable: nothing can depend on it, so replace it.
    const replaced = writeSecret(opts, 'w');
    if (replaced !== 'exists') return replaced; // 'exists' only comes from 'wx'
  }
  throw new SecretFileUnreadableError(opts.file, lastErr ?? new Error('file kept changing'));
}
