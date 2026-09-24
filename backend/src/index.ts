// Lattice backend entry point. Installs process guards before loading the
// server bootstrap; app construction, routes, WebSockets, and startup
// recovery live under `server/`.

import { installProcessGuards } from './processGuards.js';
import { scrubInheritedAgentSessionEnv } from './inheritedAgentEnv.js';

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
