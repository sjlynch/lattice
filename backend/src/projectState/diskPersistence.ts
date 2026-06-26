import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../claudeTrust/configFile.js';

export type LoadProjectStateOptions<TState> = {
  name: string;
  key: string;
  file: string;
  defaultState: (projectPath: string) => TState;
  deserialize: (raw: unknown, projectPath: string) => TState | null;
  markUnpreservedCorrupt: (projectPath: string) => void;
};

export async function loadProjectStateFromDisk<TState>({
  name,
  key,
  file,
  defaultState,
  deserialize,
  markUnpreservedCorrupt,
}: LoadProjectStateOptions<TState>): Promise<TState> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    // ENOENT is the normal "new/empty project" case → default state. Any
    // other read error (EACCES/EIO/…) is rare; we can't read the bytes to
    // preserve them, so log and fall back to default rather than break the
    // read path. Crucially, we ONLY reach the default for a genuinely-missing
    // (or unreadable) file — never for a file that exists but won't parse.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[${name}] failed to read ${file}:`, e);
    }
    return defaultState(key);
  }
  try {
    const parsed = deserialize(JSON.parse(raw), key);
    return parsed ?? defaultState(key);
  } catch (parseErr) {
    // The file EXISTS but won't parse — a truncated/corrupt DB, almost always
    // a crash/power-loss landing mid-write. Do NOT silently treat this as an
    // empty board: preserve the bad bytes before allowing later writes.
    await preserveCorruptFile({
      name,
      key,
      file,
      raw,
      err: parseErr,
      markUnpreservedCorrupt,
    });
    return defaultState(key);
  }
}

type PreserveCorruptFileOptions = {
  name: string;
  key: string;
  file: string;
  raw: string;
  err: unknown;
  markUnpreservedCorrupt: (projectPath: string) => void;
};

// Move a corrupt/truncated state file aside to a `.corrupt-<ts>` sidecar so a
// subsequent write can't clobber its still-recoverable bytes. Rename first
// (also clears the bad file so a later load won't re-trip on it); fall back to
// a copy if rename fails (locked / cross-device). If the bytes can't be
// preserved at all, write-protect the key (writeStateNow then refuses to
// overwrite) — preserving the data wins over keeping the board writable.
async function preserveCorruptFile({
  name,
  key,
  file,
  raw,
  err,
  markUnpreservedCorrupt,
}: PreserveCorruptFileOptions): Promise<void> {
  const corruptPath = `${file}.corrupt-${Date.now()}`;
  const detail = err instanceof Error ? err.message : String(err);
  try {
    try {
      await fs.rename(file, corruptPath);
    } catch {
      await fs.writeFile(corruptPath, raw, 'utf8');
    }
    console.error(
      `[${name}] ${file} is corrupt/truncated (${detail}). Preserved the ` +
        `original at ${corruptPath} and loaded an empty state — the data was ` +
        `NOT discarded; recover it from the .corrupt-* file.`,
    );
  } catch (preserveErr) {
    markUnpreservedCorrupt(key);
    console.error(
      `[${name}] ${file} is corrupt and could NOT be preserved; refusing ` +
        `to overwrite it so the recoverable bytes survive. Recover it manually. ` +
        `Preservation error:`,
      preserveErr,
    );
  }
}

export type WriteProjectStateOptions<TState> = {
  name: string;
  key: string;
  file: string;
  state: TState;
  isWriteProtected: (projectPath: string) => boolean;
};

export async function writeProjectStateToDisk<TState>({
  name,
  key,
  file,
  state,
  isWriteProtected,
}: WriteProjectStateOptions<TState>): Promise<void> {
  if (isWriteProtected(key)) {
    // We loaded a corrupt file we couldn't preserve; overwriting it would
    // destroy the only recoverable copy. Surface an error rather than do it.
    throw new Error(
      `[${name}] refusing to overwrite corrupt ${file}: its bytes could ` +
        `not be preserved at load; recover it manually first`,
    );
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Atomic temp→rename (reused from the ~/.claude.json writer): a crash/kill
  // mid-write can no longer truncate the live file — readers see either the
  // old complete file or the new complete file, never a half-written one.
  await atomicWriteFile(file, JSON.stringify(state, null, 2));
}
