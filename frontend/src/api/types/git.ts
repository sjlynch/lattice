// Git-setup types: the probe behind the navbar chip and the preview/init pair
// behind the "Set up Git" dialog. Mirrors the backend's shapes for
// `GET /api/git-check`, `POST /api/project-init/preview` and
// `POST /api/project-init`.

export type ProjectGitState =
  // `<project>/.git` exists (dir OR file) → a normal Lattice project.
  | 'repo'
  // No repo here, but one exists ABOVE. NEVER initable: a repo inside a repo
  // shows up in the parent as a gitlink, the worst outcome this feature has.
  | 'nested'
  | 'bare'
  // No repo at or above → the only initializable state.
  | 'none'
  // The `git` CLI is not on PATH.
  | 'unavailable'
  // The probe itself failed (permission, timeout); see `reason`.
  | 'error';

export type ProjectGitProbe = {
  state: ProjectGitState;
  /** Repo root git reports. For `nested` this is the ANCESTOR repo. */
  toplevel?: string;
  /**
   * True when the init flow may (still) run here: `none` with every backend
   * path guard passing, OR a `repo` whose HEAD is unborn (see `unborn`).
   */
  initable: boolean;
  /**
   * `repo` only: the repository has no commits yet (its first commit never
   * landed — typically a missing git identity). Lattice cannot run tasks in
   * worktrees from an unborn HEAD, so the chip offers to finish the setup.
   */
  unborn?: boolean;
  /** Why `initable` is false, or what went wrong for `error`. Human-readable. */
  reason?: string;
};

export type ProjectInitLargestEntry = {
  /** Repo-relative path. */
  path: string;
  bytes: number;
};

export type ProjectInitPreview = {
  probe: ProjectGitProbe;
  /** No committable files at all → the zero-risk "new project" path. */
  isEmpty: boolean;
  /** Echo of the posted `.gitignore`, else the generated default. */
  gitignore: string;
  /** True when Lattice generated it (the project has no `.gitignore`). */
  generated: boolean;
  /** Files that WOULD be committed under `gitignore`. */
  fileCount: number;
  byteCount: number;
  /** The walk hit its cap — the counts are a lower bound. */
  truncated: boolean;
  /** Up to 5, repo-relative, descending by size. */
  largest: ProjectInitLargestEntry[];
};

export type ProjectInitResult = {
  ok: true;
  toplevel: string;
  branch: string;
  commit: string | null;
  filesCommitted: number;
};
