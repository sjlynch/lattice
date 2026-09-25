// Inventory of the project stores that already exist under a Lattice home:
// which physical project each on-disk storage hash is evidence for.
import fs from 'node:fs';
import path from 'node:path';
import { type Inventory, STORAGE_HASH_RE, boundStorage, hashPath, inventories, legacyPath, remember, reservationKey } from './caches.js';
import { bindingsDir, isBindingFileName, parseBinding } from './binding.js';
import { ProjectIdentityConflictError } from './errors.js';
import { exists, readDirectory } from './fsProbe.js';

/** Resolves a project path to its physical identity (the facade's `physicalProjectPath`). */
export type PhysicalResolver = (input: string) => string;

/** Home subdirectories whose `<hash>/` entry proves a store exists for that hash. */
const STORE_DIRS = ['per-project', 'snapshots', 'worktrees', 'git-backups'];
/** Per-project files that record `projectPath`, in the order they are consulted. */
const TASK_STORE_FILES = ['tasks.json', 'tasks.backup.json', 'workflow-runs.json', 'merge-runs.json'];
/** Bytes of an unindexed store read when looking for its project path. */
const METADATA_SCAN_BYTES = 64 * 1024;

function hasStoredHash(home: string, hash: string): boolean {
  return STORE_DIRS.some((kind) => exists(path.join(home, kind, hash)));
}

export function addCandidate(
  inventory: Inventory,
  home: string,
  original: string,
  resolvePhysical: PhysicalResolver,
  hash = hashPath(legacyPath(original)),
): void {
  if (!path.isAbsolute(original) || original.includes('\0')) return;
  if (hashPath(legacyPath(original)) !== hash || !hasStoredHash(home, hash)) return;
  const authority = boundStorage.get(reservationKey(home, hash));
  const physical = authority?.physical ?? resolvePhysical(original);
  let candidates = inventory.get(physical);
  if (!candidates) inventory.set(physical, candidates = new Map());
  candidates.set(hash, { hash, legacyPath: authority?.legacy ?? legacyPath(original) });
}

// Task/run JSON places projectPath near the start. Read at most 64KB of an
// unindexed store, avoiding whole mature task databases on the synchronous path.
function readMetadataPath(file: string, field: 'projectPath' | 'repoRoot'): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(METADATA_SCAN_BYTES);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const match = new RegExp(`"${field}"\s*:\s*("(?:[^"\\]|\\.)*")`).exec(buffer.toString('utf8', 0, length));
    return match ? JSON.parse(match[1]) as string : undefined;
  } catch (err) {
    // Incomplete/corrupt metadata and stray directory entries are not identity
    // evidence. Permission/I/O errors still refuse discovery rather than infer
    // that an unreadable candidate has no owner.
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (err instanceof SyntaxError || ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(code)) return undefined;
    throw err;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function inventoryFor(home: string, resolvePhysical: PhysicalResolver): Inventory {
  const cached = inventories.get(home);
  if (cached) return cached;
  const inventory: Inventory = new Map();
  // A migrated alias may later be removed or retargeted. Its immutable binding
  // reserves the old hash for the original physical project; inferring from an
  // old task's path must never lend that store to the alias's new target.
  for (const name of readDirectory(bindingsDir(home))) {
    if (!isBindingFileName(name)) continue;
    const file = path.join(bindingsDir(home), name);
    const binding = parseBinding(file);
    const key = reservationKey(home, binding.storageHash);
    const prior = boundStorage.get(key);
    if (prior && prior.physical !== binding.physicalPath) {
      throw new ProjectIdentityConflictError(`conflicting storage reservations for ${binding.storageHash} at ${file}; preserving all project state`);
    }
    boundStorage.set(key, { physical: binding.physicalPath, legacy: binding.legacyPath });
    addCandidate(inventory, home, binding.legacyPath, resolvePhysical, binding.storageHash);
  }
  const indexFile = path.join(home, 'projects.json');
  if (exists(indexFile)) {
    const projects: unknown = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    if (!Array.isArray(projects)) throw new Error(`[projectIdentity] invalid project index at ${indexFile}; preserving existing state`);
    for (const project of projects) {
      if (typeof project === 'string' && project) addCandidate(inventory, home, project, resolvePhysical);
    }
  }
  for (const hash of readDirectory(path.join(home, 'per-project'), true)) {
    if (!STORAGE_HASH_RE.test(hash)) continue;
    const dir = path.join(home, 'per-project', hash);
    const marker = path.join(dir, '.canonical-path');
    if (exists(marker) && fs.statSync(marker).isFile()) {
      addCandidate(inventory, home, fs.readFileSync(marker, 'utf8').trim(), resolvePhysical, hash);
    }
    for (const file of TASK_STORE_FILES) {
      const original = readMetadataPath(path.join(dir, file), 'projectPath');
      if (original) { addCandidate(inventory, home, original, resolvePhysical, hash); break; }
    }
  }
  // Snapshots can outlive both the project index and its task database.
  for (const hash of readDirectory(path.join(home, 'snapshots'), true)) {
    if (!STORAGE_HASH_RE.test(hash)) continue;
    const dir = path.join(home, 'snapshots', hash);
    for (const name of readDirectory(dir, true)) {
      const original = readMetadataPath(path.join(dir, name, '_lattice-snapshot.json'), 'repoRoot');
      if (original) { addCandidate(inventory, home, original, resolvePhysical, hash); break; }
    }
  }
  return remember(inventories, home, inventory);
}
