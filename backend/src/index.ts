// Lattice backend entry point. Installs process guards before loading the
// server bootstrap; app construction, routes, WebSockets, and startup
// recovery live under `server/`.

import { installProcessGuards } from './processGuards.js';

installProcessGuards();

const { startBackend } = await import('./server/startup.js');

startBackend().catch((err) => {
  console.error('[lattice-backend] startup error:', err);
  process.exit(1);
});
