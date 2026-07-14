import type { TerminalSpec } from '../../TerminalsContext';
import { isValidPiModel } from '../../harnesses';
import type { ShellKind } from './NewTerminalDropdown';

// `codex` defaults to `--yolo` (its permission bypass, the analogue of
// claude-yolo); createTerminalSpec drops the flag when the codexYolo setting is
// off. `pi` carries `--approve` (its project-trust flag) so official Pi ≥0.74
// loads Lattice's cwd-local `.pi/extensions/` shims (MCP adapter, subagents,
// completion) + `.pi/mcp.json` at the project root — same flag the backend adds
// at every spawn site (agentCommandBuilder.ts). Per-run trust only.
const KIND_INITIAL_COMMAND: Record<ShellKind, string | undefined> = {
  claude: 'claude',
  'claude-yolo': 'claude --dangerously-skip-permissions',
  pi: 'pi --approve',
  codex: 'codex --yolo',
  terminal: undefined,
};

const KIND_LABEL_PREFIX: Record<ShellKind, string> = {
  claude: 'claude',
  'claude-yolo': 'claude!',
  pi: 'pi',
  codex: 'codex',
  terminal: 'terminal',
};

// Short label for a Pi model pattern: the model id after the provider slash,
// minus any `:thinking` suffix (e.g. "qwen-local/qwen" → "qwen").
function piModelShortLabel(piModel: string): string {
  return piModel.split('/').pop()?.split(':')[0] ?? piModel;
}

export function createTerminalSpec(
  kind: ShellKind,
  activeFolder: string,
  count: number,
  piModel?: string,
  codexYolo?: boolean,
): Omit<TerminalSpec, 'id'> {
  // A Pi terminal can carry a specific model — selection is per-spawn via the
  // `--model` flag (never Pi's global settings). Validate before it reaches the
  // shell command string (the menu source is trusted, this is defence in depth).
  const usePiModel = kind === 'pi' && isValidPiModel(piModel);
  // Codex launches with `--yolo` by default (its permission bypass); the
  // Settings toggle can drop it. Absent codexYolo counts as ON.
  const initialCommand = usePiModel
    ? `pi --approve --model "${piModel}"`
    : kind === 'codex' && codexYolo === false
      ? 'codex'
      : KIND_INITIAL_COMMAND[kind];
  const label = usePiModel
    ? `pi ${piModelShortLabel(piModel!)} ${count}`
    : `${KIND_LABEL_PREFIX[kind]} ${count}`;
  return {
    label,
    cwd: activeFolder,
    initialCommand,
    projectPath: activeFolder,
  };
}
