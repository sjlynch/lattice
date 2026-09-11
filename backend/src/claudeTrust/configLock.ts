// One mutex at the historical ~/.claude.json.lattice-lock path. New writers
// claim a FILE with open(wx): legacy mkdir callers collide with it, and their
// timeout-based nonrecursive rmdir cannot steal it. Existing legacy directories
// are still authoritative and are never removed without owner evidence.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { sleep } from './util.js';

const LOCK_PATH = path.join(os.homedir(), '.claude.json.lattice-lock');
const LOCK_RETRY_DELAYS_MS = [10, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000];
const RECOVERY_RETRY_DELAYS_MS = [10, 25, 50, 75, 100, 150, 200, 300];
const OPERATION_RETRY_DELAYS_MS = [10, 25, 50, 100, 200];

type Owner = { version: 1; pid: number; hostname: string; acquiredAt: number; ownerId: string };
type Observation = { kind: 'owned'; raw: string; owner: Owner } | { kind: 'absent' } | { kind: 'unknown'; reason: string };
type FinishedOwner = { raw: string; pending?: Promise<void> };
// A live process can retry cleanup only when it knows this callback FINISHED.
// Shared promises serialize those retries; there is no timer or unlocked write.
const finishedOwners = new Map<string, FinishedOwner>();

function lockKey(lockPath: string): string {
  const resolved = path.resolve(lockPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export interface ConfigLockOptions {
  // Historical option name retained; this path can now hold a file or a legacy
  // directory. Tests must use an isolated temporary parent directory.
  lockDir?: string;
  retryDelays?: readonly number[];
  stealRetryDelays?: readonly number[];
  operationRetryDelays?: readonly number[];
  isPidAlive?: (pid: number) => boolean;
}

function transient(error: unknown): boolean {
  return ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException | undefined)?.code ?? '');
}

async function retryTransient<T>(operation: () => Promise<T>, delays: readonly number[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!transient(error) || attempt >= delays.length) throw error;
      await sleep(delays[attempt]);
    }
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function parseOwner(raw: string): Owner | null {
  let value: Partial<Owner> | null;
  try { value = JSON.parse(raw) as Partial<Owner> | null; } catch { return null; }
  if (
    !value || value.version !== 1 || !Number.isInteger(value.pid) || value.pid! <= 0 ||
    typeof value.hostname !== 'string' || !value.hostname ||
    typeof value.acquiredAt !== 'number' || !Number.isFinite(value.acquiredAt) || value.acquiredAt <= 0 ||
    typeof value.ownerId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.ownerId)
  ) return null;
  return value as Owner;
}

async function inspect(lockPath: string): Promise<Observation> {
  try {
    const before = await fs.lstat(lockPath);
    if (!before.isFile() || before.isSymbolicLink()) {
      return { kind: 'unknown', reason: before.isDirectory() ? 'legacy directory has no verifiable owner' : 'lock path is not a regular file' };
    }
    if (before.size > 4096) return { kind: 'unknown', reason: 'owner record exceeds its expected size' };
    const raw = await fs.readFile(lockPath, 'utf8');
    const after = await fs.lstat(lockPath);
    if (!after.isFile() || after.isSymbolicLink() || before.ino !== after.ino || before.dev !== after.dev) {
      return { kind: 'unknown', reason: 'lock changed during inspection' };
    }
    const owner = parseOwner(raw);
    return owner ? { kind: 'owned', raw, owner } : { kind: 'unknown', reason: 'owner record is incomplete or unrecognized' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw error; // Permission errors never mean abandoned.
  }
}

async function initializeOwner(handle: Awaited<ReturnType<typeof fs.open>>, delays: readonly number[]): Promise<string> {
  const raw = JSON.stringify({
    version: 1, pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now(), ownerId: randomUUID(),
  } satisfies Owner);
  try {
    const bytes = Buffer.from(raw);
    await retryTransient(async () => {
      // Explicit positions make a retry safe even after a partial write. A
      // partial record is unknown to contenders, so none may retire it.
      await handle.truncate(0);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.write(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesWritten) throw new Error('Claude config lock owner write made no progress');
        offset += result.bytesWritten;
      }
    }, delays);
  } finally {
    await handle.close();
  }
  // Initialization failure deliberately leaves its unknown file intact;
  // removing an unrecognized owner would turn write failure into lost exclusion.
  return raw;
}

