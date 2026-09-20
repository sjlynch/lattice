import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const MAX_PATHS = 2048;
const physicalPaths = new Map<string, string>();
const storageHashes = new Map<string, string>();
type Candidate = { hash: string; legacyPath: string };
type Inventory = Map<string, Map<string, Candidate>>;
const inventories = new Map<string, Inventory>();
const boundStorage = new Map<string, { physical: string; legacy: string }>();

export class ProjectIdentityConflictError extends Error {
  constructor(message: string) { super(`[projectIdentity] ${message}`); this.name = 'ProjectIdentityConflictError'; }
}

function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= MAX_PATHS && !cache.has(key)) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

function legacyPath(input: string): string {
  const resolved = path.resolve(input);
  return process.platform === 'win32' && /^[a-z]:/.test(resolved)
    ? resolved[0].toUpperCase() + resolved.slice(1) : resolved;
}

function hashPath(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

// Existing directories use physical identity, including Windows' on-disk case
// and junction/short-name aliases. Do not lowercase: case-sensitive Windows
// directories and POSIX paths must remain distinct. Resolutions are pinned in a
// bounded process cache; restart after retargeting an already-open junction.
export function physicalProjectPath(input: string): string {
  if (!input) return input;
  const resolved = legacyPath(input);
  const cached = physicalPaths.get(resolved);
  if (cached) return cached;
  if (missingThisTurn.has(resolved)) return resolved;
  try {
    const physical = legacyPath(fs.realpathSync.native(resolved));
    return remember(physicalPaths, resolved, physical);
  } catch (err) {
    if (!['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
    rememberMissingThisTurn(resolved);
    return resolved;
  }
}

// A failed resolution is memoized only for the REST OF THE CURRENT EVENT-LOOP
// TURN — not for a TTL. A project created a moment later must still resolve
// physically (the folder picker creates a dir and opens it at once), yet the
// synchronous per-task loops in `/api/tasks` (partitionByProject canonicalizes
// every task's projectPath) must not turn a deleted/moved project's 500-task
// board into 500 blocking failed realpath syscalls + thrown Errors per request.
// One turn is exactly the window such a loop runs in, and nothing shorter than
// "the directory appeared while we were mid-loop" can be missed.
const missingThisTurn = new Set<string>();
let missingFlushScheduled = false;

function rememberMissingThisTurn(resolved: string): void {
  missingThisTurn.add(resolved);
  if (missingFlushScheduled) return;
  missingFlushScheduled = true;
  setImmediate(() => {
    missingFlushScheduled = false;
    missingThisTurn.clear();
  });
}

function exists(file: string): boolean {
  try { fs.statSync(file); return true; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function readDirectory(dir: string, directoriesOnly = false): string[] {
  try {
    return directoriesOnly
      ? fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      : fs.readdirSync(dir);
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function hasStoredHash(home: string, hash: string): boolean {
  return ['per-project', 'snapshots', 'worktrees', 'git-backups'].some((kind) => exists(path.join(home, kind, hash)));
}

function addCandidate(inventory: Inventory, home: string, original: string, hash = hashPath(legacyPath(original))): void {
  if (!path.isAbsolute(original) || original.includes('\0') || hashPath(legacyPath(original)) !== hash || !hasStoredHash(home, hash)) return;
  const authority = boundStorage.get(`${home}\0${hash}`);
  const physical = authority?.physical ?? physicalProjectPath(original);
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
    const buffer = Buffer.alloc(64 * 1024);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const match = new RegExp(`"${field}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(buffer.toString('utf8', 0, length));
    return match ? JSON.parse(match[1]) as string : undefined;
  } catch (err) {
    // Incomplete/corrupt metadata and stray directory entries are not identity
    // evidence. Permission/I/O errors still refuse discovery rather than infer
    // that an unreadable candidate has no owner.
    if (err instanceof SyntaxError || ['ENOENT', 'ENOTDIR', 'EISDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw err;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function inventoryFor(home: string): Inventory {
  const cached = inventories.get(home);
  if (cached) return cached;
  const inventory: Inventory = new Map();
  // A migrated alias may later be removed or retargeted. Its immutable binding
  // reserves the old hash for the original physical project; inferring from an
  // old task's path must never lend that store to the alias's new target.
  for (const name of readDirectory(path.join(home, 'project-identities'))) {
    if (!/^[a-f0-9]{12}\.json$/.test(name)) continue;
    const file = path.join(home, 'project-identities', name);
    const binding = parseBinding(file);
    const reservationKey = `${home}\0${binding.storageHash}`;
    const prior = boundStorage.get(reservationKey);
    if (prior && prior.physical !== binding.physicalPath) {
      throw new ProjectIdentityConflictError(`conflicting storage reservations for ${binding.storageHash} at ${file}; preserving all project state`);
    }
    boundStorage.set(reservationKey, { physical: binding.physicalPath, legacy: binding.legacyPath });
    addCandidate(inventory, home, binding.legacyPath, binding.storageHash);
  }
  const indexFile = path.join(home, 'projects.json');
  if (exists(indexFile)) {
    const projects: unknown = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    if (!Array.isArray(projects)) throw new Error(`[projectIdentity] invalid project index at ${indexFile}; preserving existing state`);
    for (const project of projects) if (typeof project === 'string' && project) addCandidate(inventory, home, project);
  }
  for (const hash of readDirectory(path.join(home, 'per-project'), true)) {
    if (!/^[a-f0-9]{12}$/.test(hash)) continue;
    const dir = path.join(home, 'per-project', hash);
    const marker = path.join(dir, '.canonical-path');
    if (exists(marker) && fs.statSync(marker).isFile()) addCandidate(inventory, home, fs.readFileSync(marker, 'utf8').trim(), hash);
    for (const file of ['tasks.json', 'tasks.backup.json', 'workflow-runs.json', 'merge-runs.json']) {
      const original = readMetadataPath(path.join(dir, file), 'projectPath');
      if (original) { addCandidate(inventory, home, original, hash); break; }
    }
  }
  // Snapshots can outlive both the project index and its task database.
  for (const hash of readDirectory(path.join(home, 'snapshots'), true)) {
    if (!/^[a-f0-9]{12}$/.test(hash)) continue;
    const dir = path.join(home, 'snapshots', hash);
    for (const name of readDirectory(dir, true)) {
      const original = readMetadataPath(path.join(dir, name, '_lattice-snapshot.json'), 'repoRoot');
      if (original) { addCandidate(inventory, home, original, hash); break; }
    }
  }
  return remember(inventories, home, inventory);
}

type Binding = { version: 1; physicalPath: string; storageHash: string; legacyPath: string };

function parseBinding(file: string): Binding {
  try {
    const binding = JSON.parse(fs.readFileSync(file, 'utf8')) as Binding | null;
    if (!binding || binding.version !== 1 || typeof binding.physicalPath !== 'string' ||
        !path.isAbsolute(binding.physicalPath) || binding.physicalPath.includes('\0') ||
        typeof binding.legacyPath !== 'string' || !path.isAbsolute(binding.legacyPath) || binding.legacyPath.includes('\0') ||
        typeof binding.storageHash !== 'string' || !/^[a-f0-9]{12}$/.test(binding.storageHash) ||
        hashPath(binding.physicalPath) + '.json' !== path.basename(file) ||
        hashPath(legacyPath(binding.legacyPath)) !== binding.storageHash) throw new Error('invalid identity binding');
    return binding;
  } catch (err) {
    // The unreadable binding may reserve an old alias for another physical
    // checkout. Skipping it could lend that checkout's tasks to a new target.
    throw new ProjectIdentityConflictError(`cannot validate identity binding at ${file}: ${(err as Error).message}; preserving all project state`);
  }
}

function readBinding(file: string, physical: string): Binding | undefined {
  if (!exists(file)) return undefined;
  const binding = parseBinding(file);
  if (binding.physicalPath !== physical) throw new ProjectIdentityConflictError(`identity binding at ${file} belongs to another physical path; preserving all project state`);
  return binding;
}

// Keep the existing storage hash in place. A durable, exclusively published
// binding makes every backend select that same hash after projects.json has
// normalized its spelling. No tasks, snapshots or worktrees are moved/deleted.
export function projectStorageHash(input: string): string {
  const physical = physicalProjectPath(input);
  const home = path.join(os.homedir(), '.lattice');
  const key = `${home}\0${physical}`;
  const cached = storageHashes.get(key);
  if (cached) return cached;
  const inventory = inventoryFor(home);
  addCandidate(inventory, home, input);
  addCandidate(inventory, home, physical);
  // Canonicalizing projects.json may already have normalized a legacy spelling.
  for (const [original, target] of physicalPaths) if (target === physical) addCandidate(inventory, home, original);
  const candidates = new Map(inventory.get(physical));
  const file = path.join(home, 'project-identities', `${hashPath(physical)}.json`);
  const bound = readBinding(file, physical);
  if (bound) candidates.set(bound.storageHash, { hash: bound.storageHash, legacyPath: bound.legacyPath });
  if (candidates.size > 1) {
    throw new ProjectIdentityConflictError(`${physical} has multiple existing project stores (${[...candidates.keys()].join(', ')}) under ${home}. Lattice has preserved every store and refused to choose one; reconcile the duplicate state with all backends stopped.`);
  }
  const selected = candidates.values().next().value ?? { hash: hashPath(physical), legacyPath: physical };
  const reserved = boundStorage.get(`${home}\0${selected.hash}`);
  if (reserved && reserved.physical !== physical) {
    throw new ProjectIdentityConflictError(`${selected.hash} belongs to ${reserved.physical}; open that physical project path to access its preserved state`);
  }
  if (!bound) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const pending = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(pending, JSON.stringify({ version: 1, physicalPath: physical, storageHash: selected.hash, legacyPath: selected.legacyPath } satisfies Binding), { flag: 'wx' });
      try { fs.linkSync(pending, file); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const winner = readBinding(file, physical)!;
        if (winner.storageHash !== selected.hash) throw new Error(`[projectIdentity] concurrent identity choices disagree at ${file}; no project mutation was admitted`);
      }
    } finally {
      try { fs.unlinkSync(pending); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    }
  }
  return remember(storageHashes, key, selected.hash);
}

// Used only when loading a task from the project store selected above. It lets
// records written through a now-removed legacy junction retain their project,
// without treating arbitrary foreign task paths as belonging to this checkout.
export function matchesStoredProjectIdentity(storedPath: string, project: string): boolean {
  return physicalProjectPath(storedPath) === physicalProjectPath(project)
    || hashPath(legacyPath(storedPath)) === projectStorageHash(project);
}

export function storedProjectRoot(storedPath: string, storageHash: string): string {
  const home = path.join(os.homedir(), '.lattice');
  inventoryFor(home);
  const authority = boundStorage.get(`${home}\0${storageHash}`);
  if (authority && (hashPath(legacyPath(storedPath)) === storageHash || physicalProjectPath(storedPath) === authority.physical)) return authority.physical;
  return physicalProjectPath(storedPath);
}

// Test/explicit reconfiguration seam. Do not invalidate while operations own a
// project: stable physical paths are part of their ownership identity.
export function clearProjectIdentityCaches(): void {
  physicalPaths.clear();
  missingThisTurn.clear();
  storageHashes.clear();
  inventories.clear();
  boundStorage.clear();
}
