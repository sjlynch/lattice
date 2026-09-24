// Session-scoped variables a Claude Code session exports to the commands it
// runs. When Lattice itself is started from inside one (an agent debugging
// Lattice runs `npm run dev`), the backend inherits them, the terminal-server
// inherits them from the backend, and every pty inherits them from that — so
// each Claude in a sidebar tab starts believing it is a CHILD of the outside
// session: `CLAUDE_CODE_CHILD_SESSION=1`, the outside session's id, and its
// private messaging socket + token.
//
// Only per-session identity/plumbing is dropped. User configuration that
// happens to share the prefix (`CLAUDE_CODE_USE_BEDROCK`,
// `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CONFIG_DIR`, …) is deliberately
// kept: someone who set it in their shell wants every session to see it.
//
// Scrubbed from the backend's own `process.env` at boot (`index.ts`), which is
// what every child spawns from — the terminal-server included. A
// terminal-server that is already running keeps the environment it was started
// with until it is next replaced; that is on purpose, since forcing a respawn
// would kill every running agent.
export const INHERITED_AGENT_SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
] as const;

// Returns the names removed, for the boot log.
export function scrubInheritedAgentSessionEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const name of INHERITED_AGENT_SESSION_ENV) {
    if (env[name] !== undefined) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}
