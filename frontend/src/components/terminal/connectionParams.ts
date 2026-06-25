// Pure `/ws/terminal` query-string builder. Kept React-free (no xterm/hooks
// imports) so it stays trivially unit-testable.

export type TerminalWsQueryArgs = {
  cwd: string;
  cols: number;
  rows: number;
  serverId?: string;
  initialCommand?: string;
  projectPath?: string;
};

// Build the `/ws/terminal` query string. The serverId↔initialCommand split is
// load-bearing: with a known serverId we re-attach to the EXISTING pty by id
// (idempotent replay) and must NOT re-send initialCommand — otherwise a
// serverless→captured reconnect would spawn a SECOND pty running the same
// command. A serverless connect carries the initialCommand to create the fresh
// session.
export function buildTerminalWsQuery({
  cwd,
  cols,
  rows,
  serverId,
  initialCommand,
  projectPath,
}: TerminalWsQueryArgs): string {
  const params = new URLSearchParams({
    cwd,
    cols: String(cols),
    rows: String(rows),
  });
  if (serverId) params.set('id', serverId);
  if (!serverId && initialCommand) params.set('initialCommand', initialCommand);
  if (projectPath) params.set('projectPath', projectPath);
  return params.toString();
}
