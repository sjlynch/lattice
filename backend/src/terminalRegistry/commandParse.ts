// A small shell-ish tokenizer / re-assembler for the agent launch commands
// Lattice builds (`agentCommandBuilder.ts`) and the sidebar's hand-written
// ones. Pure; used by the session-identity injector (to tell whether a command
// already names a session) and by the restore-command builder (to strip the
// trailing prompt argument and re-emit the remaining flags verbatim).
//
// Quoting model: double quotes with backslash escapes for `" \ $ \``
// (what `shellDoubleQuoted` emits), and single quotes taken literally. Good
// enough for every command Lattice itself produces; a user-typed exotic
// command that doesn't round-trip is handed back unchanged by the callers.

import { shellDoubleQuoted } from '../agentCommandBuilder.js';

export type CommandToken = {
  value: string;
  // True when the token was quoted in the source, so a re-emit preserves it
  // (a bare `foo` and a quoted `"foo"` mean the same to the shell, but a
  // quoted prompt with spaces must stay quoted).
  quoted: boolean;
};

export function tokenizeCommand(command: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let i = 0;
  const n = command.length;
  while (i < n) {
    while (i < n && /\s/.test(command[i]!)) i += 1;
    if (i >= n) break;
    let value = '';
    let quoted = false;
    while (i < n && !/\s/.test(command[i]!)) {
      const ch = command[i]!;
      if (ch === '"') {
        quoted = true;
        i += 1;
        while (i < n && command[i] !== '"') {
          if (command[i] === '\\' && i + 1 < n && /["\\$`]/.test(command[i + 1]!)) {
            value += command[i + 1];
            i += 2;
          } else {
            value += command[i];
            i += 1;
          }
        }
        i += 1; // closing quote (or end of input)
      } else if (ch === "'") {
        quoted = true;
        i += 1;
        while (i < n && command[i] !== "'") {
          value += command[i];
          i += 1;
        }
        i += 1;
      } else {
        value += ch;
        i += 1;
      }
    }
    tokens.push({ value, quoted });
  }
  return tokens;
}

// Same rule `agentCommandBuilder` quotes prompts with, so a re-emitted prompt
// is byte-identical to what the original launch carried.
export const quoteArg = shellDoubleQuoted;

export function renderToken(token: CommandToken): string {
  if (token.quoted || /[\s"'$`\\]/.test(token.value) || token.value === '') {
    return quoteArg(token.value);
  }
  return token.value;
}

export function renderCommand(tokens: CommandToken[]): string {
  return tokens.map(renderToken).join(' ');
}

// Flags that consume the NEXT token as their value, per harness. Only the
// ones Lattice itself emits or a user is likely to type; an unknown flag with
// a value that doesn't start with `-` is mis-read as a positional, which only
// matters if it is the LAST positional (mistaken for the prompt). Keep this
// table honest when a new flag is added to agentCommandBuilder.
const VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  claude: new Set([
    '--model', '--session-id', '--resume', '-r', '--fallback-model',
    '--permission-mode', '--append-system-prompt', '--append-system-prompt-file',
    '--system-prompt', '--system-prompt-file', '--mcp-config', '--add-dir',
    '--settings', '--plugin-dir', '-n', '--name', '--output-format',
    '--input-format', '--max-turns', '--agent', '--system-prompt-snapshot',
    '--allowedTools', '--disallowedTools', '--allowed-tools', '--disallowed-tools',
    '--from-pr', '--betas',
  ]),
  pi: new Set([
    '--model', '--session-id', '--session', '--fork', '--session-dir', '-n',
    '--name', '--models', '--thinking', '--provider', '--api-key', '--export',
    '--mode', '-e', '--extension', '--append-system-prompt', '--system-prompt',
    '--tools', '--skill', '--prompt-template',
  ]),
  codex: new Set([
    '-c', '--config', '-m', '--model', '-C', '--cd', '-p', '--profile', '-s',
    '--sandbox', '-a', '--ask-for-approval', '-i', '--image', '--add-dir',
    '--enable', '--disable', '--remote', '--remote-auth-token-env',
    '--local-provider', '--thread-source', '-o', '--output-last-message',
  ]),
};

export type ParsedAgentCommand = {
  binary: CommandToken;
  // Every token after the binary EXCEPT the trailing prompt positional, in
  // source order (flags and their values interleaved as written).
  args: CommandToken[];
  // The last bare positional argument, if any — for every Lattice-built
  // command this is the prompt.
  prompt?: CommandToken;
  // Positional arguments before the prompt (e.g. a Codex `resume` subcommand
  // and its session id). Empty for every Lattice-built launch command.
  positionals: CommandToken[];
};

// Split an agent command into binary / flags / trailing prompt. `harness`
// selects the value-flag table; a null harness (plain shell command) treats
// every non-flag token as positional.
export function parseAgentCommand(
  command: string,
  harness: 'claude' | 'pi' | 'codex' | null,
): ParsedAgentCommand | null {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) return null;
  const valueFlags = harness ? VALUE_FLAGS[harness]! : new Set<string>();
  const [binary, ...rest] = tokens;
  const positionalIdx: number[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i]!;
    if (!t.quoted && t.value.startsWith('-')) {
      // `--flag=value` carries its value inline; a bare value-flag eats the
      // next token.
      if (!t.value.includes('=') && valueFlags.has(t.value)) i += 1;
      continue;
    }
    positionalIdx.push(i);
  }
  const promptIdx = positionalIdx.length > 0 ? positionalIdx[positionalIdx.length - 1]! : -1;
  const prompt = promptIdx >= 0 ? rest[promptIdx] : undefined;
  const args = rest.filter((_, i) => i !== promptIdx);
  const positionals = positionalIdx
    .filter((i) => i !== promptIdx)
    .map((i) => rest[i]!);
  return { binary: binary!, args, prompt, positionals };
}

// Does the command carry any of `flags` (as a bare token or `--flag=value`)?
export function commandHasFlag(command: string, flags: readonly string[]): boolean {
  const set = new Set(flags);
  for (const t of tokenizeCommand(command)) {
    if (t.quoted) continue;
    if (set.has(t.value)) return true;
    const eq = t.value.indexOf('=');
    if (eq > 0 && set.has(t.value.slice(0, eq))) return true;
  }
  return false;
}

// Remove `flag` (and its value, when it takes one) wherever it appears.
export function stripFlag(
  args: CommandToken[],
  flag: string,
  takesValue: boolean,
): CommandToken[] {
  const out: CommandToken[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i]!;
    if (!t.quoted && (t.value === flag || t.value.startsWith(`${flag}=`))) {
      if (takesValue && t.value === flag) i += 1;
      continue;
    }
    out.push(t);
  }
  return out;
}
