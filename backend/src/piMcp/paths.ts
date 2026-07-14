// Install directory + package-entry resolution for the shared Lattice-owned
// `pi-mcp-adapter` install. Same "private local install, never the user's
// global Pi config" rule as `piSubagents/` — see that CLAUDE.md.
//
// A SEPARATE install dir from pi-subagents on purpose: running `pi install … -l`
// twice into one dir would have the second npm install prune the first
// package's extraneous deps. One dir per extension keeps each install isolated.
//
// `pi-mcp-adapter` (the official-Pi adapter) supersedes the earlier
// `pi-mcp-extension` fallback: it targets `@earendil-works/pi-*` (official Pi
// ≥0.74), interpolates `${VAR}` in config (→ HTTP-header secrets), and exposes
// `directTools`. A fresh install dir means a lingering `pi-mcp-ext/` from the
// old path is simply orphaned, not migrated in place.

import path from 'node:path';
import { latticeHomeDir } from '../projectPath.js';

// Reuse the generic package-entry resolver (prefers package.json
// `pi.extensions[0]`, falls back to dist/src). It takes a pkgDir, so it is not
// pi-subagents-specific.
export { resolveEntry } from '../piSubagents/paths.js';

export const PI_MCP_SPEC = 'npm:pi-mcp-adapter';

// Shared, Lattice-owned install root — home-scoped, outside any project tree.
// `pi install -l` here writes `<dir>/.pi/settings.json` + `<dir>/.pi/npm/…`.
export function installDir(): string {
  return path.join(latticeHomeDir(), 'pi-mcp-adapter');
}

export function packageDir(): string {
  return path.join(
    installDir(),
    '.pi',
    'npm',
    'node_modules',
    'pi-mcp-adapter',
  );
}
