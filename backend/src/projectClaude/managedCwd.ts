import { latticeHomeDir } from '../projectPath.js';

// True when a hook's cwd belongs to a session Lattice already tracks through
// its own machinery (a worktree task agent, or a push/workflow/post-merge
// scratch session). Those must NOT also register here, or they'd get a
// duplicate node.
export function isLatticeManagedCwd(cwd: string): boolean {
  const norm = cwd.replace(/\\/g, '/').toLowerCase();
  if (norm.includes('/.lattice/')) return true;
  const home = latticeHomeDir().replace(/\\/g, '/').toLowerCase();
  return norm.startsWith(home);
}
