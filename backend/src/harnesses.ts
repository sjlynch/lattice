export type AgentHarness = 'claude' | 'pi' | 'codex';

export const ALL_AGENT_HARNESSES: readonly AgentHarness[] = [
  'claude',
  'pi',
  'codex',
] as const;

export function isAgentHarness(value: unknown): value is AgentHarness {
  return value === 'claude' || value === 'pi' || value === 'codex';
}

export function normalizeAgentHarness(value: unknown): AgentHarness {
  return isAgentHarness(value) ? value : 'claude';
}

// Which harness (if any) a pty's initial command launches — i.e. "is this
// terminal running an agent, or is it a plain shell / `npm run dev` startup
// terminal?". Used by `terminalActivity.ts`, where the command string is all
// we have (the session outlives the frontend spec that spawned it).
//
// Only the LEADING token is inspected: every Lattice-built agent command starts
// with the bare binary (`claude`, `pi --approve`, `codex --yolo`), and the
// per-harness rewriters (codexTrust, claudeSystemPrompt) only ever splice flags
// in AFTER it. A quoted/absolute path and a Windows `.cmd`/`.exe` shim are
// tolerated so a hand-typed launch still classifies.
export function agentHarnessForCommand(command?: string): AgentHarness | null {
  const base = leadingToken(command ?? '').split(/[\\/]/).pop() ?? '';
  const name = base.replace(/\.(cmd|bat|exe|ps1)$/i, '').toLowerCase();
  return isAgentHarness(name) ? name : null;
}

// The command's first token, unquoted. A quoted leading token is read to its
// closing quote rather than the first space, so an install path containing one
// (`"C:\Program Files\...\claude.cmd" --flag`) still yields the binary.
function leadingToken(command: string): string {
  const trimmed = command.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  return trimmed.split(/\s+/)[0] ?? '';
}
