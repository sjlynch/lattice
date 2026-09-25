import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { projectGit } from '../projectGit.js';

// Reconciling a captured path with a commit that landed after capture — the
// fast-forward that the snapshot existed to make room for.
//
// A snapshot copy is the user's edit ON TOP OF the commit HEAD was at capture
// (`baseCommit`). When the fast-forward then rewrote that same file, the
// on-disk file is the task's version and the copy lacks the task's hunk:
// overlaying it silently reverted the merged change in the working tree
// (reported as "restored", and committed by the next `git add -A` push). This
// is the three-way merge `git stash pop` used to do before snapshots became
// copy-based. Base = the file at `baseCommit`, ours = the captured copy,
// theirs = the current file.

// Larger files are not merged in memory; they come back as a conflict copy.
export const MAX_THREE_WAY_MERGE_BYTES = 8 * 1024 * 1024;

export type CommittedChangeReconcile =
  // HEAD's version of the path equals the capture base: nothing landed on it,
  // so the captured copy is simply the user's work and overlays it.
  | { kind: 'overlay' }
  // Both the user's edit and the landed change, combined without overlap.
  | { kind: 'merged'; content: string }
  // Overlapping edits, or content that can't be merged as text.
  | { kind: 'conflict'; reason: string };

// Object id of `file` in `rev`, or null when the path isn't there.
async function objectAt(repoRoot: string, rev: string, file: string): Promise<string | null> {
  const r = await projectGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}:${file}`]);
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  if (r.code === 1) return null; // --quiet: a missing path exits 1 with no output
  throw new Error(`git rev-parse ${rev}:${file} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
}

// A path the capture base had that HEAD no longer has: a commit (normally the
// fast-forward) deleted a file the user had modified.
export async function deletedSinceCapture(repoRoot: string, baseCommit: string, file: string): Promise<boolean> {
  const [base, head] = await Promise.all([
    objectAt(repoRoot, baseCommit, file),
    objectAt(repoRoot, 'HEAD', file),
  ]);
  return base !== null && head === null;
}

// `projectGit` decodes output as UTF-8, and a merge of undecodable bytes would
// be written back altered — so only strict UTF-8 text without NULs is merged.
async function readMergeableText(file: string): Promise<string | null> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > MAX_THREE_WAY_MERGE_BYTES) return null;
  const bytes = await fs.readFile(file);
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// Decoded stdout can't be checked for invalid bytes directly; a replacement
// character stands in for one (a genuine U+FFFD just means a conflict copy).
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

function isMergeableDecodedText(text: string): boolean {
  return !text.includes('\0') && !text.includes(REPLACEMENT_CHARACTER) && text.length <= MAX_THREE_WAY_MERGE_BYTES;
}

// `dst` is the current working-tree file, already verified to be HEAD's
// clean committed content; `src` is the snapshot's captured copy.
export async function reconcileWithCommittedChange(
  repoRoot: string,
  baseCommit: string,
  file: string,
  src: string,
  dst: string,
): Promise<CommittedChangeReconcile> {
  const [baseObject, headObject] = await Promise.all([
    objectAt(repoRoot, baseCommit, file),
    objectAt(repoRoot, 'HEAD', file),
  ]);
  if (baseObject === headObject) return { kind: 'overlay' };

  const [ours, theirs] = await Promise.all([readMergeableText(src), readMergeableText(dst)]);
  if (ours === null || theirs === null) {
    return { kind: 'conflict', reason: 'changed by the merge and not mergeable as text' };
  }
  let base = '';
  if (baseObject !== null) {
    // --filters: the working-tree form (line endings, smudge), matching how
    // the captured copy and the current file are stored on disk.
    const shown = await projectGit(repoRoot, ['cat-file', '--filters', `${baseCommit}:${file}`]);
    if (shown.code !== 0 || !isMergeableDecodedText(shown.stdout)) {
      return { kind: 'conflict', reason: 'changed by the merge; its pre-merge version could not be read as text' };
    }
    base = shown.stdout;
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-snapshot-merge-'));
  const baseFile = path.join(tmp, 'base');
  const oursFile = path.join(tmp, 'ours');
  const theirsFile = path.join(tmp, 'theirs');
  try {
    // Merge the exact bytes that were checked, not whatever is on disk by the
    // time git reads it.
    await Promise.all([
      fs.writeFile(baseFile, base, 'utf8'),
      fs.writeFile(oursFile, ours, 'utf8'),
      fs.writeFile(theirsFile, theirs, 'utf8'),
    ]);
    const merged = await projectGit(repoRoot, [
      'merge-file', '-p',
      '-L', 'your uncommitted edits', '-L', 'before the merge', '-L', 'merged',
      oursFile, baseFile, theirsFile,
    ]);
    // Exit status = number of conflicting hunks; negative (255) on error.
    if (merged.code === 0) return { kind: 'merged', content: merged.stdout };
    if (merged.code > 0 && merged.code < 128) {
      return { kind: 'conflict', reason: `your edits overlap the merged change (${merged.code} hunk(s))` };
    }
    return { kind: 'conflict', reason: `git merge-file failed: ${merged.stderr.trim() || `exit ${merged.code}`}` };
  } finally {
    // Only the three files written above — no recursive delete.
    await Promise.all([baseFile, oursFile, theirsFile].map((f) => fs.rm(f, { force: true }).catch(() => undefined)));
    await fs.rmdir(tmp).catch(() => undefined);
  }
}
