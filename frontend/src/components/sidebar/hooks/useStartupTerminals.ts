import { useCallback, useEffect, useRef } from 'react';
import type { StartupTerminal } from '../../../api';
import type { TerminalSpec } from '../../../TerminalsContext';
import type { AddTerminalSpec } from '../../../terminal/terminalTypes';
import { createBackendSession, fetchLiveTerminalIds } from '../../../terminal/terminalApi';

type UseStartupTerminalsArgs = {
  activeFolder: string;
  startupTerminals: StartupTerminal[];
  projectTerminals: TerminalSpec[];
  addTerminal: (spec: AddTerminalSpec, focus?: boolean) => string;
  closeTerminals: (ids: string[]) => void;
};

// Spawn one startup terminal. Pre-created through the backend chokepoint so
// (a) a harness set as a startup command gets its MCP config and (b) the tab
// lands in the durable registry as `owner: startup`. A pre-create failure
// falls back to the serverless connect (the pane's WS attach runs the
// command), exactly the old behaviour.
async function spawnStartup(
  cfg: StartupTerminal,
  activeFolder: string,
  addTerminal: UseStartupTerminalsArgs['addTerminal'],
): Promise<void> {
  const label = cfg.label || 'startup';
  const created = await createBackendSession({
    cwd: activeFolder,
    initialCommand: cfg.command,
    projectPath: activeFolder,
    label,
    owner: 'startup',
    startupId: cfg.id,
  });
  addTerminal(
    {
      id: created?.terminalId,
      label,
      cwd: activeFolder,
      initialCommand: cfg.command,
      projectPath: activeFolder,
      kind: 'startup',
      startupId: cfg.id,
      serverId: created?.serverId,
      registered: !!created?.terminalId,
    },
    false, // don't steal focus
  );
}

export function useStartupTerminals({
  activeFolder,
  startupTerminals,
  projectTerminals,
  addTerminal,
  closeTerminals,
}: UseStartupTerminalsArgs) {
  // Mirror the latest projectTerminals into a ref so the seeding effect
  // can detect already-running startup terminals after a page refresh
  // without re-running every time the terminals list changes.
  const projectTerminalsRef = useRef(projectTerminals);
  useEffect(() => {
    projectTerminalsRef.current = projectTerminals;
  }, [projectTerminals]);

  // Synchronously-updated dedup so React StrictMode's double-fire of the
  // seeding effect can't add the same startup twice. The existing.some()
  // check below reads projectTerminalsRef, which is updated by a separate
  // effect — that effect only fires AFTER a React commit, but StrictMode
  // double-invokes effects synchronously (run → cleanup → run) BEFORE any
  // commit, so both runs see the same stale snapshot. Without this, every
  // configured startup spawns two ptys that race for the same port; with
  // `npm run dev` the second one fails with "address in use" while the
  // first invisibly holds it.
  const inFlightStartupRef = useRef<Set<string>>(new Set());

  // Drop in-flight markers once the corresponding TerminalSpec has actually
  // committed to state. Without this, closing a startup tab and then
  // changing settings would refuse to respawn (the ref still has the key).
  useEffect(() => {
    if (inFlightStartupRef.current.size === 0) return;
    const liveKeys = new Set<string>();
    for (const t of projectTerminals) {
      if (t.kind === 'startup' && t.startupId && t.projectPath) {
        liveKeys.add(`${t.projectPath}::${t.startupId}`);
      }
    }
    for (const key of inFlightStartupRef.current) {
      if (!liveKeys.has(key)) inFlightStartupRef.current.delete(key);
    }
  }, [projectTerminals]);

  // Validate persisted serverIds and auto-spawn startup terminals.
  //
  // Page reloads keep TerminalSpecs (with serverId) in sessionStorage,
  // but the backend pty for those ids may be gone — Lattice's shutdown
  // hook intentionally kills every pty so subsequent dev cycles start
  // clean. Without this check the stale spec would mount, attach, get
  // session_lost, and sit there showing the message until the user
  // closes the tab. We fetch the live session list, drop any spec
  // whose serverId no longer exists, and respawn startup terminals
  // whose backing pty is gone so the user's configured commands are
  // running by the time they look at the sidebar.
  useEffect(() => {
    if (!activeFolder) return;
    let cancelled = false;
    void (async () => {
      // null = couldn't validate (backend unreachable / non-OK). In that
      // case we skip the drop-stale step entirely instead of treating
      // every persisted serverId as dead — a transient failure shouldn't
      // wipe the user's terminals.
      const liveIds = await fetchLiveTerminalIds();
      if (cancelled) return;

      const existing = projectTerminalsRef.current;

      if (liveIds) {
        // Drop UNREGISTERED specs whose serverId is gone (legacy sessionStorage
        // tabs from before the registry). closeTerminals tolerates a 404 from
        // the DELETE; the local state is what matters here.
        //
        // A REGISTERED tab is the registry's to reconcile: after a crash or
        // reboot its recorded pty id is dead by definition, and the restore
        // pass is about to relaunch it. Closing it here would DELETE the
        // record and there would be nothing left to restore.
        const liveIdsLocal = liveIds;
        const staleIds = existing
          .filter((t) => !t.registered && t.serverId && !liveIdsLocal.has(t.serverId))
          .map((t) => t.id);
        if (staleIds.length > 0) closeTerminals(staleIds);
      }

      // Spawn each configured startup whose spec is either missing OR
      // whose serverId we just confirmed dead. When liveIds is null
      // (validation failed) we treat every existing spec as live and
      // only spawn truly missing ones, falling back to the original
      // seeding behavior.
      for (const cfg of startupTerminals) {
        if (!cfg.command.trim()) continue;
        const key = `${activeFolder}::${cfg.id}`;
        if (inFlightStartupRef.current.has(key)) continue;
        const liveSpec = existing.find(
          (t) =>
            t.kind === 'startup' &&
            t.startupId === cfg.id &&
            t.projectPath === activeFolder &&
            (!liveIds || !t.serverId || liveIds.has(t.serverId)),
        );
        if (liveSpec) continue;
        inFlightStartupRef.current.add(key);
        void spawnStartup(cfg, activeFolder, addTerminal);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeFolder, startupTerminals, addTerminal, closeTerminals]);

  // Stop and restart every startup terminal for the active project. We
  // explicitly re-add here rather than waiting for the seeding effect: the
  // effect's deps (activeFolder, startupTerminals) haven't changed, so it
  // wouldn't fire again on its own.
  const restartStartupTerminals = useCallback(() => {
    if (!activeFolder) return;
    const ids = projectTerminalsRef.current
      .filter((t) => t.kind === 'startup' && t.projectPath === activeFolder)
      .map((t) => t.id);
    if (ids.length > 0) closeTerminals(ids);
    for (const cfg of startupTerminals) {
      if (!cfg.command.trim()) continue;
      void spawnStartup(cfg, activeFolder, addTerminal);
    }
  }, [activeFolder, closeTerminals, addTerminal, startupTerminals]);

  return { restartStartupTerminals };
}
