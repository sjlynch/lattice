// Tool-call guards for Lattice-spawned (unattended) Pi sessions.
//
// Pi's bash tool has no default timeout, and small models reach for a
// whole-filesystem `find / -name X` when a file isn't where they expect: an
// experiment run sat for 80 minutes on one (several more were orphaned
// beside it). The generated `<dir>/.pi/extensions/lattice-guard.ts`:
//   - blocks filesystem-root / home-wide scans (find, ls -R, du) with a reason
//     that names the scoped alternative, and
//   - gives every bash call without a timeout a generous one.
// Never installed for the user's own project-root Pi.

import path from 'node:path';
import fs from 'node:fs/promises';
import { atomicWriteFile } from './fsAtomic.js';

export const PI_GUARD_EXTENSION_FILE = 'lattice-guard.ts';

// A scan rooted at `/`, a drive root (`C:\`, `/c`), or the home dir.
export const PI_WHOLE_FS_SCAN_PATTERN =
  /(?:^|[;&|(]\s*|\s)(?:find|du(?:\s+-\w+)*|ls\s+-\w*R\w*)\s+(?:\/|~\/?|\/[a-z]\/?|[a-z]:[\\/]?)(?=\s|$|;|\||&|\))/i;
export const PI_DEFAULT_BASH_TIMEOUT_SECONDS = 1200;
export const PI_WHOLE_FS_SCAN_REASON =
  'Blocked by Lattice: this scans the whole filesystem and can run for hours. Search inside the project instead (e.g. `find . -name <name>`, `git ls-files | grep <name>`); your working directory is the project or task directory.';

export function renderPiGuardExtension(): string {
  return `// Lattice-managed — do not commit. Guards for this unattended session: blocks
// whole-filesystem scans and gives untimed bash calls a ${PI_DEFAULT_BASH_TIMEOUT_SECONDS} s timeout.

const WHOLE_FS_SCAN = ${PI_WHOLE_FS_SCAN_PATTERN.toString()};
const DEFAULT_TIMEOUT_SECONDS = ${PI_DEFAULT_BASH_TIMEOUT_SECONDS};
const REASON = ${JSON.stringify(PI_WHOLE_FS_SCAN_REASON)};

export default function (pi) {
  pi.on("tool_call", (event) => {
    if (!event || event.toolName !== "bash" || !event.input) return;
    const command = String(event.input.command || "");
    if (WHOLE_FS_SCAN.test(command)) return { block: true, reason: REASON };
    if (event.input.timeout === undefined) event.input.timeout = DEFAULT_TIMEOUT_SECONDS;
  });
}
`;
}

// Write (or refresh) `<dir>/.pi/extensions/lattice-guard.ts`; skips an
// identical file. Best-effort: never fails a spawn.
export async function installPiGuardExtension(dir: string): Promise<void> {
  const file = path.join(dir, '.pi', 'extensions', PI_GUARD_EXTENSION_FILE);
  const expected = renderPiGuardExtension();
  try {
    try {
      if ((await fs.readFile(file, 'utf8')) === expected) return;
    } catch {
      /* absent — write it */
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, expected);
  } catch (err) {
    console.warn(`[pi-guard] could not install ${file}:`, err);
  }
}
