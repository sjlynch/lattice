// Wire shapes for "turn this folder into a git repo". The frontend declares
// the same types against the same contract, so a field rename here is a
// breaking change on the wire — not a local refactor.

export type ProjectGitState =
  /** `<project>/.git` exists (dir OR file) → a normal Lattice project. */
  | 'repo'
  /** No `.git` here, but a repo exists ABOVE. NEVER initable. */
  | 'nested'
  /** `rev-parse --is-bare-repository` → true. */
  | 'bare'
  /** No repo at or above → the only initializable state. */
  | 'none'
  /** The `git` CLI is not on PATH. */
  | 'unavailable'
  /** The probe itself failed (permission, timeout, dubious ownership). */
  | 'error';

export type ProjectGitProbe = {
  state: ProjectGitState;
  /** Repo root git reports. For 'nested' this is the ANCESTOR repo. */
  toplevel?: string;
  /** True only when state === 'none' AND every path guard passes. */
  initable: boolean;
  /** Why `initable` is false, or what went wrong for 'error'. Human-readable. */
  reason?: string;
};

export type ProjectInitPreview = {
  probe: ProjectGitProbe;
  /** No committable files at all → the zero-risk "new project" path. */
  isEmpty: boolean;
  /** Echo of the caller's text, else the project's own / a generated default. */
  gitignore: string;
  /** True when Lattice generated the text (the project has no `.gitignore`). */
  generated: boolean;
  /** Files that WOULD be committed under `gitignore`. */
  fileCount: number;
  byteCount: number;
  /** The walk hit its cap; the counts are a lower bound. */
  truncated: boolean;
  /** Up to 5, repo-relative, descending by size. */
  largest: Array<{ path: string; bytes: number }>;
};

export type ProjectInitResult = {
  toplevel: string;
  branch: string;
  commit: string | null;
  filesCommitted: number;
};

export type ProjectInitErrorCode =
  | 'not-initable'
  | 'git-identity-missing'
  | 'git-failed'
  | 'git-unavailable';

// Typed failure so the route can map a cause to its documented status code
// (409 / 422 / 500 / 503) without string-matching messages. `detail` carries
// git's RAW stderr — the frontend renders it verbatim, which is how the
// identity fix reaches the user without any Lattice source naming the config
// keys involved (see `init.ts`).
export class ProjectInitError extends Error {
  readonly code: ProjectInitErrorCode;
  readonly detail?: string;

  constructor(code: ProjectInitErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'ProjectInitError';
    this.code = code;
    this.detail = detail;
  }
}
