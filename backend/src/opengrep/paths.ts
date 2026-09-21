// Where Lattice keeps everything Opengrep-related. All of it is home-scoped
// (`~/.lattice/opengrep/` for the shared engine + rule packs,
// `~/.lattice/per-project/<hash>/opengrep/` for a project's scan results) and
// NEVER inside a project tree — the same rule as worktrees, snapshots and
// push-run scratch (see the root CLAUDE.md `.git`-deletion defences). The only
// per-project path that lives in the repo is the OPTIONAL user-authored rules
// directory, which Lattice only ever READS.

import path from 'node:path';
import { homeProjectScratchDir, latticeHomeDir } from '../projectPath.js';

export function opengrepHomeDir(): string {
  return path.join(latticeHomeDir(), 'opengrep');
}

// `~/.lattice/opengrep/bin/<version>/opengrep(.exe)` — one directory per
// version so a future bump installs beside the old one and the swap is a
// pointer change in state.json, never an in-place overwrite of a running exe.
export function managedBinaryDir(version: string): string {
  return path.join(opengrepHomeDir(), 'bin', version);
}

export function managedBinaryPath(version: string, platform = process.platform): string {
  return path.join(managedBinaryDir(version), platform === 'win32' ? 'opengrep.exe' : 'opengrep');
}

// Partial downloads land here, outside `bin/`, so a killed transfer can never
// look like an installed engine.
export function downloadsDir(): string {
  return path.join(opengrepHomeDir(), 'downloads');
}

// The rules root is ALSO the cwd every scan runs from, with each pack passed
// as the relative `-f <packId>`. Opengrep derives a finding's `check_id` from
// the config path relative to its cwd (`qodana-mit.javascript.xss.…`), and the
// finding FINGERPRINT hashes the check_id — so running from here is what keeps
// ids and fingerprints identical across machines and home directories.
export function rulesRootDir(): string {
  return path.join(opengrepHomeDir(), 'rules');
}

export function rulePackDir(packId: string): string {
  return path.join(rulesRootDir(), packId);
}

export function stateFilePath(): string {
  return path.join(opengrepHomeDir(), 'state.json');
}

// `~/.lattice/per-project/<hash>/opengrep/` — raw scan JSON + per-scan
// metadata, keyed by scan id. Kept to the last N (see scan.ts).
export function projectScansDir(projectPath: string): string {
  return homeProjectScratchDir(projectPath, 'opengrep');
}

// The optional project-authored rules directory, always loaded when present.
// Read-only from Lattice's side.
export const PROJECT_RULES_RELATIVE_DIR = path.join('.opengrep', 'rules');

export function projectRulesDir(projectPath: string): string {
  return path.join(projectPath, PROJECT_RULES_RELATIVE_DIR);
}
