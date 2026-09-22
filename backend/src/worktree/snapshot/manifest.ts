import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import type { LockBody } from '../../projectRunLock/types.js';
import { atomicWriteFile } from '../../claudeTrust/configFile.js';

export const SNAPSHOTS_BASE = path.join(os.homedir(), '.lattice', 'snapshots');
export const SNAPSHOT_MANIFEST_FILENAME = '_lattice-snapshot.json';

export type SnapshotHandle = {
  // Absolute path to the snapshot directory. Empty string when no files
  // needed snapshotting (clean working tree); callers should treat that
  // case as a no-op.
  dir: string;
  modifiedTracked: string[];
  untracked: string[];
  // Tracked paths that were locally deleted at capture (no copy exists — the
  // content is HEAD's). Capture resurrects them so the FF sees a clean tree;
  // restore deletes them again. Optional: older handles/manifests lack it.
  deleted?: string[];
};

export type SnapshotManifest = {
  version: number;
  repoRoot: string;
  label: string;
  createdAt: number;
  modifiedTracked: string[];
  untracked: string[];
  deleted?: string[];
  owner?: LockBody;
};

export const EMPTY_HANDLE: SnapshotHandle = { dir: '', modifiedTracked: [], untracked: [] };

export function snapshotManifestPath(snapshotDir: string): string {
  return path.join(snapshotDir, SNAPSHOT_MANIFEST_FILENAME);
}

export function isSnapshotMetadataPath(file: string): boolean {
  return path.normalize(file).split(/[\\/]+/)[0].toLowerCase() === SNAPSHOT_MANIFEST_FILENAME;
}

export function isSupportedSnapshotManifest(manifest: unknown): manifest is SnapshotManifest {
  if (!manifest || typeof manifest !== 'object') return false;
  const value = manifest as Partial<SnapshotManifest>;
  return value.version === 1
    && typeof value.repoRoot === 'string' && path.isAbsolute(value.repoRoot)
    && !value.repoRoot.includes('\0')
    && typeof value.label === 'string'
    && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
    && Array.isArray(value.modifiedTracked) && value.modifiedTracked.every((file) => typeof file === 'string')
    && Array.isArray(value.untracked) && value.untracked.every((file) => typeof file === 'string')
    && (value.deleted === undefined
      || (Array.isArray(value.deleted) && value.deleted.every((file) => typeof file === 'string')));
}

export async function readSnapshotManifest(manifestPath: string): Promise<SnapshotManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);
    return isSupportedSnapshotManifest(manifest) ? manifest : null;
  } catch {
    return null;
  }
}

export async function writeSnapshotManifest(
  snapshotDir: string,
  manifest: SnapshotManifest,
): Promise<void> {
  await atomicWriteFile(
    snapshotManifestPath(snapshotDir),
    JSON.stringify(manifest, null, 2),
  );
}
