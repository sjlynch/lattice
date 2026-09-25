import { DisallowedProjectGitError, hasFlag } from '../policy.js';

export function assertAllowedMergeFileArgs(rest: string[]): void {
  // Only the print form (snapshot/threeWay.ts): `merge-file -p` writes the
  // merge result to stdout and nothing to disk. Without it git rewrites its
  // first file argument in place — which could be a file in the checkout.
  if (!hasFlag(rest, '-p', '--stdout')) {
    throw new DisallowedProjectGitError('`git merge-file` without -p (writes into a file) is not allowed');
  }
  // `--object-id` reads blobs and, without -p, writes the result into the
  // object store; Lattice passes plain files only.
  if (hasFlag(rest, '--object-id')) {
    throw new DisallowedProjectGitError('`git merge-file --object-id` is not allowed');
  }
}
