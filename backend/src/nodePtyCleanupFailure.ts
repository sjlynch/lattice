/** The one Windows node-pty cleanup defect that is safe to ignore. */
export function isNodePtyCleanupFailure(reason: unknown): boolean {
  if (!(reason instanceof TypeError)) return false;
  if (reason.message !== "Cannot read properties of undefined (reading 'forEach')") return false;
  // Require an actual stack frame in the cleanup module. A message containing
  // `node-pty`, or a different failure elsewhere in that dependency, is fatal.
  return /^\s+at .*[/\\]node-pty[/\\]lib[/\\]windowsPtyAgent\.js:\d+:\d+\)?$/m.test(reason.stack ?? '');
}
