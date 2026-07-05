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
// is reproducible. A structural regression test
// (`__tests__/terminalFingerprint.test.ts`) walks terminal-server.js's
// static import graph and fails if any reachable runtime module is missing
// here, so an omission can't silently let a stale orphan keep serving old
// behavior.
export const FINGERPRINT_FILES = [
  'terminal-server.js',
  'terminalServer/processGuards.js',
  'terminalServer/createSessionHandler.js',
  'terminalServer/routes.js',
  'terminalServer/shutdown.js',
  'terminalServer/websocket.js',
  'terminalServer/parentWatch.js',
  // The shared CSWSH origin allowlist the websocket upgrade handler enforces.
  // A change to which Origins are accepted must invalidate a stale orphan.
  'wsOriginAllowlist.js',
  'terminalServerAuth.js',
  'terminal.js',
  'terminal/sessionTypes.js',
  'terminal/sessionStore.js',
  'terminal/scrollbackStore.js',
  'terminal/scrollbackLogFile.js',
  'terminal/scrollbackCleanup.js',
  'terminal/createSession.js',
  'terminal/launchContext.js',
  'terminal/windowsPath.js',
  'terminal/envSetup.js',
  'terminal/broadcast.js',
  'terminal/sessionLifecycle.js',
  'terminal/attach.js',
  'terminal/kill.js',
  // Shared tunables/helpers the terminal/* runtime modules import. These
  // define behavior the running server bakes in at boot — terminalConfig
  // (MAX_TERMINAL_SESSIONS, the SCROLLBACK_* sizes,
  // INITIAL_COMMAND_WRITE_DELAY_MS — consumed by createSession /
  // scrollbackStore / sessionLifecycle), ids (the session-id scheme used by
  // createSession), and projectPath (canonicalProjectPath / projectHash used
  // for the env breadcrumbs launchContext stamps). Omitting them let an edit
  // to a terminal tunable compute the SAME fingerprint as a still-running
  // orphan, so probeServer reused the orphan and the change silently never
  // took effect until a manual kill.
  'terminalConfig.js',
  'ids.js',
  'projectPath.js',
  'processTree.js',
  // Discovery breadcrumbs the terminal-server stamps into every pty: the
  // banner (imported by sessionLifecycle) and the generated API doc. Their
  // bytes affect runtime behavior, so a banner/doc-only edit must still
  // invalidate a stale orphan.
  'terminalBanner.js',
  'latticeApiDocs.js',
  'latticeApiDocs/LATTICE_API.template.md',
  'claudeConfigGuard.js',
  // The Claude-config WRITE mechanism the terminal-server runs at every spawn
  // (apply trust + reconcile the backend-resolved MCP set into ~/.claude.json).
  // Stable by design — the MCP/trust/memory POLICY lives in the main backend and
  // is NOT fingerprinted, so a policy change is a backend-only edit that never
  // respawns the terminal-server (the whole point of keeping these thin). These
  // ARE fingerprinted so a change to the write mechanism itself still takes
  // effect instead of running stale in a long-lived orphan. `claudeTrust.js` is
  // now a thin facade re-exporting the `claudeTrust/*` submodules that hold the
  // real logic, so all of them must be listed (the facade's bytes alone barely
  // change when the implementation does).
  'claudeTrust.js',
  'claudeTrust/apply.js',
  'claudeTrust/configFile.js',
  'claudeTrust/configLock.js',
  'claudeTrust/maintenance.js',
  'claudeTrust/util.js',
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