async function retire(lockPath: string, observed: { raw: string }, delays: readonly number[]): Promise<boolean> {
  const retirementDir = `${lockPath}.retired`;
  await retryTransient(async () => {
    try { await fs.mkdir(retirementDir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(retirementDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Claude config retirement path is not a real directory: ${retirementDir}`);
  }, delays);
  // One permanent, exclusive claim serializes stale retirement of this exact
  // generation. A delayed stale observer cannot unlink its successor.
  // Never prune claims while another process can retain an old observation.
  const claim = path.join(retirementDir, createHash('sha256').update(observed.raw).digest('hex'));
  try {
    // The exclusive filename IS the claim; it needs no contents. Separating
    // acquisition from close avoids disguising post-create write failure as
    // EEXIST on a retry against our own partially-written claim.
    const handle = await retryTransient(() => fs.open(claim, 'wx'), delays);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  const current = await retryTransient(() => inspect(lockPath), delays);
  if (current.kind === 'absent') return true;
  if (current.kind !== 'owned' || current.raw !== observed.raw) return false;
  // Other new removers cannot win this generation's claim, and legacy rmdir
  // cannot remove a file. Replacement requires THIS unlink to happen first.
  await retryTransient(() => fs.unlink(lockPath), delays);
  return true;
}

async function holding<T>(lockPath: string, raw: string, fn: () => Promise<T>, delays: readonly number[]): Promise<T> {
  let callbackFailed = false;
  try { return await fn(); }
  catch (error) { callbackFailed = true; throw error; }
  finally {
    try {
      const key = lockKey(lockPath);
      const finished = { raw };
      finishedOwners.set(key, finished);
      await releaseFinishedOwner(lockPath, finished, delays);
    } catch (error) {
      // Preserve an earlier config-read/write error, while surfacing a second
      // release failure rather than silently stranding a lock.
      if (callbackFailed) console.warn('[claudeTrust] config lock release also failed:', error);
      else throw error;
    }
  }
}

function releaseFinishedOwner(lockPath: string, finished: FinishedOwner, delays: readonly number[]): Promise<void> {
  if (finished.pending) return finished.pending;
  const key = lockKey(lockPath);
  const cleanup = (async () => {
    let retainForRetry = true;
    try {
      const current = await retryTransient(() => inspect(lockPath), delays);
      if (current.kind === 'absent') { retainForRetry = false; return; }
      if (current.kind !== 'owned' || current.raw !== finished.raw) {
        retainForRetry = false;
        throw new Error(`Claude config lock release refused: ownership changed at ${lockPath}`);
      }
      // This process is alive, so a new stale reclaimer cannot own removal;
      // legacy rmdir cannot unlink a file either. Ordinary release needs no
      // tombstone. Concurrent local retries all await this same cleanup.
      await retryTransient(() => fs.unlink(lockPath), delays);
      retainForRetry = false;
    } finally {
      finished.pending = undefined;
      if (!retainForRetry && finishedOwners.get(key) === finished) finishedOwners.delete(key);
    }
  })();
  finished.pending = cleanup;
  return cleanup;
}

export async function withClaudeConfigLock<T>(fn: () => Promise<T>, opts: ConfigLockOptions = {}): Promise<T> {
  const lockPath = opts.lockDir ?? LOCK_PATH;
  const operationDelays = opts.operationRetryDelays ?? OPERATION_RETRY_DELAYS_MS;
  let lastAcquisitionError: unknown;
  const acquire = async (delays: readonly number[]): Promise<string | null> => {
    for (const delay of [0, ...delays]) {
      if (delay) await sleep(delay);
      // A contender may start before the current callback finishes. Recheck
      // each retry so a later failed release can be repaired by that waiter.
      const finished = finishedOwners.get(lockKey(lockPath));
      if (finished) await releaseFinishedOwner(lockPath, finished, operationDelays);
      let handle: Awaited<ReturnType<typeof fs.open>>;
      try { handle = await fs.open(lockPath, 'wx'); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && !transient(error)) throw error;
        lastAcquisitionError = error;
        continue;
      }
      // Initialization has its own bounded write retry. If it fails, preserve
      // that original error and partial owner file; retrying acquisition here
      // would merely collide with our own file and obscure EPERM as EEXIST.
      return initializeOwner(handle, operationDelays);
    }
    return null;
  };

  let raw = await acquire(opts.retryDelays ?? LOCK_RETRY_DELAYS_MS);
  if (raw !== null) return holding(lockPath, raw, fn, operationDelays);

  let reason = 'another writer still holds it';
  const observed = await retryTransient(() => inspect(lockPath), operationDelays);
  if (observed.kind === 'unknown') reason = observed.reason;
  else if (observed.kind === 'owned') {
    if (observed.owner.hostname.toLowerCase() !== os.hostname().toLowerCase()) reason = 'owner belongs to another host';
    else if ((opts.isPidAlive ?? pidAlive)(observed.owner.pid)) reason = `owner PID ${observed.owner.pid} is live or cannot be verified dead`;
    else if (!await retire(lockPath, observed, operationDelays)) reason = 'dead owner retirement is already claimed or ownership changed';
  }

  raw = await acquire(opts.stealRetryDelays ?? RECOVERY_RETRY_DELAYS_MS);
  if (raw !== null) return holding(lockPath, raw, fn, operationDelays);
  // Preserve the Windows operation/code/path on persistent denial; do not
  // mislabel a permission failure as ordinary lock contention.
  if (transient(lastAcquisitionError)) throw lastAcquisitionError;
  throw new Error(`withClaudeConfigLock: could not acquire ${lockPath}; ${reason}. The lock was preserved.`);
}
