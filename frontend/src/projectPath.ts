// Canonicalize a project path so the same physical project always produces
// the same string. Mirrors backend/src/projectPath.ts: on Windows, paths are
// case-insensitive but case-preserving — `f:\rust_etl` and `F:\rust_etl` are
// the same project but compare unequal. The backend now stamps task
// records with the uppercase-drive form; the frontend matches activeFolder
// to that same form so per-project filters (Sidebar terminal list, tasks
// WS subscription, settings keys) all line up.
//
// Browser environment: no `path` module, so we work on the raw string.
//   - Forward slashes get folded to backslashes (Windows-style) before
//     uppercasing the drive, since user input via folder picker can be
//     either separator. This isn't a full path.resolve — we trust the
//     backend's listDir to have already resolved relative segments.
//   - On non-Windows-shaped paths (no drive letter), return as-is.

export function canonicalProjectPath(input: string): string {
  if (!input) return input;
  // Detect Windows drive letter at the start. Accept both `c:` and `c:\`
  // since persisted values from older sessions may not include the
  // separator.
  const m = /^([a-zA-Z]):(.*)$/.exec(input);
  if (m) {
    return m[1].toUpperCase() + ':' + m[2];
  }
  return input;
}
