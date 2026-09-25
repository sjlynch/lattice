import { useCallback } from 'react';
import type { TerminalLaunchSettings } from '../../../api';
import type { AddTerminalSpec } from '../../../terminal/terminalTypes';
import { createBackendSession } from '../../../terminal/terminalApi';
import { createTerminalSpec } from '../constants';
import type { ShellKind } from '../NewTerminalDropdown';

type UseNewTerminalArgs = {
  activeFolder: string;
  // Only the count is read (for the new tab's `N` label), so the callback
  // doesn't churn on unrelated changes to the project's terminal list.
  projectTerminalCount: number;
  addTerminal: (spec: AddTerminalSpec, focus?: boolean) => string;
  terminalLaunchSettings: TerminalLaunchSettings;
};

function defaultShellKind(settings: TerminalLaunchSettings): ShellKind {
  if (settings.terminalDefaultHarness === 'claude') {
    return settings.terminalClaudeSkipPermissions ? 'claude-yolo' : 'claude';
  }
  return settings.terminalDefaultHarness;
}

// The sidebar's "+ new terminal" action and the dropdown's default kind.
export function useNewTerminal({
  activeFolder,
  projectTerminalCount,
  addTerminal,
  terminalLaunchSettings,
}: UseNewTerminalArgs): {
  newTerminal: (kind: ShellKind, piModel?: string) => Promise<void>;
  defaultKind: ShellKind;
} {
  const newTerminal = useCallback(
    async (kind: ShellKind, piModel?: string) => {
      const spec = createTerminalSpec(
        kind,
        activeFolder,
        projectTerminalCount + 1,
        piModel,
        terminalLaunchSettings.codexYolo,
      );
      // Every kind — harness terminals and plain shells alike — pre-creates
      // its pty via POST /api/terminals and attaches by the returned serverId.
      // For a harness (claude/pi/codex) that routes the spawn through the
      // backend chokepoint, so Codex `-c` MCP args + Pi `.pi/mcp.json` are
      // applied before the shell starts (a serverless connect bypasses that;
      // only Claude survives it, via the persistent ~/.claude.json reconcile).
      // For every kind it lands the tab in the durable registry, so it comes
      // back after a restart / reboot. Only a pre-create failure falls back to
      // the serverless connect (addTerminal's WS wiring handles it), and such a
      // tab isn't restorable.
      const created = await createBackendSession({
        cwd: spec.cwd,
        initialCommand: spec.initialCommand,
        projectPath: spec.projectPath,
        label: spec.label,
        owner: 'user',
        ...(piModel && kind === 'pi' ? { piModel } : {}),
      });
      addTerminal({
        ...spec,
        id: created?.terminalId,
        serverId: created?.serverId,
        registered: !!created?.terminalId,
      });
    },
    [addTerminal, activeFolder, projectTerminalCount, terminalLaunchSettings.codexYolo],
  );

  return { newTerminal, defaultKind: defaultShellKind(terminalLaunchSettings) };
}
