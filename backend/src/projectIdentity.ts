import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  boundStorage, hashPath, inventories, legacyPath, physicalPaths, remember, reservationKey, storageHashes,
} from './projectIdentity/caches.js';
import { addCandidate, inventoryFor } from './projectIdentity/inventory.js';
import { bindingFile, publishBinding, readBinding } from './projectIdentity/binding.js';
import { ProjectIdentityConflictError } from './projectIdentity/errors.js';

export { ProjectIdentityConflictError };

// Not latticeHomeDir(): projectPath.ts imports this module, so that would be circular.
function identityHome(): string {
  return path.join(os.homedir(), '.lattice');
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

// Keep the existing storage hash in place. A durable, exclusively published
// binding makes every backend select that same hash after projects.json has
// normalized its spelling. No tasks, snapshots or worktrees are moved/deleted.
export function projectStorageHash(input: string): string {
  const physical = physicalProjectPath(input);
  const home = identityHome();
  const key = `${home}\0${physical}`;
  const cached = storageHashes.get(key);
  if (cached) return cached;
  const inventory = inventoryFor(home, physicalProjectPath);
  addCandidate(inventory, home, input, physicalProjectPath);
  addCandidate(inventory, home, physical, physicalProjectPath);
  // Canonicalizing projects.json may already have normalized a legacy spelling.
  for (const [original, target] of physicalPaths) {
    if (target === physical) addCandidate(inventory, home, original, physicalProjectPath);
  }
  const candidates = new Map(inventory.get(physical));
  const file = bindingFile(home, physical);
  const bound = readBinding(file, physical);
  if (bound) candidates.set(bound.storageHash, { hash: bound.storageHash, legacyPath: bound.legacyPath });
  if (candidates.size > 1) {
    const hashes = [...candidates.keys()].join(', ');
    throw new ProjectIdentityConflictError(
      `${physical} has multiple existing project stores (${hashes}) under ${home}. `
      + 'Lattice has preserved every store and refused to choose one; reconcile the duplicate state with all backends stopped.',
    );
  }
  const selected = candidates.values().next().value ?? { hash: hashPath(physical), legacyPath: physical };
  const reserved = boundStorage.get(reservationKey(home, selected.hash));
  if (reserved && reserved.physical !== physical) {
    throw new ProjectIdentityConflictError(`${selected.hash} belongs to ${reserved.physical}; open that physical project path to access its preserved state`);
  }
  if (!bound) publishBinding(file, physical, selected);
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
  const home = identityHome();
  inventoryFor(home, physicalProjectPath);
  const authority = boundStorage.get(reservationKey(home, storageHash));
  if (!authority) return physicalProjectPath(storedPath);
  const sameStore = hashPath(legacyPath(storedPath)) === storageHash;
  if (sameStore || physicalProjectPath(storedPath) === authority.physical) return authority.physical;
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
