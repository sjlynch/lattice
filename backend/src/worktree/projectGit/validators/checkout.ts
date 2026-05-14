import { dashDashIndex, DisallowedProjectGitError } from '../policy.js';

export function assertAllowedCheckoutArgs(rest: string[]): void {
  // Permit only the path-restoring form: `checkout <ref|--ours|--theirs> -- <paths…>`
  // with at least one explicit path that isn't `.`/`*`. Forbid branch
  // switching (`checkout <branch>`), which rewrites the whole tree, and
  // `checkout -- .` (mass discard).
  const dd = dashDashIndex(rest);
  if (dd < 0) {
    throw new DisallowedProjectGitError('checkout without `--` (branch switch) is not allowed');
  }
  const paths = rest.slice(dd + 1);
  if (paths.length === 0) {
    throw new DisallowedProjectGitError('checkout with `--` but no paths is not allowed');
  }
  if (paths.some((p) => p === '.' || p === '*' || p === '' || p === '/')) {
    throw new DisallowedProjectGitError('checkout with a wildcard/dot path is not allowed');
  }
}
