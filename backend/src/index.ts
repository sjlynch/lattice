// Lattice backend entry point. Installs process guards before loading the
// server bootstrap; app construction, routes, WebSockets, and startup
// recovery live under `server/`.

import { installProcessGuards } from './processGuards.js';
import { scrubInheritedAgentSessionEnv } from './inheritedAgentEnv.js';
import { BootRefusedError, runBootGuards } from './server/bootGuards.js';
import { backendPort } from './server/config.js';

// First of all — before crash logging adopts ~/.lattice/logs, before Pi setup,
// the terminal-server handshake or startup recovery: refuse to boot from a task
// worktree, or next to a backend that already holds our port. Either would
// otherwise mutate the live instance's ~/.lattice state. See server/bootGuards.ts.
try {
  await runBootGuards({ port: backendPort() });
} catch (err) {
  if (!(err instanceof BootRefusedError)) throw err;
  console.error(`[lattice-backend] ${err.message}`);
  process.exit(1);
}

installProcessGuards();

// Before anything spawns: a backend started from inside a Claude Code session
// must not hand that session's identity to every agent it launches.
const scrubbedEnv = scrubInheritedAgentSessionEnv();
if (scrubbedEnv.length > 0) {
  console.log(`[lattice-backend] dropped inherited Claude session env: ${scrubbedEnv.join(', ')}`);
}

const { startBackend } = await import('./server/startup.js');

startBackend().catch((err) => {
  console.error('[lattice-backend] startup error:', err);
  process.exit(1);
});
