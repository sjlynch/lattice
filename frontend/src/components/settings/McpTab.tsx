import { forwardRef, useImperativeHandle } from 'react';
import type { McpServerEntry, UserSettings } from '../../api';
import { useHarnessAvailability } from '../../hooks/useHarnessAvailability';
import { McpServerRow } from './mcp/McpServerRow';
import { McpImportSection } from './mcp/McpImportSection';
import { McpAddCustom } from './mcp/McpAddCustom';
import { PLAYWRIGHT_SERVER_ID, useMcpTabDraft } from './mcp/useMcpTabDraft';
import { hasEnv, hasSecret, secretHint } from './mcp/mcpSecretStatus';
import { removeCustomServer, upsertCustomServer } from './mcp/mcpCustomServers';

type Props = {
  active: boolean;
  open: boolean;
  activeFolder: string;
};

export type McpTabHandle = {
  // Per-project MCP enables to persist on Save (undefined if untouched, so an
  // unrelated save doesn't rewrite the file). Carries `mcpOverrides` (Claude)
  // and/or `mcpHarnessOverrides` (Codex/Pi), each only when its own toggles were
  // touched. Secrets / imports / custom-server defs persist immediately on their
  // own and are NOT part of this patch.
  getMcpUserPatch: () => Partial<UserSettings> | undefined;
};

// Servers with a one-shot validator (v1: Brave only).
const TESTABLE = new Set(['brave-search']);

// Settings → MCP tab. The single control plane: a global catalog of servers
// toggled on/off per project, with the §8 key UX, config import, and custom
// servers. All servers ship OFF — nothing here is enabled until the user opts in.
export const McpTab = forwardRef<McpTabHandle, Props>(function McpTab(
  { active, open, activeFolder },
  ref,
) {
  const {
    catalog,
    playwrightHeaded,
    latticeOnly,
    redacted,
    hints,
    envPresence,
    loaded,
    error,
    setError,
    reloadCatalog,
    reloadSecrets,
    isEnabledFor,
    toggle,
    setPlaywrightHeaded,
    setLatticeOnly,
    getPatch,
  } = useMcpTabDraft(open, activeFolder);
  const { harnessAvail } = useHarnessAvailability();

  useImperativeHandle(ref, () => ({ getMcpUserPatch: getPatch }), [getPatch]);

  const existingIds = new Set(catalog.map((s) => s.id));

  const addCustom = async (entry: McpServerEntry) => {
    await upsertCustomServer(entry);
    await reloadCatalog();
  };

  const removeCustom = async (id: string) => {
    try {
      await removeCustomServer(id);
      await reloadCatalog();
    } catch (err) {
      setError(`Could not remove "${id}": ${(err as Error).message}`);
    }
  };

  if (!active) return null;

  return (
    <div className="settings-section mcp-tab">
      <div className="settings-section-header">
        <div>
          <div className="settings-section-title">MCP servers</div>
          <div className="settings-section-sub">
            Curate MCP servers once here; Lattice injects the enabled ones into
            the <strong>Claude, Codex, and Pi</strong> sessions it launches for{' '}
            <strong>{folderName(activeFolder)}</strong> — plus a <code>claude</code>{' '}
            you start yourself at the project root. Each server has an independent
            switch per harness, so enabling it for one never loads it into
            another. Keys are stored once and shared across harnesses; every
            toggle is <em>per-project</em> and applies to <em>new</em>{' '}
            Lattice-launched sessions. Everything starts off — nothing loads until
            you turn it on.
          </div>
        </div>
      </div>

      {error && <div className="error-msg">{error}</div>}
      {!loaded && !error && <div className="settings-section-sub">Loading…</div>}

      {loaded && (
        <>
          <label className="settings-checkbox-row">
            <input
              type="checkbox"
              checked={latticeOnly}
              onChange={(e) => setLatticeOnly(e.target.checked)}
            />
            <span>Task agents get only the Lattice MCP</span>
          </label>
          <div className="settings-section-sub">
            Applies to task worktree sessions — a task's run or resume, and a
            merge-conflict resolver working in its worktree. They get just the
            Lattice task-board server (nothing, if it is off for that harness
            below), which saves a few idle server processes and their RAM per
            agent. Every other session — sidebar terminals, workflow steps,
            push, QA runs, the post-merge hook — still gets the servers enabled
            below. For Pi this only covers servers Lattice manages.
          </div>

          <div className="mcp-list">
            {catalog.map((s) => (
              <McpServerRow
                key={s.id}
                server={s}
                enabledFor={(h) => isEnabledFor(s, h)}
                onToggle={(h, next) => toggle(s, h, next)}
                harnessAvail={harnessAvail}
                playwrightHint={s.id === PLAYWRIGHT_SERVER_ID}
                headed={s.id === PLAYWRIGHT_SERVER_ID ? playwrightHeaded : undefined}
                onHeadedChange={
                  s.id === PLAYWRIGHT_SERVER_ID ? setPlaywrightHeaded : undefined
                }
                stored={hasSecret(redacted, s)}
                hint={secretHint(hints, s)}
                envPresent={hasEnv(envPresence, s)}
                onSecretChanged={reloadSecrets}
                testable={TESTABLE.has(s.id)}
                onRemove={s.builtin ? undefined : () => void removeCustom(s.id)}
              />
            ))}
          </div>

          <McpAddCustom existingIds={existingIds} onAdd={addCustom} />
          <McpImportSection activeFolder={activeFolder} onImported={reloadCatalog} />
        </>
      )}
    </div>
  );
});

// Not gitSetupDerive's `basename`: that returns '' for a root-only path ('/'),
// where this falls back to the path itself.
function folderName(folder: string): string {
  if (!folder) return 'this project';
  const parts = folder.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || folder;
}
