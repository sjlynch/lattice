// Facade re-exporting the terminal-server core split across `terminal/`:
//   - terminal/sessionTypes.ts — Session, CreateOpts, AttachOpts types
//   - terminal/sessionStore.ts — sessions map, snapshot/list helpers
//   - terminal/createSession.ts — launch context, pty.spawn, banner,
//     initialCommand, onData/onExit wiring, precreate helper
//   - terminal/attach.ts — attachTerminal, session_lost, resize-on-attach,
//     WS message handling
//   - terminal/kill.ts — killSession, killSessionsByCwd, post-kill
//     ~/.claude.json validation
//
// terminal-server.ts imports only from here, so the public surface stays
// stable: any future re-shuffle inside terminal/* is invisible to callers.

export { attachTerminal } from './terminal/attach.js';
export { precreateSession } from './terminal/createSession.js';
export { killSession, killSessionsByCwd } from './terminal/kill.js';
export { listSessions } from './terminal/sessionStore.js';
export type { AttachOpts } from './terminal/sessionTypes.js';
