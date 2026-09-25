// Durable per-physical-project identity bindings (`project-identities/<hash>.json`):
// validation, reading, and the exclusive-create publish that pins a storage hash.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { type Candidate, STORAGE_HASH_LEN, STORAGE_HASH_RE, hashPath, legacyPath } from './caches.js';
import { ProjectIdentityConflictError } from './errors.js';
import { exists } from './fsProbe.js';

export const BINDING_VERSION = 1;
const BINDINGS_DIR = 'project-identities';
const BINDING_FILE_RE = new RegExp(`^[a-f0-9]{${STORAGE_HASH_LEN}}\.json$`);

export type Binding = { version: typeof BINDING_VERSION; physicalPath: string; storageHash: string; legacyPath: string };

export function bindingsDir(home: string): string {
  return path.join(home, BINDINGS_DIR);
}

export function bindingFile(home: string, physical: string): string {
  return path.join(bindingsDir(home), `${hashPath(physical)}.json`);
}

export function isBindingFileName(name: string): boolean {
  return BINDING_FILE_RE.test(name);
}

function isSafeAbsolute(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
}

function isValidBinding(binding: Binding | null, file: string): binding is Binding {
  if (!binding || binding.version !== BINDING_VERSION) return false;
  if (!isSafeAbsolute(binding.physicalPath) || !isSafeAbsolute(binding.legacyPath)) return false;
  if (typeof binding.storageHash !== 'string' || !STORAGE_HASH_RE.test(binding.storageHash)) return false;
  // The file is named for its physical path; the stored hash must be the legacy spelling's.
  if (hashPath(binding.physicalPath) + '.json' !== path.basename(file)) return false;
  return hashPath(legacyPath(binding.legacyPath)) === binding.storageHash;
}

export function parseBinding(file: string): Binding {
  try {
    const binding = JSON.parse(fs.readFileSync(file, 'utf8')) as Binding | null;
    if (!isValidBinding(binding, file)) throw new Error('invalid identity binding');
    return binding;
  } catch (err) {
    // The unreadable binding may reserve an old alias for another physical
    // checkout. Skipping it could lend that checkout's tasks to a new target.
    throw new ProjectIdentityConflictError(`cannot validate identity binding at ${file}: ${(err as Error).message}; preserving all project state`);
  }
}

export function readBinding(file: string, physical: string): Binding | undefined {
  if (!exists(file)) return undefined;
  const binding = parseBinding(file);
  if (binding.physicalPath !== physical) {
    throw new ProjectIdentityConflictError(`identity binding at ${file} belongs to another physical path; preserving all project state`);
  }
  return binding;
}

// Publish atomically and exclusively: write a private temp file, then hard-link
// it into place (fails with EEXIST if another backend won). A concurrent winner
// is accepted only when it chose the same storage hash.
export function publishBinding(file: string, physical: string, selected: Candidate): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const pending = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const binding: Binding = {
    version: BINDING_VERSION,
    physicalPath: physical,
    storageHash: selected.hash,
    legacyPath: selected.legacyPath,
  };
  try {
    fs.writeFileSync(pending, JSON.stringify(binding), { flag: 'wx' });
    try { fs.linkSync(pending, file); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const winner = readBinding(file, physical)!;
      if (winner.storageHash !== selected.hash) {
        throw new Error(`[projectIdentity] concurrent identity choices disagree at ${file}; no project mutation was admitted`);
      }
    }
  } finally {
    try { fs.unlinkSync(pending); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  }
}
