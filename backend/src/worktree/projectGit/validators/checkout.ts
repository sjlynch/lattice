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
  // Pathspec magic (`:/`, `:(top)`, `:!x`, …) and `./` reach the whole tree
  // past the literal checks above. The one magic Lattice uses is
  // `:(literal)<path>` (snapshot restore), which disables globbing — allowed
  // only with a real path after it.
  const wholeTree = (p: string) => p === '' || p === '.' || p === '*' || p === '/' || p === './' || p === '.\\';
  if (paths.some((p) => {
    if (wholeTree(p)) return true;
    if (!p.startsWith(':')) return false;
    const literal = /^:\(literal\)(.+)$/.exec(p);
    return !literal || wholeTree(literal[1]);
  })) {
    throw new DisallowedProjectGitError('checkout with a pathspec-magic path is not allowed');
  }
}
