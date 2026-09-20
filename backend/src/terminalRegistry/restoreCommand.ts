// Build the command that relaunches a registered terminal into its previous
// conversation. Pure: file-existence facts are passed in by the caller.
//
//   claude  transcript exists → `claude <flags> --resume <id> [nudge]`
//           transcript missing → `claude <flags> --session-id <id> [prompt]`
//           (the first launch died before its first turn; `--resume` would
//           fail with "No conversation found", `--session-id` is still free)
//   pi      `pi <flags> --session-id <id> [nudge]` — create-or-resume
//   codex   id known   → `codex resume <id> <flags> [nudge]`
//           id unknown → `codex resume --last <flags> [nudge]` (cwd-filtered)
//   shell   no command: the pty just reopens in the cwd
//   other   a non-harness command (startup `npm run dev`) reruns verbatim
//
// `<flags>` are the original launch's flags with any session-binding flags
// removed and the trailing prompt argument dropped. The Codex title config
// and the harness system-prompt files are NOT here — they are re-injected by
// the spawn chokepoint like on any launch.

import { agentHarnessForCommand } from '../harnesses.js';
import {
  parseAgentCommand,
  quoteArg,
  renderCommand,
  renderToken,
  stripFlag,
  type CommandToken,
} from './commandParse.js';
import { mintAgentSessionId } from './sessionIdentity.js';
import type { AgentSessionRef, TerminalLaunch } from './types.js';

export type RestoreCommandInput = {
  launch: TerminalLaunch;
  agentSession?: AgentSessionRef;
  // Whether `~/.claude/projects/<cwd>/<id>.jsonl` exists. Only consulted for
  // Claude; the caller resolves it (interruption.ts / harnessPaths.ts).
  claudeTranscriptExists?: boolean;
  // A prompt to send as the first message of the resumed session, when the
  // caller decided the agent should pick its work back up unattended.
  nudge?: string;
};

export type RestoreCommand = {
  // `undefined` ⇒ open a plain shell in the cwd.
  command?: string;
  mode: 'resume' | 'fresh' | 'shell' | 'verbatim';
  // The agent session the relaunch targets. For a fresh Claude relaunch this
  // is the (re-used) minted id; for `codex resume --last` it is absent.
  agentSession?: AgentSessionRef;
};

const CLAUDE_STRIP: Array<[string, boolean]> = [
  ['--session-id', true], ['--resume', true], ['-r', true], ['--continue', false],
  ['-c', false], ['--fork-session', false], ['--from-pr', true],
];
const PI_STRIP: Array<[string, boolean]> = [
  ['--session-id', true], ['--session', true], ['--continue', false], ['-c', false],
  ['--resume', false], ['-r', false], ['--fork', true], ['--no-session', false],
];

function stripAll(args: CommandToken[], table: Array<[string, boolean]>): CommandToken[] {
  return table.reduce((acc, [flag, takesValue]) => stripFlag(acc, flag, takesValue), args);
}

function withNudge(command: string, nudge: string | undefined): string {
  return nudge ? `${command} ${quoteArg(nudge)}` : command;
}

export function buildRestoreCommand(input: RestoreCommandInput): RestoreCommand {
  const original = input.launch.initialCommand;
  if (!original) return { mode: 'shell' };
  const harness = agentHarnessForCommand(original);
  if (!harness) return { command: original, mode: 'verbatim' };
  const parsed = parseAgentCommand(original, harness);
  if (!parsed) return { command: original, mode: 'verbatim' };
  const bin = renderToken(parsed.binary);
  const session = input.agentSession?.harness === harness ? input.agentSession : undefined;

  if (harness === 'claude') {
    if (!session) return { command: original, mode: 'verbatim' };
    const args = renderCommand(stripAll(parsed.args, CLAUDE_STRIP));
    const flags = args ? ` ${args}` : '';
    if (input.claudeTranscriptExists) {
      return {
        command: withNudge(`${bin}${flags} --resume ${session.id}`, input.nudge),
        mode: 'resume',
        agentSession: session,
      };
    }
    // Died before the first turn: nothing to resume. Relaunch as the original
    // launch (same prompt) under the same id, which is still unused.
    const prompt = parsed.prompt ? ` ${renderToken(parsed.prompt)}` : '';
    return {
      command: `${bin}${flags} --session-id ${session.id}${prompt}`,
      mode: 'fresh',
      agentSession: session,
    };
  }

  if (harness === 'pi') {
    if (!session) return { command: original, mode: 'verbatim' };
    const args = renderCommand(stripAll(parsed.args, PI_STRIP));
    const flags = args ? ` ${args}` : '';
    return {
      command: withNudge(`${bin}${flags} --session-id ${session.id}`, input.nudge),
      mode: 'resume',
      agentSession: session,
    };
  }

  // codex — the original never carries session flags (there are none); drop
  // any stray positionals (none for Lattice-built commands) and the prompt.
  const args = renderCommand(parsed.args.filter((t) => !parsed.positionals.includes(t)));
  const flags = args ? ` ${args}` : '';
  if (session) {
    return {
      command: withNudge(`${bin} resume ${session.id}${flags}`, input.nudge),
      mode: 'resume',
      agentSession: session,
    };
  }
  return {
    command: withNudge(`${bin} resume --last${flags}`, input.nudge),
    mode: 'resume',
  };
}

// The prompt a relaunched Lattice-driven agent receives so it picks its work
// back up without anyone typing "continue" into the tab.
export const RESTORE_NUDGE =
  'Lattice restarted this session after an interruption (a crash, restart or ' +
  'reboot). Run `git status` and `git log --oneline -10` to see what is already ' +
  'committed, then continue where you left off. Do not redo committed work.';

export { mintAgentSessionId };
