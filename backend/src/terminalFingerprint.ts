// Replaces the hand-maintained TERMINAL_API_VERSION constant with a hash
// of the terminal-server's actual on-disk bytes. Eliminates the class of
// bug where a code change is shipped without bumping the version number,
// leaving a stale orphan that advertises a current API version while
// missing the routes/behavior that version was supposed to add.
//
// Both terminalProxy (main backend) and terminal-server (detached child)
// import this helper, so they compute the EXPECTED fingerprint from the
// same files using the same code path. Computed once at module load and
// frozen for the process lifetime — re-reading dynamically would defeat
// the staleness check (an old orphan would re-hash the new bytes and
// falsely claim it's current).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Files whose bytes affect terminal-server runtime behavior. Add to this
// list whenever a new file becomes part of the terminal-server's import
// graph. Files are hashed in declaration order so the resulting digest
// is reproducible.
const FINGERPRINT_FILES = [
  'terminal-server.js',
  'terminalServer/processGuards.js',
  'terminalServer/routes.js',
  'terminalServer/shutdown.js',
  'terminalServer/websocket.js',
  'terminal.js',
  'terminal/sessionTypes.js',
  'terminal/sessionStore.js',
  'terminal/scrollbackStore.js',
  'terminal/createSession.js',
  'terminal/launchContext.js',
  'terminal/windowsPath.js',
  'terminal/envSetup.js',
  'terminal/broadcast.js',
  'terminal/sessionLifecycle.js',
  'terminal/attach.js',
  'terminal/kill.js',
  'processTree.js',
  'latticeApiDocs.js',
  'latticeApiDocs/LATTICE_API.template.md',
  'claudeConfigGuard.js',
  // The Claude-config WRITE mechanism the terminal-server runs at every spawn
  // (apply trust + reconcile the backend-resolved MCP set into ~/.claude.json).
  // Stable by design — the MCP/trust/memory POLICY lives in the main backend and
  // is NOT fingerprinted, so a policy change is a backend-only edit that never
  // respawns the terminal-server (the whole point of keeping these thin). These
  // two ARE fingerprinted so a change to the write mechanism itself still takes
  // effect instead of running stale in a long-lived orphan.
  'claudeTrust.js',
  'mcp/claudeInject.js',
];

export function computeTerminalFingerprint(): string {
  const hash = crypto.createHash('sha256');
  for (const name of FINGERPRINT_FILES) {
    const full = path.join(__dirname, name);
    try {
      hash.update(name);
      hash.update('\0');
      hash.update(fs.readFileSync(full));
      hash.update('\0');
    } catch {
      // Missing file → stable sentinel. Both sides compute MISSING
      // identically if neither has the file (e.g. before a build), so
      // mismatches still only fire when bytes genuinely differ.
      hash.update(`MISSING:${name}\0`);
    }
  }
  return hash.digest('hex').slice(0, 16);
}
