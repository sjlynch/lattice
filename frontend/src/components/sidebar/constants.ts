import type { TerminalSpec } from '../../TerminalsContext';
import type { ShellKind } from './NewTerminalDropdown';

const KIND_INITIAL_COMMAND: Record<ShellKind, string | undefined> = {
  claude: 'claude',
  'claude-yolo': 'claude --dangerously-skip-permissions',
  pi: 'pi',
  codex: 'codex',
  terminal: undefined,
};

const KIND_LABEL_PREFIX: Record<ShellKind, string> = {
  claude: 'claude',
  'claude-yolo': 'claude!',
  pi: 'pi',
  codex: 'codex',
  terminal: 'terminal',
};

export function createTerminalSpec(
  kind: ShellKind,
  activeFolder: string,
  count: number,
): Omit<TerminalSpec, 'id'> {
  return {
    label: `${KIND_LABEL_PREFIX[kind]} ${count}`,
    cwd: activeFolder,
    initialCommand: KIND_INITIAL_COMMAND[kind],
    projectPath: activeFolder,
  };
}
