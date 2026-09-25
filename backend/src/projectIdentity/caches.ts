// Bounded process caches for project identity, plus the path spelling and
// storage-hash helpers every identity decision is keyed by.
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_PATHS = 2048;
/** Hex characters of sha1(path) that name a per-project store. */
export const STORAGE_HASH_LEN = 12;
export const STORAGE_HASH_RE = new RegExp(`^[a-f0-9]{${STORAGE_HASH_LEN}}$`);

export type Candidate = { hash: string; legacyPath: string };
export type Inventory = Map<string, Map<string, Candidate>>;

export const physicalPaths = new Map<string, string>();
export const storageHashes = new Map<string, string>();
export const inventories = new Map<string, Inventory>();
/** `${home}\0${storageHash}` → the physical project an immutable binding reserved it for. */
export const boundStorage = new Map<string, { physical: string; legacy: string }>();

export function reservationKey(home: string, hash: string): string {
  return `${home}\0${hash}`;
}

export function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= MAX_PATHS && !cache.has(key)) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

export function legacyPath(input: string): string {
  const resolved = path.resolve(input);
  return process.platform === 'win32' && /^[a-z]:/.test(resolved)
    ? resolved[0].toUpperCase() + resolved.slice(1) : resolved;
}

export function hashPath(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, STORAGE_HASH_LEN);
}
