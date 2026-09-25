// Cross-Site WebSocket Hijacking (CSWSH) defence — the single source of truth
// for which browser Origins may open a Lattice WebSocket. Shared by BOTH WS
// servers so neither can drift out of sync:
//   - the main backend dispatcher (`ws/wsServer.ts`, :5184), and
//   - the detached terminal-server (`terminalServer/websocket.ts`, :5185),
//     which is the process that actually owns the pty and runs `initialCommand`.
//
// Browsers always send an immutable `Origin` header on a WS handshake and
// cannot forge it from a cross-site page, so rejecting any browser-supplied
// Origin outside this allowlist closes the drive-by-RCE hole (a malicious page
// can't open /ws/terminal and run an `initialCommand`). WebSocket handshakes are
// NOT subject to same-origin policy, so this check — not CORS — is what stops a
// drive-by page talking straight to the loopback port.
//
// Non-browser clients (the node terminal relay, curl) send NO Origin header —
// those are allowed through, since they are not the CSWSH threat and the server
// is loopback-bound anyway. Both the `localhost` and `127.0.0.1` forms are
// listed because the user may load the app from either; dropping one breaks
// terminals + all live WS updates.
//
// The port is the vite dev server's: 5183, or `LATTICE_FRONTEND_PORT` for an
// isolated instance on alternate ports (the Playwright e2e webServer). The main
// backend's HTTP CORS/origin allowlist (`server/app.ts`) reads the same list.
export function allowedFrontendOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const port = Number(env.LATTICE_FRONTEND_PORT) || 5183;
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

const ALLOWED_WS_ORIGINS: ReadonlySet<string> = new Set(allowedFrontendOrigins());

export function isAllowedOrigin(origin: string | undefined): boolean {
  // Absent Origin = non-browser client (relay/curl), not the CSWSH threat.
  if (origin === undefined) return true;
  return ALLOWED_WS_ORIGINS.has(origin);
}
